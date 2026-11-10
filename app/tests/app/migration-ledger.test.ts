import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  assertExactMigrationLedger,
  assertKnownMigrationVersions,
  assertMigrationSqlLedgerChange,
  assertMigrationStepLedger,
  assertNotV01Database,
  FIRST_V02_MIGRATION,
  FLUX_SCHEMA_VERSION,
  parseMigrationManifest,
  readAppliedMigrationVersions,
  readMigrationManifest,
  V01DatabaseError,
} from '@flux/db';
import { pool } from './support/db.js';

const migrationsDir = 'packages/db/migrations';

const first = { name: '0001_first.sql', version: 1 };
const late = { name: '0015_late.sql', version: 15 };
const lowerGap = { name: '0014_lower_gap.sql', version: 14 };

describe('exact Flux migration ledger (#118)', () => {
  test('the shipped manifest starts at the v0.1 baseline, no SQL writes the ledger, and the running database agrees', async () => {
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    // #779: one baseline holds the whole v0.1 schema; later changes are 0002 onwards.
    assert.deepEqual(manifest[0], { name: '0001_v0_1_baseline.sql', version: 1 });
    for (const file of manifest) {
      const sql = await readFile(join(migrationsDir, file.name), 'utf8');
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+(public\.)?flux_schema_version/i, `${file.name} must leave the ledger to the migrator`);
    }
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(pool));
  });

  test('a pre-release development ledger is refused with the way out', () => {
    assert.throws(() => assertKnownMigrationVersions([{ name: '0001_v0_1_baseline.sql', version: 1 }], [1, 2, 3, 137]),
      /versions without files in this image: 2, 3, 137.*before the v0\.1 baseline.*\.\/flux clean/);
  });

  test('duplicate numbers, invalid SQL names and a stale highest-version constant fail before execution', () => {
    assert.throws(() => parseMigrationManifest(['0001_a.sql', '0001_b.sql'], 1), /Duplicate Flux migration version 1/);
    assert.throws(() => parseMigrationManifest(['0014_wrong-name.sql'], 14), /Invalid Flux migration filename/);
    assert.throws(() => parseMigrationManifest(['0014_lost.SQL'], 14), /Invalid Flux migration filename/);
    assert.throws(() => parseMigrationManifest(['0000_zero.sql'], 0), /Invalid Flux migration version/);
    assert.throws(() => parseMigrationManifest(['0001_a.sql'], 2), /expects latest version 2/);
  });

  test('a newly landed lower-numbered migration may fill a reserved gap after a higher one', () => {
    const before = [first, late];
    assertKnownMigrationVersions([first, lowerGap, late], [1, 15]);
    assert.throws(() => assertExactMigrationLedger([first, lowerGap, late], [1, 15]), /0014_lower_gap.sql/);
    assertMigrationSqlLedgerChange([1, 15], [1, 14, 15], lowerGap);
    assertMigrationStepLedger([1, 15], [1, 14, 15], lowerGap);
    assertExactMigrationLedger([first, lowerGap, late], [1, 14, 15]);
    assertExactMigrationLedger(before, [1, 15]);
  });

  test('phantom rows, missing files and a silently skipped file fail even if max is correct', () => {
    assert.throws(() => assertKnownMigrationVersions([first, late], [1, 14, 15]), /versions without files.*14/);
    assert.throws(() => assertExactMigrationLedger([first, late], [1, 14, 15]), /versions without files.*14/);
    assert.throws(() => assertExactMigrationLedger([first, late], [15]), /0001_first.sql/);
    assert.throws(() => assertExactMigrationLedger([first, lowerGap, late], [1, 15]), /0014_lower_gap.sql/);
  });

  test('a migration may record only its own version; wrong embedded inserts or deletions fail within a transaction', async () => {
    const client = await pool.connect();
    try {
      // A session-local ledger shadows the application ledger without changing the live stack.
      await client.query('CREATE TEMP TABLE flux_schema_version(version integer PRIMARY KEY)');
      await client.query('INSERT INTO flux_schema_version(version) VALUES (1)');
      await client.query('BEGIN');
      await client.query('INSERT INTO flux_schema_version(version) VALUES (15)');
      assertMigrationSqlLedgerChange([1], await readAppliedMigrationVersions(client), late);
      assertMigrationStepLedger([1], await readAppliedMigrationVersions(client), late);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('INSERT INTO flux_schema_version(version) VALUES (14)');
      const afterWrongSql = await readAppliedMigrationVersions(client);
      assert.throws(() => assertMigrationSqlLedgerChange([1], afterWrongSql, late), /changed unrelated ledger versions.*14/);
      await client.query('ROLLBACK');
      assert.deepEqual(await readAppliedMigrationVersions(client), [1], 'a rejected SQL migration keeps the prior ledger');
      assert.throws(() => assertMigrationSqlLedgerChange([1, 15], [15], lowerGap), /removed: 1/);
      assert.throws(() => assertMigrationStepLedger([1], [1], late), /did not record exactly/);
    } finally {
      client.release();
    }
  });
});

describe('a v0.1 database is refused (#1176)', () => {
  // A session-local copy of the two tables the rule reads shadows the application's (unqualified names, as the ledger table above).
  async function withPeople(rows: { accounts: number; workspaces: number }, check: (client: PoolClient) => Promise<void>) {
    const client = await pool.connect();
    try {
      await client.query('CREATE TEMP TABLE auth_users(id text PRIMARY KEY)');
      await client.query('CREATE TEMP TABLE workspaces(id text PRIMARY KEY)');
      for (let i = 0; i < rows.accounts; i++) await client.query('INSERT INTO auth_users(id) VALUES ($1)', [`user-${i}`]);
      for (let i = 0; i < rows.workspaces; i++) await client.query('INSERT INTO workspaces(id) VALUES ($1)', [`workspace-${i}`]);
      await check(client);
    } finally {
      client.release(true); // the temporary tables go with the session
    }
  }

  test('the first v0.2 migration is the one that adds the company', async () => {
    assert.equal(FIRST_V02_MIGRATION, 3);
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    assert.equal(manifest.find((file) => file.version === FIRST_V02_MIGRATION)?.name, '0003_one_company_spaces.sql');
    assert.match(await readFile(join(migrationsDir, '0003_one_company_spaces.sql'), 'utf8'), /ADD COLUMN company boolean NOT NULL DEFAULT false/);
  });

  test('a ledger that stops before 0003 and a database with an account or a workspace is v0.1 and is refused with the way out', async () => {
    for (const rows of [{ accounts: 1, workspaces: 1 }, { accounts: 1, workspaces: 0 }, { accounts: 0, workspaces: 1 }]) {
      await withPeople(rows, async (client) => {
        await assert.rejects(assertNotV01Database(client, [1, 2]), (error: unknown) => {
          assert.ok(error instanceof V01DatabaseError);
          assert.match(error.message, /written by Flux v0\.1 \(schema 2\)/);
          assert.match(error.message, /does not upgrade it/);
          assert.match(error.message, /no company/);
          assert.match(error.message, /Install v0\.2 fresh/);
          assert.match(error.message, /no import for v0\.1 data/);
          return true;
        }, JSON.stringify(rows));
      });
    }
  });

  test('a new database, a first install that stopped before anybody signed up and a v0.2 database are not refused', async () => {
    const never = { query: async () => { throw new Error('a ledger that cannot be v0.1 must not read the tables'); } } as unknown as Parameters<typeof assertNotV01Database>[0];
    await assertNotV01Database(never, []);
    await assertNotV01Database(never, [1, 2, 3]);
    await assertNotV01Database(never, (await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION)).map((file) => file.version));
    await withPeople({ accounts: 0, workspaces: 0 }, async (client) => {
      await assertNotV01Database(client, [1]);
      await assertNotV01Database(client, [1, 2]);
    });
    // People in a database that already ran 0003 are v0.2's.
    await withPeople({ accounts: 2, workspaces: 1 }, (client) => assertNotV01Database(client, [1, 2, 3]));
  });
});
