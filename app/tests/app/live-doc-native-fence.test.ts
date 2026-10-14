import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDocUseCases, DomainError } from '@flux/core';
import type { Doc, MaterialVersion, Page, DocVersionSummary, WorkResult, WorkItem } from '@flux/contracts';
import { docPorts, docUnitOfWork, docUseCases } from '../../apps/server/src/docs/adapters.js';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { withTaskUseErrors } from '../../apps/server/src/work/task-use-errors.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';

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

async function taskUseScene() {
  const f = await actionScene(pool);
  const createGrant = await f.grant('work.create', 'execute');
  const created = toolValue(await f.tool('flux_create_task', {
    projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: createGrant.id,
    clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Live snapshot target' },
  }));
  const item = await f.read(String(created.workId)) as unknown as WorkItem;
  const ownerId = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const doc = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, {
    body: { title: 'Live task reference', body: 'Saved without the task.' },
  }), 201) as unknown as Doc;
  const actor = { kind: 'human' as const, id: ownerId };
  const undo = (clientCommandId = randomUUID()) => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`, {
    body: { clientCommandId, expectedVersion: item.version },
  });
  return { f, item, doc, actor, undo };
}

const taskBody = (id: string) => `A live snapshot refers to [the task](flux:work/${id}).`;
const referencedHead = async (doc: Doc, item: WorkItem) => installHead(doc, taskBody(item.id), 1);
const bounded = async <T>(pending: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
  })]); } finally { if (timer) clearTimeout(timer); }
};

function heldDocUseCases(held: ReturnType<typeof barrier<number>>, release: ReturnType<typeof barrier>) {
  return createDocUseCases({ run: (action) => withTaskUseErrors(() => db.transaction(async (tx) => {
    const ports = docPorts(tx);
    return action({ ...ports, events: { record: async (...args) => {
      await ports.events.record(...args);
      held.resolve(await backendPid(tx));
      await bounded(release.promise, 'live Save pre-commit release');
    } } });
  })) });
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
  const before = await unchangedState(f.doc.id); const uow = docUnitOfWork(db);
  const docs = createDocUseCases({ run: (action) => uow.run((ports) => action({ ...ports,
    events: { record: async () => { throw new Error('controlled pre-COMMIT failure'); } } })) });
  await assert.rejects(docs.saveLiveVersion({ kind: 'human', id: f.owner.id }, f.doc.id, h, 1), /controlled pre-COMMIT failure/);
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

test('a live Save first use latches monotonically after the mention is removed, so task Undo stays refused', async () => {
  const { f, item, doc, actor, undo } = await taskUseScene();
  const head = await referencedHead(doc, item);
  const saved = await docUseCases(db).saveLiveVersion(actor, doc.id, head, 1);
  assert.equal(saved.version, 2); assert.equal(saved.body, taskBody(item.id));
  const [used] = (await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows;
  assert.ok(used.first_persisted_use_at, 'the successful saved snapshot records first persisted use');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_object_links WHERE from_id=$1 AND role='mentions' AND to_id=$2", [doc.id, item.id])).rows[0].n, 1);

  const removed = expect(await f.owner.request('PATCH', `/api/v1/docs/${doc.id}`, {
    body: { body: 'The saved reference was later removed.' }, headers: { 'if-match': '"2"' },
  }), 200);
  assert.equal(removed.version, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_object_links WHERE from_id=$1 AND role='mentions' AND to_id=$2", [doc.id, item.id])).rows[0].n, 0);
  assert.ok((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0].first_persisted_use_at,
    'removing the mention cannot roll back the task-use latch');
  const refused = await undo();
  assert.equal(refused.status, 409);
  assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.reason, 'task_used');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [item.id])).rows[0].n, 0);
});

test('a live snapshot that targets an already creation-reverted task refuses without partial doc state', async () => {
  const { f, item, doc, actor, undo } = await taskUseScene();
  assert.equal((await undo()).status, 200);
  const head = await referencedHead(doc, item);
  const before = await unchangedState(doc.id);
  await assert.rejects(docUseCases(db).saveLiveVersion(actor, doc.id, head, 1), refusal('TASK_CREATION_REVERTED'));
  assert.deepEqual(await unchangedState(doc.id), before, 'refusal leaves material, versions, links, head, snapshot and events unchanged');
  assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0].first_persisted_use_at, null);
  assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.reason, 'already_reverted');
});

test('live Save and task creation Undo serialize on first-use: exactly one transaction commits', { timeout: 30_000 }, async () => {
  const { f, item, doc, actor, undo } = await taskUseScene();
  const head = await referencedHead(doc, item);
  const saveHeld = barrier<number>(); const releaseSave = barrier();
  const saving = heldDocUseCases(saveHeld, releaseSave).saveLiveVersion(actor, doc.id, head, 1);
  void saving.catch(() => undefined);
  let undoing: ReturnType<typeof undo> | undefined;
  try {
    const pid = await bounded(saveHeld.promise, 'live Save after persisted snapshot/event work');
    undoing = undo(); void undoing.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid);
    releaseSave.resolve();
    const saved = await bounded(saving, 'live Save commit');
    assert.equal(saved.version, 2); assert.equal(saved.body, taskBody(item.id));
    assert.equal((await bounded(undoing, 'Undo refusal')).status, 409);
    assert.ok((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0].first_persisted_use_at);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [item.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_material_versions WHERE material_id=$1', [doc.id])).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM doc_live_snapshots WHERE doc_id=$1', [doc.id])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_object_links WHERE from_id=$1 AND role='mentions' AND to_id=$2", [doc.id, item.id])).rows[0].n, 1);
  } finally {
    releaseSave.resolve();
    await bounded(Promise.all([saving.catch(() => undefined), undoing?.catch(() => undefined)]), 'live Save/Undo race cleanup');
  }

  const losingUndo = await taskUseScene();
  const losingHead = await referencedHead(losingUndo.doc, losingUndo.item);
  const undoHeld = barrier<number>(); const releaseUndo = barrier();
  const undoingFirst = db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    const outcome = await native.undoTaskCreation({ kind: 'human', id: losingUndo.actor.id }, losingUndo.item.id,
      { clientCommandId: randomUUID(), expectedVersion: losingUndo.item.version });
    undoHeld.resolve(await backendPid(tx)); await bounded(releaseUndo.promise, 'Undo pre-commit release');
    await native.flushEvents(); return outcome;
  });
  void undoingFirst.catch(() => undefined);
  let losingSave: Promise<Doc> | undefined;
  try {
    const pid = await bounded(undoHeld.promise, 'Undo with task fence held');
    const before = await unchangedState(losingUndo.doc.id);
    losingSave = docUseCases(db).saveLiveVersion(losingUndo.actor, losingUndo.doc.id, losingHead, 1);
    void losingSave.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid);
    releaseUndo.resolve();
    await bounded(undoingFirst, 'Undo commit');
    await assert.rejects(bounded(losingSave, 'live Save refusal'), refusal('TASK_CREATION_REVERTED'));
    assert.deepEqual(await unchangedState(losingUndo.doc.id), before, 'the losing snapshot transaction leaves no partial document side effects');
    assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [losingUndo.item.id])).rows[0].first_persisted_use_at, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [losingUndo.item.id])).rows[0].n, 1);
  } finally {
    releaseUndo.resolve();
    await bounded(Promise.all([undoingFirst.catch(() => undefined), losingSave?.catch(() => undefined)]), 'Undo/losing Save race cleanup');
  }
});
