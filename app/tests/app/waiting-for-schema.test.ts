import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';

// #550: who a blocked task waits for, and the blocked/unblocked lines of the conversation.

test('the waiting-for column and the task-update lines exist and stay consistent', async () => {

  const column = (await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'project_work_items' AND column_name = 'waiting_for_user_id'")).rows;
  assert.deepEqual(column, [{ is_nullable: 'YES' }], 'existing tasks wait for no one');

  const ownerId = randomUUID(); const waitingId = randomUUID(); const workspaceId = randomUUID(); const projectId = randomUUID(); const workId = randomUUID();
  await pool.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Mig owner',$3),($2,'Mig waited',$4)", [ownerId, waitingId, `${ownerId}@example.test`, `${waitingId}@example.test`]);
  await pool.query("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'Mig space',$2)", [workspaceId, ownerId]);
  await pool.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES ($1,$2,'Mig project','workspace',$3)", [projectId, workspaceId, ownerId]);
  await pool.query("INSERT INTO project_work_items(id,workspace_id,project_id,title,status,blocker,waiting_for_user_id,created_by_kind,created_by_id) VALUES ($1,$2,$3,'Blocked','blocked','why',$4,'human',$5)",
    [workId, workspaceId, projectId, waitingId, ownerId]);
  const update = (kind: string) => pool.query("INSERT INTO project_task_updates(id,workspace_id,project_id,work_id,kind,created_by_kind,created_by_id,waiting_for_user_id,reason) VALUES ($1,$2,$3,$4,$5,'human',$6,$7,'why')",
    [randomUUID(), workspaceId, projectId, workId, kind, ownerId, waitingId]);
  await update('task.blocked'); await update('task.unblocked');
  await assert.rejects(update('task.created'), /project_task_updates_kind_check|check constraint/, 'only blocked and unblocked lines');
  await assert.rejects(pool.query("INSERT INTO project_work_items(id,workspace_id,project_id,title,waiting_for_user_id,created_by_kind,created_by_id) VALUES ($1,$2,$3,'Bad',$4,'human',$5)",
    [randomUUID(), workspaceId, projectId, randomUUID(), ownerId]), /foreign key/, 'the person waited on is a real account');

  // Closing the account of the person waited on forgets the name, never the task or its lines.
  await pool.query('DELETE FROM auth_users WHERE id = $1', [waitingId]);
  assert.equal((await pool.query('SELECT waiting_for_user_id FROM project_work_items WHERE id = $1', [workId])).rows[0].waiting_for_user_id, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_task_updates WHERE work_id = $1 AND waiting_for_user_id IS NULL', [workId])).rows[0].n, 2);
  // Deleting the task deletes its lines.
  await pool.query('DELETE FROM project_work_items WHERE id = $1', [workId]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_task_updates WHERE work_id = $1', [workId])).rows[0].n, 0);
  await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  await pool.query('DELETE FROM auth_users WHERE id = $1', [ownerId]);
});
