import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  assertExactMigrationLedger,
  assertKnownMigrationVersions,
  assertMigrationSqlLedgerChange,
  assertMigrationStepLedger,
  FLUX_SCHEMA_VERSION,
  parseMigrationManifest,
  readAppliedMigrationVersions,
  readMigrationManifest,
} from '@flux/db';
import { pool } from './support/db.js';

const migrationsDir = 'packages/db/migrations';

const first = { name: '0001_first.sql', version: 1 };
const late = { name: '0015_late.sql', version: 15 };
const lowerGap = { name: '0014_lower_gap.sql', version: 14 };

describe('exact Flux migration ledger (#118)', () => {
  test('the shipped SQL manifest, embedded versions and running database agree', async () => {
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    assert.ok(manifest.length >= 14);
    for (const file of manifest) {
      const sql = await readFile(join(migrationsDir, file.name), 'utf8');
      const embedded = [...sql.matchAll(/INSERT\s+INTO\s+flux_schema_version\s*\(version\)\s*VALUES\s*\((\d+)\)/gi)];
      assert.ok(embedded.length <= 1, `${file.name} must not write multiple ledger versions`);
      if (embedded.length) assert.equal(Number(embedded[0]![1]), file.version, `${file.name} writes a foreign ledger version`);
    }
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(pool));
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

  test('legacy self-recording is allowed; wrong embedded inserts or deletions fail within a transaction', async () => {
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
