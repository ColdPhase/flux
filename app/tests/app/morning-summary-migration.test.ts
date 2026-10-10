import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { assertExactMigrationLedger, assertKnownMigrationVersions, assertMorningSummaryMigrationCompatibility, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

const directory = 'packages/db/migrations';

test('0072 preserves ordinary notification data on upgrade/reverse and records only its reserved version', async () => {
  const client = await pool.connect();
  const schema = `summary_migration_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    assert.equal(manifest.find((file) => file.version === 72)?.name, '0072_morning_summary.sql');
    assert.ok(!manifest.some((file) => file.name === '0057_morning_summary.sql'));
    for (const file of manifest.filter((file) => file.version !== 72)) {
      await client.query(await readFile(join(directory, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const userId = randomUUID(); const workspaceId = randomUUID(); const ordinaryId = randomUUID();
    await client.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Summary owner',$2)", [userId, `${userId}@example.test`]);
    await client.query("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'Summary workspace',$2)", [workspaceId, userId]);
    await client.query('INSERT INTO notification_preferences(user_id) VALUES ($1)', [userId]);
    await client.query("INSERT INTO notifications(id,user_id,workspace_id,source_type,source_id,title) VALUES($1,$2,$3,'workspace',$3,'Ordinary legacy notification')", [ordinaryId,userId,workspaceId]);
    const ordinaryBefore = (await client.query('SELECT * FROM notifications WHERE id=$1', [ordinaryId])).rows[0];
    const preferencesBefore = (await client.query('SELECT * FROM notification_preferences WHERE user_id=$1', [userId])).rows[0];
    await assertMorningSummaryMigrationCompatibility(client, await readAppliedMigrationVersions(client));
    await client.query(await readFile(join(directory, '0072_morning_summary.sql'), 'utf8'));
    await client.query('INSERT INTO flux_schema_version(version) VALUES (72)');
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(client));
    await assertMorningSummaryMigrationCompatibility(client, await readAppliedMigrationVersions(client));
    const row = (await client.query('SELECT * FROM notifications WHERE id=$1', [ordinaryId])).rows[0];
    assert.deepEqual(row, { ...ordinaryBefore, delivery_kind: 'ordinary', summary_sources: null });
    const prefs = (await client.query('SELECT * FROM notification_preferences WHERE user_id=$1', [userId])).rows[0];
    assert.deepEqual(prefs, { ...preferencesBefore, summary_enabled: false, summary_at: 540, summary_last_on: null });
    await client.query('SAVEPOINT malformed_summary');
    await assert.rejects(client.query("UPDATE notifications SET delivery_kind='morning_summary', summary_sources='[]'::jsonb WHERE id=$1", [ordinaryId]), /notifications_summary_sources_check/);
    await client.query('ROLLBACK TO SAVEPOINT malformed_summary');
    const summaryId = randomUUID();
    await client.query("INSERT INTO notifications(id,user_id,workspace_id,source_type,source_id,title,in_inbox,delivery_kind,summary_sources) VALUES($1,$2,$3,'workspace',$3,'1 thing waits in your inbox',false,'morning_summary',$4)",
      [summaryId,userId,workspaceId,JSON.stringify([{ type:'workspace', id:workspaceId, workspaceId }])]);
    await client.query(await readFile(join(directory, 'reverse/0072_morning_summary.down.sql'), 'utf8'));
    await client.query('DELETE FROM flux_schema_version WHERE version=72');
    assert.deepEqual((await client.query('SELECT * FROM notifications WHERE id=$1', [ordinaryId])).rows[0], ordinaryBefore);
    assert.deepEqual((await client.query('SELECT * FROM notification_preferences WHERE user_id=$1', [userId])).rows[0], preferencesBefore);
    assert.equal((await client.query('SELECT id FROM notifications WHERE id=$1', [summaryId])).rowCount, 0, 'reversal cannot turn a queued summary into an unrestricted legacy notification');
    await client.query(await readFile(join(directory, '0072_morning_summary.sql'), 'utf8'));
    await client.query('INSERT INTO flux_schema_version(version) VALUES (72)');
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(client));
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('legacy summary columns are refused even when a composed manifest knows reserved57/58, with source rows unchanged', async () => {
  const client = await pool.connect();
  const schema = `summary_legacy_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    await client.query('CREATE TABLE flux_schema_version(version integer PRIMARY KEY)');
    await client.query('CREATE TABLE notification_preferences(user_id text PRIMARY KEY, summary_enabled boolean, summary_at integer, summary_last_on date)');
    await client.query("INSERT INTO notification_preferences VALUES ('retained-owner',true,1439,'2026-10-08')");
    const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    // The reserved files need not be implemented by this PR. Their presence in a composed
    // image is enough for the old numeric-only check to accept a different 0057 footprint.
    const composed = [...manifest, ...[57, 58].filter((version) => !manifest.some((file) => file.version === version))
      .map((version) => ({ version, name: `${String(version).padStart(4, '0')}_reserved_fixture.sql` }))];
    for (const versions of [[57], [57,58]]) {
      await client.query('DELETE FROM flux_schema_version');
      for (const version of versions) await client.query('INSERT INTO flux_schema_version VALUES ($1)', [version]);
      const before = (await client.query('SELECT * FROM notification_preferences')).rows;
      const ledger = await readAppliedMigrationVersions(client);
      assert.doesNotThrow(() => assertKnownMigrationVersions(composed, ledger), 'negative control: numeric identity alone admits the legacy footprint');
      await assert.rejects(assertMorningSummaryMigrationCompatibility(client, ledger), /legacy morning-summary columns.*without ledger version 72/);
      assert.deepEqual(await readAppliedMigrationVersions(client), versions);
      assert.deepEqual((await client.query('SELECT * FROM notification_preferences')).rows, before);
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('summary preflight permits a missing table, ordinary preferences and recorded0072; one stray column is refused', async () => {
  const client = await pool.connect();
  const schema = `summary_preflight_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    // No public fallback: this case is genuinely a new schema, not the live stack's table.
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    assert.equal((await client.query("SELECT to_regclass('notification_preferences') AS name")).rows[0].name, null);
    await assertMorningSummaryMigrationCompatibility(client, []);
    await client.query('CREATE TABLE notification_preferences(user_id text PRIMARY KEY)');
    await client.query("INSERT INTO notification_preferences VALUES ('retained-owner')");
    await assertMorningSummaryMigrationCompatibility(client, [57, 58]);
    const ordinary = (await client.query('SELECT * FROM notification_preferences')).rows;
    for (const [column, type] of [['summary_enabled', 'boolean'], ['summary_at', 'integer'], ['summary_last_on', 'date']]) {
      await client.query('SAVEPOINT summary_column');
      await client.query(`ALTER TABLE notification_preferences ADD COLUMN ${column} ${type}`);
      const before = (await client.query('SELECT * FROM notification_preferences')).rows;
      await assert.rejects(assertMorningSummaryMigrationCompatibility(client, [57, 58]), new RegExp(`legacy morning-summary columns.*${column}`));
      await assertMorningSummaryMigrationCompatibility(client, [57, 58, 72]);
      assert.deepEqual((await client.query('SELECT * FROM notification_preferences')).rows, before);
      await client.query('ROLLBACK TO SAVEPOINT summary_column');
      assert.deepEqual((await client.query('SELECT * FROM notification_preferences')).rows, ordinary);
      await assertMorningSummaryMigrationCompatibility(client, [57, 58]);
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('the actual migrator refuses the legacy footprint before unknown-version checks or any migration writes', async () => {
  const client = await pool.connect();
  const schema = `summary_migrator_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
  try {
    // Committed isolated fixtures let the real tooling/migrate.ts process observe the
    // database. The schema has no dependency on, or writes to, the live application data.
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.flux_schema_version(version integer PRIMARY KEY)`);
    await client.query(`INSERT INTO ${schema}.flux_schema_version VALUES (57)`);
    await client.query(`CREATE TABLE ${schema}.notification_preferences(user_id text PRIMARY KEY, summary_enabled boolean, summary_at integer, summary_last_on date)`);
    await client.query(`INSERT INTO ${schema}.notification_preferences VALUES ('retained-owner',true,1439,'2026-10-08')`);
    const snapshot = async () => ({
      rows: (await client.query(`SELECT * FROM ${schema}.notification_preferences ORDER BY user_id`)).rows,
      ledger: (await client.query(`SELECT * FROM ${schema}.flux_schema_version ORDER BY version`)).rows,
      relations: (await client.query('SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname', [schema])).rows,
    });
    const before = await snapshot();
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'tooling/migrate.ts'], {
      env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 30_000,
    }), (error: unknown) => {
      const failure = error as { code?: unknown; stderr?: string; stdout?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? '', /legacy morning-summary columns.*without ledger version 72/);
      assert.doesNotMatch(failure.stderr ?? '', /versions without files/, 'the semantic guard runs before the numeric-only guard');
      assert.doesNotMatch(failure.stdout ?? '', /Applied migration/);
      return true;
    });
    assert.deepEqual(await snapshot(), before, 'the actual startup guard keeps source rows, ledger and schema objects unchanged');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
});
