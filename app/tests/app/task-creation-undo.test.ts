import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { notificationFactRows, projectExportRows, taskUseRows } from '@flux/db';
import type { UndoTaskCreationResult, WorkItem } from '@flux/contracts';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, type Person } from './support/people.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';

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
  const undo = (item: WorkItem, clientCommandId = randomUUID()) => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`,
    { body: { clientCommandId, expectedVersion: item.version } });
  return { ...f, create, ownerId, human: owner, undo };
}

test('genuine native creation Undo retains exact history and receipts; core/MCP creation retries cannot resurrect it', async () => {
  const f = await scene(); const { item, command } = await f.create();
  assert.deepEqual(item.creationUndo, { eligible: true, reason: 'eligible' });
  const before = (await pool.query('SELECT created_by_kind,created_by_id,created_at,client_command_id FROM project_work_items WHERE id=$1', [item.id])).rows[0];
  const commandId = randomUUID();
  const reverted = expect(await f.undo(item, commandId), 200) as unknown as UndoTaskCreationResult;
  assert.equal(reverted.work.lifecycle?.state, 'creation_reverted');
  assert.equal(reverted.work.version, item.version + 1);
  assert.deepEqual(expect(await f.undo(item, commandId.toUpperCase()), 200), reverted);
  const changed = expect(await f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`,
    { body: { clientCommandId: commandId, expectedVersion: item.version + 1 } }), 409);
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual((await pool.query('SELECT created_by_kind,created_by_id,created_at,client_command_id FROM project_work_items WHERE id=$1', [item.id])).rows[0], before);
  const notices = (await pool.query('SELECT id,kind,created_by_kind,created_by_id FROM project_task_notices WHERE work_id=$1 ORDER BY created_at,id', [item.id])).rows;
  assert.equal(notices.length, 2); assert.equal(notices[0].kind, 'task.created');
  assert.deepEqual([notices[1].kind, notices[1].id, notices[1].created_by_kind, notices[1].created_by_id], ['task.creation_reverted', reverted.noticeId, 'human', f.ownerId]);
  assert.equal(toolFailure(await f.tool('flux_create_task', command)).code, 'COMMAND_POSTSTATE_STALE');
  assert.equal((await f.owner.request('PATCH', `/api/v1/work/${item.id}`, { body: { title: 'Revive' }, headers: { 'if-match': `"${reverted.work.version}"` } })).status, 409);
  assert.equal((await f.owner.request('POST', `/api/v1/work/${item.id}/discussion`, { body: { clientMessageId: randomUUID(), body: 'New use' } })).status, 409);
  assert.equal((await f.owner.request('POST', `/api/v1/projects/${f.projectId}/results`, { body: { title: 'New result', finding: 'positive', work: [item.id] } })).status, 409);
  const active = expect(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/work`), 200);
  assert.equal((active.items as WorkItem[]).some((work) => work.id === item.id), false);
  const historical = (await projectExportRows(db).work(f.projectId)).find((work) => work.id === item.id)!;
  assert.equal(historical.lifecycle.state, 'creation_reverted');
  assert.equal(historical.creationHistory.notices.length, 2);
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
  assert.equal(reverted.workId, item.id); assert.equal(await f.used(undoGrant.id), 1);
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

test('first use wins under one real task fence; Undo waits and refuses without partial history', async () => {
  const f = await scene(); const { item } = await f.create(); const held = barrier<number>(); const release = barrier();
  const firstUse = db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    await native.contribute({ kind: 'human', id: f.ownerId }, item.id, { body: 'A real first persisted contribution', clientMessageId: randomUUID() });
    held.resolve(await backendPid(tx)); await release.promise; await native.flushEvents();
  });
  const pid = await held.promise; const undo = f.undo(item); await waitUntilBlockedBy(pool, pid); release.resolve(); await firstUse;
  assert.equal((await undo).status, 409);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [item.id])).rows[0].n, 0);
});

test('Undo wins; a blocked first contribution loses with no message, binding or use latch', async () => {
  const f = await scene(); const { item } = await f.create(); const held = barrier<number>(); const release = barrier();
  const undo = db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    const result = await native.undoTaskCreation({ kind: 'human', id: f.ownerId }, item.id, { clientCommandId: randomUUID(), expectedVersion: item.version });
    held.resolve(await backendPid(tx)); await release.promise; await native.flushEvents(); return result;
  });
  const pid = await held.promise;
  const contribution = f.owner.request('POST', `/api/v1/work/${item.id}/discussion`, { body: { body: 'Late first use', clientMessageId: randomUUID() } });
  await waitUntilBlockedBy(pool, pid); release.resolve(); await undo; assert.equal((await contribution).status, 409);
  const stored = (await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [item.id])).rows[0];
  assert.equal(stored.first_persisted_use_at, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_task_discussions WHERE work_id=$1', [item.id])).rows[0].n, 0);
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
});
