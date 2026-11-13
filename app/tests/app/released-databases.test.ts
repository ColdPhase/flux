import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { connectionString } from './support/db.js';

// #1241: an instance installed from any release from v0.2.0 on upgrades to any later release. `fixtures/released-databases/<tag>.sql.gz` is the
// database of a real instance of that release, seeded through its API by scripts/release/smoke_data.py (people, a guest, spaces, an encrypted
// one, threads, direct messages, files, wiki history, maps, tasks, notification settings, an API-key connection, agents with schedules and
// memory) and dumped with `pg_dump --inserts` by `FLUX_MATRIX_DUMP_DIR=… scripts/check_upgrade_matrix.sh` (docs/development/upgrade-compatibility.md).
// The real compiled migrator, as the Compose `migrate` service runs it, must take each of them to the ledger of this tree without losing a row.
// A release adds its dump after it is published; `scripts/check_upgrade_matrix.sh` runs the whole upgrade, this is the fast regression on the data.
const run = promisify(execFile);
const fixtures = 'tests/app/fixtures/released-databases';
const migrationsDir = 'packages/db/migrations';
// The tables of what people wrote, as scripts/release/smoke_artifacts.sh compares them across an upgrade.
const CONTENT_TABLES = [
  'workspaces', 'workspace_members', 'projects', 'project_grants', 'project_materials', 'project_material_versions', 'project_conversations',
  'project_messages', 'project_work_items', 'project_decisions', 'agents',
];

const releases = (await readdir(fixtures)).filter((name) => name.endsWith('.sql.gz')).sort();

/** A scratch database that holds what the release's dump holds; the check gets its URL. */
async function withReleasedDatabase(dump: string | null, check: (url: string) => Promise<void>) {
  const scratch = `released_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const url = new URL(connectionString);
  url.pathname = `/${scratch}`;
  // CREATE and DROP DATABASE can take longer than the 2 s request timeout on a loaded host (#916), so they run on a pool with a long one.
  const { pool: admin } = createDatabase(connectionString, undefined, { queryTimeoutMs: 60_000, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${scratch}`);
    if (dump) {
      const { pool: setup } = createDatabase(url.toString(), undefined, { queryTimeoutMs: 120_000, max: 1 });
      try {
        await setup.query(gunzipSync(await readFile(join(fixtures, dump))).toString('utf8'));
      } finally { await setup.end(); }
    }
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

type Pool = ReturnType<typeof createDatabase>['pool'];

async function rowCounts(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of CONTENT_TABLES) {
    const exists = await pool.query('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1', [table]);
    if (exists.rowCount) counts[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  }
  return counts;
}

describe('the migrator on a database dumped from each release (#1241)', () => {
  test('there is a dump of every release that is upgraded from', () => {
    assert.ok(releases.includes('v0.2.0.sql.gz'), `v0.2.0 is the oldest release that is upgraded; found ${releases.join(', ')}`);
  });

  for (const release of releases) {
    const tag = release.replace(/\.sql\.gz$/, '');

    test(`${tag}: the migrator takes it to this tree's ledger without losing a row, and a second run changes nothing`, async () => {
      await withReleasedDatabase(release, async (url) => {
        const { pool } = createDatabase(url, undefined, { queryTimeoutMs: 120_000, max: 1 });
        try {
          const before = await rowCounts(pool);
          const appliedBefore = await readAppliedMigrationVersions(pool);
          assert.ok(Object.keys(before).length >= 8, `the dump of ${tag} holds the content tables: ${JSON.stringify(before)}`);
          assert.ok(before.project_messages! >= 5 && before.workspace_members! >= 3, `the dump of ${tag} is a used instance: ${JSON.stringify(before)}`);
          assert.ok(appliedBefore.includes(3), `${tag} is a v0.2 database (0003 is applied)`);

          const result = await migrator(url);
          assert.equal(result.code, 0, `the migrator must succeed on ${tag}'s data: ${result.stdout}${result.stderr}`);
          const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
          const applied = await readAppliedMigrationVersions(pool);
          assert.deepEqual(applied, manifest.map((file) => file.version), 'the ledger is exactly the files of this tree');
          for (const version of appliedBefore) assert.ok(applied.includes(version), `ledger row ${version} of ${tag} is still there`);
          const after = await rowCounts(pool);
          for (const [table, count] of Object.entries(before)) assert.ok(after[table]! >= count, `${table}: ${count} rows of ${tag} became ${after[table]}`);

          const again = await migrator(url);
          assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
          assert.doesNotMatch(again.stdout, /Applied migration/, 'the second run applies nothing');
          assert.deepEqual(await rowCounts(pool), after);
        } finally { await pool.end(); }
      });
    });

    test(`${tag}: an agent or local app left on "Only read" is Ask me first after the upgrade, and "Only read" can no longer be stored (#1419)`, async () => {
      await withReleasedDatabase(release, async (url) => {
        const { pool } = createDatabase(url, undefined, { queryTimeoutMs: 120_000, max: 1 });
        try {
          // The release's own CHECK still allows 'read': one connection is left on it, one on each other value, as a v0.2 instance can hold them.
          const rows = (await pool.query('SELECT id FROM agent_connections ORDER BY id')).rows as { id: string }[];
          assert.ok(rows.length >= 2, `the dump of ${tag} holds agent connections`);
          const [reader, asker] = rows;
          await pool.query("UPDATE agent_connections SET may_do = 'read' WHERE id = $1", [reader!.id]);
          await pool.query("UPDATE agent_connections SET may_do = 'ask' WHERE id = $1", [asker!.id]);
          const before = Object.fromEntries((await pool.query('SELECT id, may_do FROM agent_connections')).rows.map((row) => [row.id, row.may_do]));
          const result = await migrator(url);
          assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
          const after = Object.fromEntries((await pool.query('SELECT id, may_do FROM agent_connections')).rows.map((row) => [row.id, row.may_do]));
          assert.equal(after[reader!.id], 'ask', 'Only read becomes Ask me first (the AG-3 mapping)');
          for (const [id, value] of Object.entries(before)) if (id !== reader!.id) assert.equal(after[id], value, `${id} keeps ${value}`);
          await assert.rejects(pool.query("UPDATE agent_connections SET may_do = 'read' WHERE id = $1", [asker!.id]), /agent_connections_may_do_check/);
        } finally { await pool.end(); }
      });
    });

    test(`${tag}: a migration that works on an empty database and fails on this data is caught (negative control)`, async () => {
      const breaking = 'ALTER TABLE project_messages ADD CONSTRAINT upgrade_check_no_messages CHECK (false)';
      await withReleasedDatabase(null, async (emptyUrl) => {
        assert.equal((await migrator(emptyUrl)).code, 0);
        const { pool: empty } = createDatabase(emptyUrl, undefined, { queryTimeoutMs: 60_000, max: 1 });
        try {
          await empty.query(breaking); // an empty database accepts it: only data left by a release can show that it is wrong
        } finally { await empty.end(); }
      });
      await withReleasedDatabase(release, async (url) => {
        assert.equal((await migrator(url)).code, 0);
        const { pool } = createDatabase(url, undefined, { queryTimeoutMs: 60_000, max: 1 });
        try {
          await assert.rejects(pool.query(breaking), /upgrade_check_no_messages.*violated by some row/);
        } finally { await pool.end(); }
      });
    });
  }
});
