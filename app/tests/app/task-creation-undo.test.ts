import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { notificationFactRows, projectExportRows, taskUseRows } from '@flux/db';
import { projectWorkDetailPath, type UndoTaskCreationResult, type WorkItem, type SearchResponse, type TaskCreationNotice } from '@flux/contracts';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, type Person } from './support/people.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';

async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

async function scene() {
  const f = await actionScene(pool);
  const createGrant = await f.grant('work.create', 'execute');
  const create = async (extra: Record<string, unknown> = {}) => {
    const commandId = randomUUID();
    const command = { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: createGrant.id,
      clientCommandId: commandId, peerRequestClass: 'execute', sources: [], task: { title: 'Unused agent trial', ...extra } };
    const created = toolValue(await f.tool('flux_create_task', command));
    return { command, item: await f.read(String(created.workId)) as unknown as WorkItem };
  };
  const ownerId = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const owner: Person = { id: ownerId, email: '', browser: f.owner };
  const undo = (item: WorkItem, clientCommandId: string = randomUUID()) => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`,
    { body: { clientCommandId, expectedVersion: item.version } });
  return { ...f, create, ownerId, human: owner, undo };
}

test('genuine native creation Undo retains exact history and receipts; core/MCP creation retries cannot resurrect it', async () => {
  const f = await scene();
  const query = `undosearchprobe${randomUUID().replaceAll('-', '')}`;
  const { item, command } = await f.create({ title: query });
  assert.ok(Number.isSafeInteger(item.number) && item.number > 0, 'the native task has a real project number');
  const activeControl = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`,
    { body: { title: `${query} active human control` } }), 201) as unknown as WorkItem;
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: `${query} historical text`, body: query } }), 201);
  const search = async (type?: string) => expect(await f.owner.request('GET', `/api/v1/search?${new URLSearchParams({
    q: query, place: `project:${f.projectId}`, ...(type ? { type } : {}),
  })}`), 200) as unknown as SearchResponse;
  for (const type of [undefined, 'work']) {
    const answer = await search(type);
    assert.equal(answer.counts.work, 2);
    assert.deepEqual(answer.items.filter((hit) => hit.kind === 'work').map((hit) => hit.target)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [item, activeControl].map((work) => ({ type: 'work', projectId: f.projectId, id: work.id }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    assert.equal(answer.next, null);
  }
  assert.deepEqual((await f.read(item.id) as unknown as WorkItem).creationUndo, { eligible: true, reason: 'eligible' }, 'search reads do not consume unused creation');
  assert.deepEqual(item.creationUndo, { eligible: true, reason: 'eligible' });
  const before = (await pool.query('SELECT created_by_kind,created_by_id,created_at,client_command_id FROM project_work_items WHERE id=$1', [item.id])).rows[0];
  const commandId = randomUUID();
  const reverted = expect(await f.undo(item, commandId), 200) as unknown as UndoTaskCreationResult;
  assert.equal(reverted.work.lifecycle?.state, 'creation_reverted');
  assert.equal(reverted.work.number, item.number, 'Undo preserves the native task number');
  assert.equal(reverted.work.version, item.version + 1);
  const detail = expect(await f.owner.request('GET', projectWorkDetailPath(f.projectId, 'work', item.id)), 200) as unknown as {
    object: { number: number; lifecycle: { state: string } };
  };
  assert.equal(detail.object.number, item.number); assert.equal(detail.object.lifecycle.state, 'creation_reverted');
  const noticePage = expect(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/task-notices`), 200) as unknown as { items: TaskCreationNotice[] };
  assert.deepEqual(noticePage.items.filter((notice) => notice.workId === item.id).map((notice) => [notice.kind, notice.workNumber]).sort(),
    [['task.created', item.number], ['task.creation_reverted', item.number]].sort(), 'both truthful notices retain the exact task number');
  for (const type of [undefined, 'work']) {
    const answer = await search(type);
    assert.equal(answer.counts.work, 1, 'current counts exclude retained reverted work before the count limit');
    assert.deepEqual(answer.items.filter((hit) => hit.kind === 'work').map((hit) => hit.target),
      [{ type: 'work', projectId: f.projectId, id: activeControl.id }]);
    assert.equal(answer.next, null);
    if (!type) assert.equal(answer.items.filter((hit) => hit.kind === 'material').length, 1, 'ordinary historical text remains searchable');
  }
  assert.deepEqual(expect(await f.undo(item, commandId.toUpperCase()), 200), reverted);
  const changed = expect(await f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`,
    { body: { clientCommandId: commandId, expectedVersion: item.version + 1 } }), 409);
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual((await pool.query('SELECT created_by_kind,created_by_id,created_at,client_command_id FROM project_work_items WHERE id=$1', [item.id])).rows[0], before);
  const notices = (await pool.query('SELECT id,kind,created_by_kind,created_by_id FROM project_task_notices WHERE work_id=$1 ORDER BY created_at,id', [item.id])).rows;
  assert.equal(notices.length, 2); assert.equal(notices[0].kind, 'task.created');
  assert.deepEqual([notices[1].kind, notices[1].id, notices[1].created_by_kind, notices[1].created_by_id], ['task.creation_reverted', reverted.noticeId, 'human', f.ownerId]);
  await assert.rejects(pool.query('UPDATE task_creation_undo_receipts SET created_at=clock_timestamp() WHERE work_id=$1', [item.id]),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
  await assert.rejects(pool.query('DELETE FROM task_creation_undo_receipts WHERE work_id=$1', [item.id]),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
  await assert.rejects(pool.query(`INSERT INTO task_creation_undo_receipts(workspace_id,project_id,actor_kind,actor_id,client_command_id,request_fingerprint,work_id,notice_id)
    VALUES($1,$2,'human',$3,$4,$5,$6,$7)`, [f.workspaceId, randomUUID(), f.ownerId, randomUUID(), 'a'.repeat(64), item.id, reverted.noticeId]),
  (error: unknown) => error instanceof Error && 'code' in error && error.code === '23503');
  assert.equal(toolFailure(await f.tool('flux_create_task', command)).code, 'COMMAND_POSTSTATE_STALE');
  assert.equal((await f.owner.request('PATCH', `/api/v1/work/${item.id}`, { body: { title: 'Revive' }, headers: { 'if-match': `"${reverted.work.version}"` } })).status, 409);
  assert.equal((await f.owner.request('POST', `/api/v1/work/${item.id}/discussion`, { body: { clientMessageId: randomUUID(), body: 'New use' } })).status, 409);
  assert.equal((await f.owner.request('POST', `/api/v1/projects/${f.projectId}/results`, { body: { title: 'New result', finding: 'positive', work: [item.id] } })).status, 409);
  const active = expect(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/work`), 200);
  assert.equal((active.items as WorkItem[]).some((work) => work.id === item.id), false);
  const historical = (await projectExportRows(db).work(f.projectId)).find((work) => work.id === item.id)!;
  assert.equal(historical.lifecycle.state, 'creation_reverted');
  assert.equal(historical.number, item.number, 'historical export retains the native task number');
  assert.equal(historical.creationHistory.notices.length, 2);
  await assert.rejects(pool.query('UPDATE project_work_items SET number=number+1 WHERE id=$1', [item.id]),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === '23001');
  assert.equal(await notificationFactRows(db).work(item.id), null);
});

test('unrelated project writer and viewer cannot Undo; an exact agent operation grant cannot authorize another creator', async () => {
  const f = await scene(); const { item } = await f.create();
  const peer = await person('undo-peer'); await addMember(f.human, f.workspaceId, peer, 'member'); await grant(f.human, f.projectId, peer, 'contributor');
  assert.deepEqual((expectStatus(await peer.browser.request('GET', `/api/v1/work/${item.id}`), 200) as WorkItem).creationUndo, { eligible: false, reason: 'not_authorized' });
  assert.equal((await peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } })).status, 403);
  await grant(f.human, f.projectId, peer, 'viewer');
  assert.equal((await peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } })).status, 403);
  const updateGrant = await f.grant('work.update', 'execute');
  const envelope = { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], workId: item.id, expectedVersion: item.version };
  assert.equal(toolFailure(await f.tool('flux_undo_task_creation', { ...envelope, grantId: updateGrant.id })).code, 'AGENT_EXECUTION_UNAVAILABLE');
  const undoGrant = await f.grant('work.creation.revert', 'execute', 5, item.id);
  const reverted = toolValue(await f.tool('flux_undo_task_creation', { ...envelope, grantId: undoGrant.id }));
  assert.equal(reverted.workId, item.id); assert.equal(reverted.number, item.number); assert.equal(await f.used(undoGrant.id), 1);
  assert.deepEqual(toolValue(await f.tool('flux_undo_task_creation', { ...envelope, grantId: undoGrant.id })), { ...reverted, replayed: true });
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}/action-grants/${undoGrant.id}`), 204);
  assert.equal(toolFailure(await f.tool('flux_undo_task_creation', { ...envelope, grantId: undoGrant.id })).code, 'AGENT_EXECUTION_UNAVAILABLE');
});

test('old incomplete history stays unknown, human origin stays human, removed task links and document mentions keep monotonic use', async () => {
  const f = await scene();
  const human = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Human creation' } }), 201) as unknown as WorkItem;
  assert.equal((await f.read(human.id) as unknown as WorkItem).creationUndo?.reason, 'not_ai_origin');
  const oldId = randomUUID(); await pool.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,outcome,status,created_by_kind,created_by_id) VALUES($1,$2,$3,'Historical unknown','','open','agent',$4)`, [oldId, f.workspaceId, f.projectId, f.agentId]);
  assert.equal((await f.read(oldId) as unknown as WorkItem).creationUndo?.reason, 'eligibility_unknown');
  const { item } = await f.create();
  const doc = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, { body: { title: 'Saved reference', body: `[Trial](flux:work/${item.id})` }, headers: { 'idempotency-key': randomUUID() } }), 201);
  expect(await f.owner.request('PATCH', `/api/v1/docs/${doc.id}`, { body: { body: 'Reference removed' }, headers: { 'if-match': '"1"', 'idempotency-key': randomUUID() } }), 200);
  assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.reason, 'task_used');
  assert.equal((await f.undo(item)).status, 409);
  const other = await f.create();
  const dependent = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Dependent', dependencyIds: [other.item.id] } }), 201) as unknown as WorkItem;
  expect(await f.owner.request('PATCH', `/api/v1/work/${dependent.id}`, { body: { dependencyIds: [] }, headers: { 'if-match': `"${dependent.version}"` } }), 200);
  assert.equal((await f.read(other.item.id) as unknown as WorkItem).creationUndo?.reason, 'task_used');
});

test('first use wins under one real task fence; Undo waits and refuses without partial history', { timeout: 30_000 }, async () => {
  const f = await scene(); const { item } = await f.create(); const held = barrier<number>(); const release = barrier();
  let undo: ReturnType<typeof f.undo> | undefined;
  const firstUse = db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    await native.contribute({ kind: 'human', id: f.ownerId }, item.id, { body: 'A real first persisted contribution', clientMessageId: randomUUID() });
    held.resolve(await backendPid(tx)); await bounded(release.promise, 'first-use release'); await native.flushEvents();
  }); void firstUse.catch(() => undefined);
  try {
    const pid = await bounded(held.promise, 'persisted first use'); undo = f.undo(item); void undo.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid); release.resolve(); await bounded(firstUse, 'first-use COMMIT');
    assert.equal((await bounded(undo, 'waiting Undo refusal')).status, 409);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [item.id])).rows[0].n, 0);
  } finally {
    release.resolve(); await bounded(Promise.all([firstUse.catch(() => undefined), undo?.catch(() => undefined)]), 'first-use race cleanup');
  }
});

test('Undo wins; a blocked first contribution loses with no message, binding or use latch', { timeout: 30_000 }, async () => {
  const f = await scene(); const { item } = await f.create(); const held = barrier<number>(); const release = barrier();
  let contribution: ReturnType<typeof f.owner.request> | undefined;
  const undo = db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    const result = await native.undoTaskCreation({ kind: 'human', id: f.ownerId }, item.id, { clientCommandId: randomUUID(), expectedVersion: item.version });
    held.resolve(await backendPid(tx)); await bounded(release.promise, 'Undo release'); await native.flushEvents(); return result;
  }); void undo.catch(() => undefined);
  try {
    const pid = await bounded(held.promise, 'persisted Undo');
    contribution = f.owner.request('POST', `/api/v1/work/${item.id}/discussion`, { body: { body: 'Late first use', clientMessageId: randomUUID() } }); void contribution.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid); release.resolve(); await bounded(undo, 'Undo COMMIT'); assert.equal((await bounded(contribution, 'late contribution refusal')).status, 409);
    const stored = (await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0];
    assert.equal(stored.first_persisted_use_at, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_task_discussions WHERE work_id=$1', [item.id])).rows[0].n, 0);
  } finally {
    release.resolve(); await bounded(Promise.all([undo.catch(() => undefined), contribution?.catch(() => undefined)]), 'Undo race cleanup');
  }
});

test('rollback removes lifecycle, notices, receipts and first-use latch together', async () => {
  const f = await scene(); const { item } = await f.create(); const sentinel = new Error('Injected rollback');
  await assert.rejects(db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    await native.undoTaskCreation({ kind: 'human', id: f.ownerId }, item.id, { clientCommandId: randomUUID(), expectedVersion: item.version });
    throw sentinel;
  }), (error) => error === sentinel);
  assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.eligible, true);
  await assert.rejects(db.transaction(async (tx) => { const fence = await taskUseRows(tx).prepare([item.id]); await fence.mark(); throw sentinel; }), (error) => error === sentinel);
  assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.eligible, true);
  const receiptCount = (await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n;
  assert.equal(receiptCount, 0);
});

test('an exact existing creation-provenance link is an observation and leaves Undo available', async () => {
  const f = await scene();
  const result = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/results`,
    { body: { title: 'Initial context', finding: 'positive' } }), 201);
  // The public MCP task schema deliberately has no related field. Exercise the admitted
  // trusted native creation port using this scene's real agent, then the public link command.
  const item = await db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    const created = await native.createWork({ kind: 'agent', id: f.agentId }, f.projectId,
      { title: 'Initial related context', related: [{ type: 'result', id: String(result.id) }] });
    await native.flushEvents();
    return created;
  });
  const before = await pool.query('SELECT count(*)::int AS n FROM project_object_links WHERE from_id=$1', [item.id]);
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/links`,
    { body: { from: { type: 'work', id: item.id }, to: { type: 'result', id: result.id } } }), 201);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_object_links WHERE from_id=$1', [item.id])).rows[0].n, before.rows[0].n);
  assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.eligible, true);
  expect(await f.undo(item), 200);
  const doc = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`,
    { body: { title: 'Original result remains useful', from: { type: 'result', id: result.id } } }), 201);
  assert.equal(typeof doc.id, 'string');
});

test('a document reference resolving while graph preparation waits refuses without an unfenced saved mention', { timeout: 30_000 }, async () => {
  const f = await scene(); const held = barrier<{ item: WorkItem; pid: number }>(); const release = barrier();
  const bounded = async <T>(pending: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Document target-set race did not settle')), 10_000);
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  const creating = db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    const item = await native.createWork({ kind: 'agent', id: f.agentId }, f.projectId, { title: 'Uncommitted native target' });
    held.resolve({ item, pid: await backendPid(tx) });
    await bounded(release.promise); await native.flushEvents(); return item;
  });
  void creating.catch(() => undefined);
  let saving: ReturnType<typeof f.owner.request> | undefined;
  const title = `Target-set race ${randomUUID()}`;
  try {
    const { item, pid } = await bounded(held.promise);
    saving = f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`,
      { body: { title, body: `[Uncommitted trial](flux:work/${item.id})` }, headers: { 'idempotency-key': randomUUID() } });
    void saving.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid); release.resolve(); await bounded(creating);
    assert.equal(expect(await bounded(saving), 409).code, 'TASK_TARGET_SET_CHANGED');
    assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0].first_persisted_use_at, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_material_versions WHERE project_id=$1 AND title=$2', [f.projectId, title])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_object_links WHERE to_id=$1 AND role='mentions'", [item.id])).rows[0].n, 0);
    expect(await f.undo(item), 200);
  } finally {
    release.resolve();
    await bounded(Promise.all([creating.catch(() => undefined), saving?.catch(() => undefined)]));
  }
});
