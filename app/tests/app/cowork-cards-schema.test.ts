import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';

// #153 AC-2/AC-4, #400 AC-4: who cancelled a request and a project's explicit review rule.

async function project() {
  const owner = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
  await pool.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Mig owner',$2)", [owner, `${owner}@example.test`]);
  await pool.query("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'Mig space',$2)", [workspaceId, owner]);
  await pool.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES ($1,$2,'Mig project','workspace',$3)", [projectId, workspaceId, owner]);
  return { owner, workspaceId, projectId };
}

test('the canceller column and the review rule table exist; the rule is a closed set and goes with its project', async () => {

  assert.deepEqual((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'cowork_requests' AND column_name = 'cancelled_by'")).rows,
    [{ is_nullable: 'YES' }], 'every earlier request was cancelled by no one');
  assert.equal((await pool.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'cowork_requests'::regclass AND confrelid = 'auth_users'::regclass`)).rows[0]?.confdeltype, 'n',
    'closing the account of the person who cancelled keeps the request');

  const { owner, workspaceId, projectId } = await project();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_review_policies WHERE project_id = $1', [projectId])).rows[0].n, 0, 'no row means the default');
  const set = (value: string) => pool.query('INSERT INTO cowork_review_policies(project_id, review_separation, updated_by) VALUES ($1,$2,$3) ON CONFLICT (project_id) DO UPDATE SET review_separation = EXCLUDED.review_separation',
    [projectId, value, owner]);
  await set('distinct_owner');
  await assert.rejects(set('anyone'), /check constraint|cowork_review_policies/, 'only the two known rules');
  await assert.rejects(pool.query("INSERT INTO cowork_review_policies(project_id, review_separation) VALUES ($1,'distinct_owner')", [randomUUID()]), /foreign key/, 'a real project');
  // Closing the account of the manager who chose it forgets the name, never the rule.
  const manager = randomUUID();
  await pool.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Mig manager',$2)", [manager, `${manager}@example.test`]);
  await pool.query('UPDATE cowork_review_policies SET updated_by = $2 WHERE project_id = $1', [projectId, manager]);
  await pool.query('DELETE FROM auth_users WHERE id = $1', [manager]);
  assert.deepEqual((await pool.query('SELECT review_separation, updated_by FROM cowork_review_policies WHERE project_id = $1', [projectId])).rows,
    [{ review_separation: 'distinct_owner', updated_by: null }]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_review_policies WHERE project_id = $1', [projectId])).rows[0].n, 0, 'the rule goes with its project');
  await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  await pool.query('DELETE FROM auth_users WHERE id = $1', [owner]);
});
