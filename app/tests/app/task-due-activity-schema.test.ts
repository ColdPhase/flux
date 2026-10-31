import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';

// #488: a task's due date, and the activity of its status, owner, due date and title.

test('the due date and the task activity table exist and stay consistent', async () => {

  const column = (await pool.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'project_work_items' AND column_name = 'due_on'")).rows;
  assert.deepEqual(column, [{ data_type: 'date', is_nullable: 'YES' }], 'a calendar date, and existing tasks have none');

  const ownerId = randomUUID(); const workspaceId = randomUUID(); const projectId = randomUUID(); const workId = randomUUID();
  await pool.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Due owner',$2)", [ownerId, `${ownerId}@example.test`]);
  await pool.query("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'Due space',$2)", [workspaceId, ownerId]);
  await pool.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES ($1,$2,'Due project','workspace',$3)", [projectId, workspaceId, ownerId]);
  const task = (due: string | null, id = randomUUID()) => pool.query("INSERT INTO project_work_items(id,workspace_id,project_id,title,due_on,created_by_kind,created_by_id) VALUES ($1,$2,$3,'Dated',$4,'human',$5)",
    [id, workspaceId, projectId, due, ownerId]);
  await task('2026-11-03', workId); await task(null); await task('1970-01-01'); await task('9999-12-31');
  await assert.rejects(task('1969-12-31'), /project_work_items_due_on_range|check constraint/, 'no date before 1970');
  assert.equal((await pool.query('SELECT to_char(due_on, \'YYYY-MM-DD\') AS d FROM project_work_items WHERE id = $1', [workId])).rows[0].d, '2026-11-03');

  const entry = (kind: string, actorKind = 'human', work = workId) => pool.query("INSERT INTO project_task_activity(id,workspace_id,project_id,work_id,kind,actor_kind,actor_id,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,'{\"from\":null,\"to\":\"2026-11-03\"}')",
    [randomUUID(), workspaceId, projectId, work, kind, actorKind, ownerId]);
  for (const kind of ['status', 'owner', 'due', 'title']) await entry(kind);
  await entry('due', 'agent');
  await assert.rejects(entry('outcome'), /project_task_activity_kind_check|check constraint/, 'only the four tracked fields');
  await assert.rejects(entry('due', 'fixture'), /project_task_activity_actor_kind_check|check constraint/, 'a person or an agent');
  await assert.rejects(entry('due', 'human', randomUUID()), /foreign key/, 'an entry belongs to a task of its project');
  const defaulted = (await pool.query('SELECT created_at FROM project_task_activity WHERE work_id = $1 LIMIT 1', [workId])).rows[0].created_at as Date;
  assert.ok(Math.abs(defaulted.getTime() - Date.now()) < 60_000, 'the time defaults to now');
  const index = (await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'project_task_activity_work_idx'")).rows[0].indexdef as string;
  assert.match(index, /\(work_id, created_at DESC, id DESC\)/, 'newest first by (time, id) for one task');

  // An entry names its actor without a foreign key, so a closed account leaves the entries (the reader shows a former member).
  await pool.query("INSERT INTO project_task_activity(id,workspace_id,project_id,work_id,kind,actor_kind,actor_id,detail) VALUES ($1,$2,$3,$4,'title','human',$5,'{\"from\":\"a\",\"to\":\"b\"}')",
    [randomUUID(), workspaceId, projectId, workId, randomUUID()]);
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM project_task_activity WHERE work_id = $1', [workId])).rows[0].n), 6);
  // Deleting the task, or the project, deletes its entries.
  await pool.query('DELETE FROM project_work_items WHERE id = $1', [workId]);
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM project_task_activity WHERE work_id = $1', [workId])).rows[0].n), 0);
  const second = randomUUID(); await task('2026-11-04', second); await entry('due', 'human', second);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM project_task_activity WHERE project_id = $1', [projectId])).rows[0].n), 0);
  await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  await pool.query('DELETE FROM auth_users WHERE id = $1', [ownerId]);
});
