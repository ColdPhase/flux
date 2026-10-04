import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDocUseCases, DomainError } from '@flux/core';
import type { Doc, MaterialVersion, Page, DocVersionSummary, WorkResult } from '@flux/contracts';
import { prepareDocWrite } from '../../apps/server/src/docs/preparation.js';
import { docUnitOfWork, docUseCases } from '../../apps/server/src/docs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';
import { expect } from './support/mcp.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';

// Real PostgreSQL/native/MCP adapter coverage. The explicitly installed test head
// isolates the native writer/snapshot boundary; it does not prove codec admission.
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (value: unknown) => (value as { code?: string }).code;
const refusal = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
async function scene() {
  const owner = await person('live-doc-owner'); const partner = await person('live-doc-partner');
  const ws = await workspace(owner, 'Shared writing'); await addMember(owner, ws.id, partner, 'member');
  const place = await project(owner, ws.id, 'Writing project', 'restricted'); await grant(owner, place.id, partner, 'contributor');
  const create = async (title: string, body: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title, body } }), 201) as Doc;
  const doc = await create('Working contract', 'Saved statement.');
  return { owner, partner, ws, place, create, doc };
}
async function installHead(doc: Doc, body: string, sequence = 0) {
  const generation = randomUUID(); const codecState = { fixture: 'native-fence-only', checkpoint: 'retained-checkpoint' };
  await pool.query(`INSERT INTO doc_live_heads (doc_id,workspace_id,project_id,generation,sequence,body,hash,saved_version,saved_sequence,codec_state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9)`, [doc.id, doc.workspaceId, doc.projectId, generation, sequence, body, hash(body), doc.version, codecState]);
  return { generation, headSequence: sequence, headHash: hash(body), codecState };
}
async function unchangedState(docId: string) {
  return {
    material: (await pool.query('SELECT * FROM project_materials WHERE id=$1', [docId])).rows,
    versions: (await pool.query('SELECT * FROM project_material_versions WHERE material_id=$1 ORDER BY version', [docId])).rows,
    links: (await pool.query("SELECT * FROM project_object_links WHERE from_id=$1 AND from_type='doc' ORDER BY id", [docId])).rows,
    head: (await pool.query('SELECT * FROM doc_live_heads WHERE doc_id=$1', [docId])).rows,
    snapshots: (await pool.query('SELECT * FROM doc_live_snapshots WHERE doc_id=$1 ORDER BY version', [docId])).rows,
    events: (await pool.query("SELECT seq,kind,data FROM events WHERE data->>'docId'=$1 ORDER BY seq", [docId])).rows,
  };
}

test('dirty shared text fences HTTP body, no-op, metadata and section writers before native mutations', async () => {
  const f = await scene(); const target = await f.create('Cited only by unsaved text', 'Target body.');
  await installHead(f.doc, `Saved statement.\n[Concurrent work](flux:doc/${target.id})`, 1);
  const finding = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/results`,
    { body: { title: 'Found together', finding: 'positive' } }), 201) as WorkResult;
  const before = await unchangedState(f.doc.id);
  for (const change of [{ body: 'External replacement' }, { body: f.doc.body }, { title: f.doc.title }, { title: 'External title' }, { state: 'published' }]) {
    const response = await f.owner.browser.request('PATCH', `/api/v1/docs/${f.doc.id}`, { body: change, headers: { 'if-match': '"1"' } });
    assert.equal(response.status, 409); assert.equal(code(response.json), 'DOC_LIVE_WORKING_COPY_CHANGED');
  }
  const section = await f.owner.browser.request('POST', `/api/v1/docs/${f.doc.id}/sections`,
    { body: { from: { type: 'result', id: finding.id } }, headers: { 'if-match': '"1"' } });
  assert.equal(section.status, 409); assert.equal(code(section.json), 'DOC_LIVE_WORKING_COPY_CHANGED');
  assert.deepEqual(await unchangedState(f.doc.id), before, 'no source link, mention, version, event or shared state changed');
  const current = expectStatus(await f.partner.browser.request('GET', `/api/v1/docs/${f.doc.id}`), 200) as Doc;
  const cited = expectStatus(await f.partner.browser.request('GET', `/api/v1/materials/${f.doc.id}/versions/1`), 200) as MaterialVersion;
  assert.equal(current.body, f.doc.body); assert.equal(cited.body, f.doc.body); assert.deepEqual(current.mentions, []);
  const search = (await pool.query('SELECT body FROM search_documents WHERE doc_key=$1', [`material:${f.doc.id}:1`])).rows;
  assert.deepEqual(search, [{ body: f.doc.body }], 'saved search projection never reads the live body');
});

test('shared Save snapshots exactly the locked head, names contributors and preserves generation/codec/history', async () => {
  const f = await scene(); const target = await f.create('Linked after Save', 'Target.');
  const body = `Together: Ada and Jon.\n[Source](flux:doc/${target.id})`;
  const h = await installHead(f.doc, body, 3);
  for (const [sequence, author] of [[1, f.owner.id], [2, f.partner.id], [3, f.partner.id]] as const) {
    await pool.query(`INSERT INTO doc_live_updates (doc_id,generation,sequence,actor_id,command_id,fingerprint,bytes)
      VALUES ($1,$2,$3,$4,$5,$6,'Zml4dHVyZQ==')`, [f.doc.id, h.generation, sequence, author, randomUUID(), 'a'.repeat(64)]);
  }
  const docs = docUseCases(db); const actor = { kind: 'human' as const, id: f.owner.id };
  await assert.rejects(docs.saveLiveVersion(actor, f.doc.id, { ...h, headSequence: 2 }, 1), refusal('DOC_LIVE_HEAD_CHANGED'));
  const saved = await docs.saveLiveVersion(actor, f.doc.id, { ...h, reason: 'Joint review' }, 1);
  assert.equal(saved.body, body); assert.equal(saved.version, 2); assert.equal(saved.author.id, f.owner.id);
  assert.deepEqual(new Set(saved.contributors?.map((by) => by.id)), new Set([f.owner.id, f.partner.id]));
  assert.ok(saved.contributors?.every((by) => by.kind === 'human' && by.name));
  assert.deepEqual(saved.liveSnapshot, { generation: h.generation, fromSequence: 0, toSequence: 3 });
  const [head] = (await pool.query('SELECT * FROM doc_live_heads WHERE doc_id=$1', [f.doc.id])).rows;
  assert.deepEqual([head.generation, Number(head.sequence), head.body, head.codec_state, head.saved_version, Number(head.saved_sequence)], [h.generation, 3, body, h.codecState, 2, 3]);
  const old = await docs.getVersion(actor, f.doc.id, 1); assert.equal(old.body, f.doc.body); assert.equal(old.contributors, undefined);
  const history = expectStatus(await f.partner.browser.request('GET', `/api/v1/docs/${f.doc.id}/versions`), 200) as Page<DocVersionSummary>;
  assert.deepEqual(history.items[0]?.contributors, saved.contributors);
  const unchanged = await unchangedState(f.doc.id);
  assert.equal((await docs.saveLiveVersion(actor, f.doc.id, h, 2)).version, 2, 'no-op Save produces no extra version');
  assert.deepEqual(await unchangedState(f.doc.id), unchanged);
  assert.equal(saved.mentions[0]?.path, `/projects/${f.place.id}/docs/${target.id}`, 'saved mentions resolve only in the snapshot transaction');
});

test('a definite transaction failure after snapshot/mention preparation rolls every native effect back', async () => {
  const f = await scene(); const target = await f.create('Rollback target', 'Target.');
  const h = await installHead(f.doc, `Joint text [target](flux:doc/${target.id})`, 1);
  const before = await unchangedState(f.doc.id); const preparation = await prepareDocWrite({docId:f.doc.id,command:h}); const uow = docUnitOfWork(db, preparation.memory);
  const docs = createDocUseCases({ run: (action) => uow.run((ports) => action({ ...ports,
    events: { record: async () => { throw new Error('controlled pre-COMMIT failure'); } } })) });
  try { await assert.rejects(docs.saveLiveVersion({ kind: 'human', id: f.owner.id }, f.doc.id, h, 1), /controlled pre-COMMIT failure/); }
  finally { preparation.release(); }
  assert.deepEqual(await unchangedState(f.doc.id), before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM doc_live_archives WHERE doc_id=$1', [f.doc.id])).rows[0].n, 0);
});

test('a clean legacy CAS change atomically retires its live generation and retains old receipts/ownership', async () => {
  const f = await scene(); const h = await installHead(f.doc, f.doc.body, 4);
  const replica = 73; const instance = randomUUID(); const command = randomUUID();
  await pool.query(`INSERT INTO doc_live_replicas (doc_id,generation,replica_id,actor_id,instance_id,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`, [f.doc.id, h.generation, replica, f.partner.id, instance]);
  await pool.query(`INSERT INTO live_editing_intents (actor_id,command_id,workspace_id,kind,resource_id,generation,operation,fingerprint,byte_length,receipt)
    VALUES ($1,$2,$3,'wiki',$4,$5,'text',$6,1,$7)`, [f.partner.id, command, f.ws.id, f.doc.id, h.generation, 'b'.repeat(64), { sequence: 4 }]);
  const ownership = (await pool.query('SELECT * FROM doc_live_replicas WHERE doc_id=$1', [f.doc.id])).rows;
  const receipts = (await pool.query('SELECT * FROM live_editing_intents WHERE actor_id=$1 AND command_id=$2', [f.partner.id, command])).rows;
  const same = expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${f.doc.id}`, { body: { title: f.doc.title }, headers: { 'if-match': '"1"' } }), 200) as Doc;
  assert.equal(same.version, 1);
  const saved = expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${f.doc.id}`, { body: { body: 'Explicit native replacement.' }, headers: { 'if-match': '"1"' } }), 200) as Doc;
  assert.equal(saved.version, 2);
  const [head] = (await pool.query('SELECT * FROM doc_live_heads WHERE doc_id=$1', [f.doc.id])).rows;
  assert.notEqual(head.generation, h.generation); assert.deepEqual([head.body, Number(head.sequence), head.saved_version, Number(head.saved_sequence), head.codec_state], [saved.body, 0, 2, 0, null]);
  const [archive] = (await pool.query('SELECT * FROM doc_live_archives WHERE doc_id=$1', [f.doc.id])).rows;
  assert.deepEqual([archive.generation, archive.body, Number(archive.sequence), archive.codec_state], [h.generation, f.doc.body, 4, h.codecState]);
  assert.deepEqual((await pool.query('SELECT * FROM doc_live_replicas WHERE doc_id=$1', [f.doc.id])).rows, ownership);
  assert.deepEqual((await pool.query('SELECT * FROM live_editing_intents WHERE actor_id=$1 AND command_id=$2', [f.partner.id, command])).rows, receipts);
});

test('the real OAuth/MCP standing-grant doc adapter obeys the same dirty fence before no-op or debit', async () => {
  const f = await actionScene(pool);
  const doc = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, { body: { title: 'People working', body: 'Saved.' } }), 201) as unknown as Doc;
  await installHead(doc, 'Saved. People typing together.', 1); const standing = await f.grant('doc.update', 'plan');
  const before = await unchangedState(doc.id);
  for (const changes of [{ body: 'Agent replacement.' }, { title: doc.title }, { state: 'published' }]) {
    const result = await f.tool('flux_update_doc', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
      grantId: standing.id, clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [], docId: doc.id, expectedVersion: 1, changes });
    assert.equal(toolFailure(result).code, 'DOC_LIVE_WORKING_COPY_CHANGED');
  }
  assert.equal(await f.used(standing.id), 0); assert.deepEqual(await unchangedState(doc.id), before);
});
