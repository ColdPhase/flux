import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { type UndoTaskCreationResult, type WorkItem } from '@flux/contracts';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { actionScene, agentConnection, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, removeFromSpace, type Person } from './support/people.js';

async function fixture() {
  const f = await actionScene(pool);
  const ownerId = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const owner: Person = { id: ownerId, email: '', browser: f.owner };
  const peer = await person('undo-current-assignee');
  await addMember(owner, f.workspaceId, peer, 'member'); await grant(owner, f.projectId, peer, 'contributor');
  const create = async () => {
    const value = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
      clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Current authority trial' } }));
    return await f.read(String(value.workId)) as unknown as WorkItem;
  };
  return { ...f, ownerId, human: owner, peer, create };
}

test('initial native human assignee requires current access to the space at Undo and exact receipt replay', { timeout: 30_000 }, async () => {
  const f = await fixture();
  // The production MCP creation schema has no owner field. This genuine scene's
  // admitted native agent port supplies initial assignment, preserving the baseline;
  // all Undo and grant changes use real authenticated human API sessions.
  const item = await db.transaction(async tx => {
    const native = nativeWorkInTransaction(tx);
    const created = await native.createWork({ kind: 'agent', id: f.agentId }, f.projectId,
      { title: 'Initially assigned native trial', owner: { kind: 'human', id: f.peer.id } });
    await native.flushEvents(); return created;
  });
  const commandId = randomUUID(); const command = { clientCommandId: commandId, expectedVersion: item.version };
  assert.deepEqual((expectStatus(await f.peer.browser.request('GET', `/api/v1/work/${item.id}`), 200) as WorkItem).creationUndo,
    { eligible: true, reason: 'eligible' });
  await removeFromSpace(f.human, f.projectId, f.peer);
  assert.equal((await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n, 0);
  await grant(f.human, f.projectId, f.peer, 'contributor');
  const reverted = expectStatus(await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command }), 200) as UndoTaskCreationResult;
  assert.equal(reverted.work.lifecycle?.state, 'creation_reverted');
  assert.ok(reverted.work.lifecycle?.state === 'creation_reverted');
  assert.deepEqual(reverted.work.lifecycle.revertedBy, { kind: 'human', id: f.peer.id, name: 'undo-current-assignee' });
  await removeFromSpace(f.human, f.projectId, f.peer);
  assert.equal((await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command })).status, 404);
  await grant(f.human, f.projectId, f.peer, 'contributor');
  assert.deepEqual(expectStatus(await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command }), 200), reverted);
});

test('a genuine foreign agent exact grant cannot Undo another creator; revoked connection cannot replay its authority', { timeout: 30_000 }, async () => {
  const f = await fixture(); const item = await f.create();
  const other = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/agents`,
    { body: { name: 'Another genuine creator', owner: 'self' } }), 201);
  const actor = await agentConnection(pool, f.owner, String(other.id), [f.projectId]);
  const command = { projectId: f.projectId, runtimeSessionId: actor.runtimeSessionId,
    clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [], workId: item.id, expectedVersion: item.version };
  assert.equal(toolFailure(await actor.tool('flux_undo_task_creation', command)).code, 'TASK_CREATION_UNDO_FORBIDDEN');
 assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.eligible, true);
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${actor.connectionId}`), 204);
  const revoked = await actor.raw('flux_undo_task_creation', command);
  assert.notEqual(revoked.status, 200, 'Revocation refuses before tool execution');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n, 0);
});
