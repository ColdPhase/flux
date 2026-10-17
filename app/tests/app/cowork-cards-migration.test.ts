import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertExactMigrationLedger, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

// Migration 0111 (#153 AC-2/AC-4, #400 AC-4): who cancelled a request and a project's explicit review rule.

async function project() {
  const owner = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
  await pool.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Mig owner',$2)", [owner, `${owner}@example.test`]);
  await pool.query("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'Mig space',$2)", [workspaceId, owner]);
  await pool.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES ($1,$2,'Mig project','workspace',$3)", [projectId, workspaceId, owner]);
  return { owner, workspaceId, projectId };
}

test('0111 adds the canceller column and the review rule table; the rule is a closed set and goes with its project', async () => {
  const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
  assert.equal(manifest.find((file) => file.version === 111)?.name, '0111_cowork_cards.sql');
  assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(pool));

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

test('the 0111 reversal refuses while a project requires another owner, and otherwise only forgets the canceller and the explicit default', async () => {
  const sql = await readFile('packages/db/migrations/reverse/0111_cowork_cards.down.sql', 'utf8');
  const { owner, workspaceId, projectId } = await project();
  const client = await pool.connect();
  try {
    await client.query('INSERT INTO cowork_review_policies(project_id, review_separation, updated_by) VALUES ($1,\'distinct_owner\',$2)', [projectId, owner]);
    await client.query('BEGIN');
    await assert.rejects(client.query(sql), /0111 reversal refused/);
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM cowork_review_policies')).rows[0].n >= 1, true, 'a refused reversal changes nothing');

    await client.query("UPDATE cowork_review_policies SET review_separation = 'distinct_connection' WHERE project_id = $1", [projectId]);
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL lock_timeout = \'5s\'');
      await client.query(sql);
      assert.equal((await client.query("SELECT to_regclass('cowork_review_policies') AS t")).rows[0].t, null);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'cowork_requests' AND column_name = 'cancelled_by'")).rows[0].n, 0);
    } finally {
      await client.query('ROLLBACK');
    }
    assert.notEqual((await client.query("SELECT to_regclass('cowork_review_policies') AS t")).rows[0].t, null, 'this test leaves the schema as it found it');
  } finally {
    client.release();
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM auth_users WHERE id = $1', [owner]);
  }
});
