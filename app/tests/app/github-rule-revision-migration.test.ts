import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { assertExactMigrationLedger, createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';
import { guardFixturePool } from './support/fixture-database.js';

test('the real migrator fills 0068 after retained 0072 without changing GitHub or morning-summary data', { timeout: 120_000 }, async () => {
  const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
  assert.ok(FLUX_SCHEMA_VERSION >= 72);
  const revision = manifest.find(file => file.version === 68)!;
  assert.equal(revision.name, '0068_github_rule_revision.sql');
  const prior = manifest.filter(file => file.version !== 68);
  const name = `github_revision_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  const createFixture = { text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 };
  await pool.query(createFixture);
  const fixture = createDatabase(url.toString()).pool;
  const errors = guardFixturePool(fixture);
  try {
    for (const file of prior) {
      await fixture.query(await readFile(join('packages/db/migrations', file.name), 'utf8'));
      await fixture.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    assertExactMigrationLedger(prior, await readAppliedMigrationVersions(fixture));
    assert.ok((await readAppliedMigrationVersions(fixture)).includes(72));
    const [owner, workspace, project, task, history, notification, binding] = Array.from({ length: 7 }, () => randomUUID());
    const generation = randomUUID();
    await fixture.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Retained rule owner',$2)", [owner, `${owner}@example.test`]);
    await fixture.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Retained workspace',$2)", [workspace, owner]);
    await fixture.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Retained project',$3)", [project, workspace, owner]);
    await fixture.query("INSERT INTO project_work_items(id,workspace_id,project_id,title,outcome,status,created_by_kind,created_by_id) VALUES($1,$2,$3,'Retained task','Keep original outcome','open','human',$4)", [task, workspace, project, owner]);
    await fixture.query("INSERT INTO github_bindings(id,workspace_id,project_id,installation_id,repository_id,owner,name,private,url,author_user_id,author_github_user_id,app_id,authorization_generation,state) VALUES($1,$2,$3,'555','777','fixture','repository',true,'https://github.com/fixture/repository',$4,'456','123',$5,'disconnected')", [binding, workspace, project, owner, generation]);
    await fixture.query("INSERT INTO github_task_rules(task_id,workspace_id,project_id,mode,state,suspended_reason,author_user_id,author_github_user_id,author_generation,app_id,expected_version,expected_status) VALUES($1,$2,$3,'ready','suspended','repository_unavailable',$4,'456',$5,'123',1,'open')", [task, workspace, project, owner, generation]);
    await fixture.query("INSERT INTO github_task_rule_changes(id,workspace_id,project_id,task_id,code,from_status,to_status,ready_to_close,author_user_id,binding_id,origin,task_version) VALUES($1,$2,$3,$4,'suspended_repository','open','open',false,$5,$6,'binding',1)", [history, workspace, project, task, owner, binding]);
    await fixture.query('INSERT INTO notification_preferences(user_id,summary_enabled,summary_at) VALUES($1,true,615)', [owner]);
    await fixture.query("INSERT INTO notifications(id,user_id,workspace_id,source_type,source_id,title,in_inbox,delivery_kind,summary_sources) VALUES($1,$2,$3,'workspace',$3,'Retained summary',false,'morning_summary',$4)",
      [notification, owner, workspace, JSON.stringify([{ type: 'workspace', id: workspace, workspaceId: workspace }])]);
    const snapshot = async () => ({
      task: (await fixture.query('SELECT * FROM project_work_items WHERE id=$1', [task])).rows,
      rule: (await fixture.query('SELECT * FROM github_task_rules WHERE task_id=$1', [task])).rows,
      binding: (await fixture.query('SELECT * FROM github_bindings WHERE id=$1', [binding])).rows,
      history: (await fixture.query('SELECT * FROM github_task_rule_changes WHERE id=$1', [history])).rows,
      preferences: (await fixture.query('SELECT * FROM notification_preferences WHERE user_id=$1', [owner])).rows,
      notification: (await fixture.query('SELECT * FROM notifications WHERE id=$1', [notification])).rows,
    });
    const before = await snapshot();
    const migrate = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'tooling/migrate.ts'], {
      env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 30_000,
    });
    const first = await migrate();
    assert.match(first.stdout, /Applied migration 0068_github_rule_revision\.sql/);
    assert.equal((first.stdout.match(/Applied migration /g) ?? []).length, 1, 'only the missing lower migration runs');
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(fixture));
    const upgraded = { ...before, rule: before.rule.map(row => ({ ...row, revision: 1 })) };
    assert.deepEqual(await snapshot(), upgraded);
    const restart = await migrate();
    assert.doesNotMatch(restart.stdout, /Applied migration /);
    assert.deepEqual(await snapshot(), upgraded, 'a real restart changes no retained facts');
    await fixture.query(await readFile('packages/db/migrations/reverse/0068_github_rule_revision.down.sql', 'utf8'));
    await fixture.query('DELETE FROM flux_schema_version WHERE version=68');
    assertExactMigrationLedger(prior, await readAppliedMigrationVersions(fixture));
    assert.deepEqual(await snapshot(), before, 'pre-use reversal retains the original data and 0072');
    await migrate();
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(fixture));
    assert.deepEqual(await snapshot(), upgraded);
  } finally {
    errors.cleanup(); await fixture.end();
    const dropFixture = { text: `DROP DATABASE "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await pool.query(dropFixture);
  }
  errors.assertNoEarlyErrors();
});
