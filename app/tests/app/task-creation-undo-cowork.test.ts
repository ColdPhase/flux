import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { WorkItem } from '@flux/contracts';
import { pool } from './support/db.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';

// #238 AC-U2 with #153 composed on main: taking a task with a co-work unit is a persisted use under the shared task
// fence, and a task whose creation was undone is no co-work target. Real MCP tools, grants, runtime and SQL.
test('a co-work unit is a first use that refuses Undo; an undone task cannot be taken as a unit', { timeout: 30_000 }, async () => {
  const f = await actionScene(pool);
  const create = await f.grant('work.create', 'execute', 5);
  const native = async (title: string) => {
    const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: create.id,
      clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title } }));
    return await f.read(String(created.workId)) as unknown as WorkItem;
  };
  const take = await f.grant('cowork.unit.create', 'execute', 5);
  const unit = (item: WorkItem) => f.tool('flux_create_unit', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: take.id,
    clientCommandId: randomUUID(), peerRequestClass: 'execute', taskId: item.id, unitKey: 'take', expectedTaskVersion: item.version,
    assignmentConnectionId: f.connectionId, parent: null });
  const undo = (item: WorkItem) => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`,
    { body: { clientCommandId: randomUUID(), expectedVersion: item.version } });
  const units = async (item: WorkItem) => (await pool.query('SELECT count(*)::int AS n FROM cowork_units WHERE work_id=$1', [item.id])).rows[0].n as number;
  const receipts = async (item: WorkItem) => (await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n as number;

  // Taking the task is its first use: Undo is then refused and leaves no history behind.
  const taken = await native('Measure the dim-light gesture count');
  assert.deepEqual(taken.creationUndo, { eligible: true, reason: 'eligible' });
  assert.equal(toolValue(await unit(taken)).status, 'created');
  const current = await f.read(taken.id) as unknown as WorkItem;
  assert.deepEqual(current.creationUndo, { eligible: false, reason: 'task_used' });
  assert.equal((await undo(current)).status, 409);
  assert.equal(await receipts(taken), 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_task_notices WHERE work_id=$1 AND kind='task.creation_reverted'", [taken.id])).rows[0].n, 0);

  // After Undo the task is history: no unit, no use mark, the grant is not spent.
  const history = await native('Calibrate the sensor before anyone takes it');
  assert.equal((await undo(history)).status, 200);
  const spent = (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [take.id])).rows[0].used as number;
  assert.equal(toolFailure(await unit(history)).code, 'TASK_CREATION_REVERTED');
  assert.equal(await units(history), 0);
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [take.id])).rows[0].used, spent);
  assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [history.id])).rows[0].first_persisted_use_at, null);
});
