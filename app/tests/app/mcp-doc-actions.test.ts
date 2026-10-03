import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { Doc, DocVersionSummary, MaterialVersion, Page, ProjectExport } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

type Scene = Awaited<ReturnType<typeof actionScene>>;
const versions = async (docId: string) => (await pool.query('SELECT count(*)::int AS n FROM project_material_versions WHERE material_id=$1', [docId])).rows[0].n as number;
const docEvents = async (docId: string) => (await pool.query(
  "SELECT count(*)::int AS n FROM events WHERE kind IN ('project.doc_created.v1', 'project.doc_updated.v1') AND data->>'docId' = $1", [docId])).rows[0].n as number;
const docs = async (projectId: string) => (await pool.query("SELECT count(*)::int AS n FROM project_materials WHERE project_id=$1 AND kind='doc'", [projectId])).rows[0].n as number;
const base = (f: Scene, grantId: string, peerRequestClass: 'execute' | 'plan', clientCommandId: string = randomUUID()) => ({ projectId: f.projectId,
  runtimeSessionId: f.runtimeSessionId, grantId, clientCommandId, peerRequestClass, sources: [] as { materialId: string; version: number }[] });
const getDoc = async (f: Scene, docId: string) => expect(await f.owner.request('GET', `/api/v1/docs/${docId}`), 200) as unknown as Doc;

test('standing doc grants start and edit a project doc as the agent at the read version: one version, event and debit per command', async () => {
  const f = await actionScene(pool);
  const capabilities = f.bootstrap.capabilities as { name: string; operation: string | null; classes: string[]; available: boolean }[];
  assert.deepEqual(capabilities.filter((item) => item.operation?.startsWith('doc.')).map(({ name, operation, classes, available }) => ({ name, operation, classes, available })),
    [{ name: 'flux_create_doc', operation: 'doc.create', classes: ['execute', 'plan'], available: true },
      { name: 'flux_update_doc', operation: 'doc.update', classes: ['execute', 'plan'], available: true }]);
  const create = await f.grant('doc.create', 'plan');
  const update = await f.grant('doc.update', 'execute');
  const first = randomUUID();
  const started = { ...base(f, create.id, 'plan', first), sources: [f.source],
    doc: { title: 'Battery notes', body: 'Measured **four hours** against [the plan](flux:doc/00000000-0000-4000-8000-000000000000).' } };
  const created = toolValue(await f.tool('flux_create_doc', started));
  const docId = String(created.docId);
  assert.deepEqual([created.version, created.state, created.replayed], [1, 'draft', false]);
  let doc = await getDoc(f, docId);
  assert.deepEqual([doc.title, doc.state, doc.version, doc.audience], ['Battery notes', 'draft', 1, { kind: 'project', projectId: f.projectId }]);
  assert.deepEqual([doc.author, doc.createdBy], [{ kind: 'agent', id: f.agentId, name: 'Planning agent' }, { kind: 'agent', id: f.agentId, name: 'Planning agent' }],
    'the agent is the real author, never a person account');
  assert.ok(doc.html.includes('<strong>four hours</strong>'));
  assert.deepEqual(doc.mentions.map((item) => item.path), [null], 'a reference outside the project resolves to nothing');
  assert.deepEqual([await versions(docId), await docEvents(docId), await f.used(create.id)], [1, 1, 1]);

  // A lost response is retried with the same command ID: the stored outcome, no second doc, version, event or debit.
  assert.deepEqual(toolValue(await f.tool('flux_create_doc', started)), { ...created, replayed: true });
  assert.deepEqual([await docs(f.projectId), await versions(docId), await docEvents(docId), await f.used(create.id)], [1, 1, 1, 1]);
  assert.equal(toolFailure(await f.tool('flux_create_doc', { ...started, doc: { title: 'Other notes' } })).code, 'IDEMPOTENCY_CONFLICT');

  // An edit at the read version, like If-Match: the next immutable version, written by the agent.
  const edit = randomUUID();
  const published = { ...base(f, update.id, 'execute', edit), docId, expectedVersion: 1,
    changes: { body: 'Measured four hours, twice.', state: 'published', reason: 'Second measurement' } };
  const edited = toolValue(await f.tool('flux_update_doc', published));
  assert.deepEqual([edited.version, edited.state, edited.replayed], [2, 'published', false]);
  doc = await getDoc(f, docId);
  assert.deepEqual([doc.version, doc.state, doc.reason, doc.author.kind, doc.author.id], [2, 'published', 'Second measurement', 'agent', f.agentId]);
  const history = expect(await f.owner.request('GET', `/api/v1/docs/${docId}/versions`), 200) as unknown as Page<DocVersionSummary>;
  assert.deepEqual(history.items.map((item) => [item.version, item.author.kind, item.author.id]), [[2, 'agent', f.agentId], [1, 'agent', f.agentId]]);
  assert.deepEqual([await versions(docId), await docEvents(docId), await f.used(update.id)], [2, 2, 1]);

  // A stale version is refused before any effect, with nothing debited; a no-op edit saves nothing and uses nothing.
  assert.equal(toolFailure(await f.tool('flux_update_doc', { ...published, clientCommandId: randomUUID(), changes: { body: 'Stale' } })).code, 'VERSION_CONFLICT');
  assert.equal(toolFailure(await f.tool('flux_update_doc', { ...published, clientCommandId: randomUUID(), expectedVersion: 2,
    changes: { title: 'Battery notes' } })).code, 'DOC_UNCHANGED');
  assert.deepEqual([await versions(docId), await docEvents(docId), await f.used(update.id)], [2, 2, 1]);

  // Every existing reader names the real actor: the material citation reader, search and the project export.
  const cited = expect(await f.owner.request('GET', `/api/v1/materials/${docId}/versions/2`), 200) as unknown as MaterialVersion;
  assert.deepEqual([cited.authorId, cited.author], [null, { kind: 'agent', id: f.agentId, name: 'Planning agent' }]);
  const indexed = (await pool.query('SELECT author_kind, author_id FROM search_documents WHERE doc_key=$1', [`material:${docId}:2`])).rows[0];
  assert.deepEqual(indexed, { author_kind: 'agent', author_id: f.agentId });
  const exported = expect(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/export?format=json`), 200) as unknown as ProjectExport;
  const exportedDoc = exported.docs.find((item) => item.id === docId)!;
  assert.deepEqual([exportedDoc.createdBy, ...exportedDoc.versions.map((item) => item.author)],
    [{ kind: 'agent', id: f.agentId }, { kind: 'agent', id: f.agentId }, { kind: 'agent', id: f.agentId }]);

  // A person's later edit makes the stored outcome no longer current: a late replay is visibly stale, never a second effect.
  expect(await f.owner.request('PATCH', `/api/v1/docs/${docId}`, { body: { body: 'Edited by a person' }, headers: { 'if-match': '"2"' } }), 200);
  assert.equal(toolFailure(await f.tool('flux_update_doc', published)).code, 'COMMAND_POSTSTATE_STALE');
  assert.deepEqual([await versions(docId), await f.used(update.id)], [3, 1]);
  assert.equal((await getDoc(f, docId)).author.kind, 'human');

  // Revocation stops new edits and replays alike: a replay revalidates current authority before returning anything.
  const again = randomUUID();
  const latest = { ...base(f, update.id, 'execute', again), docId, expectedVersion: 3, changes: { body: 'Agent follow-up' } };
  const followed = toolValue(await f.tool('flux_update_doc', latest));
  assert.equal(followed.version, 4);
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}/action-grants/${update.id}`), 204);
  assert.equal(toolFailure(await f.tool('flux_update_doc', latest)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await f.tool('flux_update_doc', { ...latest, clientCommandId: randomUUID(), expectedVersion: 4 })).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.deepEqual([await versions(docId), await f.used(update.id)], [4, 2]);
});

test('doc actions never reach a private draft, a guessed or other project doc, another doc than a targeted grant names, or an expired or revoked authority', async () => {
  const f = await actionScene(pool);
  const anyDoc = await f.grant('doc.update', 'plan', 10);
  const create = await f.grant('doc.create', 'plan', 10);
  const docA = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, { body: { title: 'Wiring', state: 'published' } }), 201) as unknown as Doc;
  const docB = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, { body: { title: 'Housing' } }), 201) as unknown as Doc;
  const draft = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/drafts`, { body: { title: 'Private plan' } }), 201);
  const elsewhere = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`,
    { body: { name: 'Unselected project', visibility: 'restricted' } }), 201);
  const otherDoc = expect(await f.owner.request('POST', `/api/v1/projects/${elsewhere.id}/docs`, { body: { title: 'Elsewhere' } }), 201) as unknown as Doc;
  const edit = (grantId: string, docId: unknown, changes: Record<string, unknown> = { body: 'Agent text' }) => f.tool('flux_update_doc',
    { ...base(f, grantId, 'plan'), docId, expectedVersion: 1, changes });

  // A private draft, a guessed ID and another project's doc are all just "not a project object": nothing leaks or changes.
  for (const target of [draft.id, randomUUID(), otherDoc.id]) assert.equal(toolFailure(await edit(anyDoc.id, target)).code, 'OBJECT_NOT_FOUND');
  // A private draft cannot be a cited source either, and another project is outside the connection's selection.
  assert.equal(toolFailure(await f.tool('flux_create_doc', { ...base(f, create.id, 'plan'), sources: [{ materialId: draft.id, version: 1 }],
    doc: { title: 'From a draft' } })).code, 'SOURCE_VERSION_CONFLICT');
  assert.equal(toolFailure(await f.tool('flux_create_doc', { ...base(f, create.id, 'plan'), projectId: elsewhere.id, doc: { title: 'Elsewhere' } })).code,
    'PROJECT_NOT_FOUND');

  // A targeted grant authorizes only its doc; a grant for another operation or class authorizes nothing here.
  const onlyA = await f.grant('doc.update', 'plan', 10, docA.id);
  assert.equal(toolFailure(await edit(onlyA.id, docB.id)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await edit(create.id, docA.id)).code, 'AGENT_EXECUTION_UNAVAILABLE', 'a doc.create grant cannot edit');
  assert.equal(toolFailure(await f.tool('flux_update_doc', { ...base(f, anyDoc.id, 'execute'), docId: docA.id, expectedVersion: 1,
    changes: { body: 'Wrong class' } })).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolValue(await edit(onlyA.id, docA.id)).version, 2);

  // An expired grant and a revoked connection refuse before any effect.
  await pool.query("UPDATE agent_standing_grants SET expires_at = now() - interval '1 second' WHERE id=$1", [anyDoc.id]);
  assert.equal(toolFailure(await edit(anyDoc.id, docB.id)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  const drafted = (await pool.query('SELECT count(*)::int AS n FROM draft_versions WHERE draft_id=$1', [draft.id])).rows[0].n as number;
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}`), 204);
  const revoked = await f.raw('flux_create_doc', { ...base(f, create.id, 'plan'), doc: { title: 'After revocation' } });
  assert.equal(revoked.status, 403);

  assert.deepEqual([await f.used(anyDoc.id), await f.used(create.id), await f.used(onlyA.id)], [0, 0, 1], 'only the one effect is debited');
  assert.deepEqual([await versions(docA.id), await versions(docB.id), await versions(otherDoc.id), await docs(f.projectId)], [2, 1, 1, 2]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM draft_versions WHERE draft_id=$1', [draft.id])).rows[0].n, drafted);
  assert.equal((await getDoc(f, docB.id)).author.kind, 'human');
});

test('a doc action refuses when its agent is only a viewer of the project now, with no version, event or debit', async () => {
  const f = await actionScene(pool);
  const create = await f.grant('doc.create', 'plan');
  const update = await f.grant('doc.update', 'execute');
  const created = toolValue(await f.tool('flux_create_doc', { ...base(f, create.id, 'plan'), doc: { title: 'Wiring notes', body: 'First pass.' } }));
  const docId = String(created.docId);
  // The owner narrows the agent to read-only: the standing grant no longer carries write authority.
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/grants`,
    { body: { principal: { kind: 'agent', id: f.agentId }, role: 'viewer' } }), 201);
  // A connection with write scopes needs write access to every selected project, so the MCP request
  // itself is refused before any tool runs, as for a revoked connection.
  const refused = await f.raw('flux_update_doc', { ...base(f, update.id, 'execute'), docId, expectedVersion: 1,
    changes: { body: 'Second pass.' } });
  assert.equal(refused.status, 403);
  assert.deepEqual([await versions(docId), await docEvents(docId), await f.used(update.id)], [1, 1, 0]);
  assert.equal((await getDoc(f, docId)).version, 1);
});
