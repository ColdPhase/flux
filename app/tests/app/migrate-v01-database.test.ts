import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { connectionString } from './support/db.js';

// #1176: v0.1 had no users, so v0.2 converts nothing. A database that v0.1 wrote and that holds people is refused by the real compiled
// migrator (`node tooling/dist/migrate.js`, as the Compose `migrate` service runs it) before any file runs, and a v0.1 backup is refused
// by the restore gate (`node tooling/dist/operations.js migration-gate`, which `./flux restore` asks before it replaces any data).
// `./flux upgrade`'s own refusal is checked against a real v0.1 stack by `scripts/check_backup.sh` (FLUX_UPGRADE_FROM=v0.1.0).
const run = promisify(execFile);
const migrationsDir = 'packages/db/migrations';

/** A scratch database holding what v0.1 wrote: migrations 0001 and 0002 applied, as the migrator applies them, and optionally one person. */
async function withV01Database(people: boolean, check: (url: string) => Promise<void>) {
  const scratch = `migrate_v01_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const url = new URL(connectionString);
  url.pathname = `/${scratch}`;
  // CREATE and DROP DATABASE can take longer than the 2 s request timeout on a loaded host (#916), so they run on a pool with a long one.
  const { pool: admin } = createDatabase(connectionString, undefined, { queryTimeoutMs: 60_000, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${scratch}`);
    const { pool: setup } = createDatabase(url.toString(), undefined, { queryTimeoutMs: 120_000, max: 1 });
    try {
      for (const file of ['0001_v0_1_baseline.sql', '0002_first_time_user.sql']) {
        const version = Number(file.slice(0, 4));
        await setup.query('BEGIN');
        await setup.query(await readFile(join(migrationsDir, file), 'utf8'));
        await setup.query('INSERT INTO flux_schema_version(version) VALUES ($1)', [version]);
        await setup.query('COMMIT');
      }
      assert.deepEqual(await readAppliedMigrationVersions(setup), [1, 2]);
      if (people) {
        await setup.query("INSERT INTO auth_users (id, name, email) VALUES ('v01-ada', 'Ada', 'ada@v01.example.test')");
        await setup.query("INSERT INTO workspaces (id, name, created_by) VALUES (gen_random_uuid(), 'Riverside Makers', 'v01-ada')");
      }
    } finally { await setup.end(); }
    await check(url.toString());
  } finally {
    try { await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`); } finally { await admin.end(); }
  }
}

async function migrator(url: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', ['tooling/dist/migrate.js'], { env: { ...process.env, DATABASE_URL: url }, timeout: 180_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === 'number' ? failed.code : -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

describe('Flux v0.2 and a database that v0.1 wrote (#1176)', () => {
  test('the migrator refuses a v0.1 database with a plain message and changes nothing', async () => {
    await withV01Database(true, async (url) => {
      const result = await migrator(url);
      assert.equal(result.code, 1, `the migrator must fail: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /FLUX_V01_DATABASE This database was written by Flux v0\.1 \(schema 2\)\. Flux v0\.2 does not upgrade it/);
      assert.match(result.stderr, /Install v0\.2 fresh/);
      assert.match(result.stderr, /Nothing was changed/);
      assert.doesNotMatch(result.stderr, /\n\s+at /, 'a message for the operator, not a stack trace');
      assert.doesNotMatch(result.stdout, /Applied migration/, 'no migration file ran');

      const { pool } = createDatabase(url);
      try {
        assert.deepEqual(await readAppliedMigrationVersions(pool), [1, 2], 'the ledger is as v0.1 left it');
        const company = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'company'");
        assert.equal(company.rowCount, 0, '0003 did not run, so no company column was added to a workspace that has no company');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n, 1, 'the v0.1 workspace is untouched');
      } finally { await pool.end(); }
    });
  });

  test('a first install that stopped after 0002, before anybody signed up, migrates on to the whole ledger', async () => {
    await withV01Database(false, async (url) => {
      const result = await migrator(url);
      assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Applied migration 0003_one_company_spaces\.sql/);
      assert.match(result.stdout, new RegExp(`Flux schema ${FLUX_SCHEMA_VERSION} and pg-boss ready`));
      const { pool } = createDatabase(url);
      try {
        const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
        assert.deepEqual(await readAppliedMigrationVersions(pool), manifest.map((file) => file.version));
      } finally { await pool.end(); }
    });
  });

  test('the restore gate refuses a v0.1 backup with and without --migrate, and still accepts a v0.2 ledger', async () => {
    const gate = async (ledger: string, ...flags: string[]) => {
      try {
        const { stdout } = await run('node', ['tooling/dist/operations.js', 'migration-gate', ledger, ...flags]);
        return { code: 0, stdout };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string };
        return { code: failed.code ?? -1, stdout: failed.stdout ?? '' };
      }
    };
    for (const flags of [[], ['--migrate']]) {
      const refused = await gate('1,2', ...flags);
      assert.equal(refused.code, 3, `1,2 ${flags.join(' ')}`);
      assert.match(refused.stdout, /^FLUX_MIGRATION_GATE refused the backup was written by Flux v0\.1 \(schema 2\)\. Flux v0\.2 does not restore or upgrade v0\.1 data/);
    }
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    const exact = await gate(manifest.map((file) => file.version).join(','));
    assert.equal(exact.code, 0);
    assert.match(exact.stdout, /^FLUX_MIGRATION_GATE ok /);
    const behind = await gate('1,2,3', '--migrate');
    assert.equal(behind.code, 0, 'a v0.2 backup from before the latest migration still restores with --migrate');
  });
});
