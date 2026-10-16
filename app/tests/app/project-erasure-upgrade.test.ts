import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';
import { guardFixturePool } from './support/fixture-database.js';
import { erasedWithProject, fullProject, projectReferences } from './support/project-erasure-scene.js';

// #551 / 0101: rows that exist before the upgrade are unchanged by it, and their project can then be erased.
test('a project that exists before 0101 keeps every row through the upgrade and can then be erased', { timeout: 240_000 }, async () => {
  const f = await fullProject();
  const p = f.projectId;
  const references = await projectReferences(p);
  for (const table of erasedWithProject) assert.ok(references[table]! > 0, `${table} is seeded`);
  // The search index is derived by triggers from the rows below, so it is not copied.
  const tables = Object.entries(references).filter(([table, n]) => n > 0 && table !== 'search_documents').map(([table]) => table);

  // Copy the project's actual rows, as written by the running application, into a database at schema 99.
  const dump = new Map<string, Record<string, unknown>[]>();
  for (const table of ['projects', ...tables]) {
    const column = table === 'projects' ? 'id' : 'project_id';
    dump.set(table, (await pool.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${column}=$1`, [p])).rows.map((r) => r.row));
  }
  const name = `flux_erasure_upgrade_${randomUUID().replaceAll('-', '')}`, url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  const create = { text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 };
  await pool.query(create);
  const fixture = createDatabase(url.toString()), guard = guardFixturePool(fixture.pool);
  try {
    const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
    const before = manifest.filter((m) => m.version < 101), upgrade = manifest.find((m) => m.version === 101)!;
    assert.ok(upgrade && before.length >= 80, `${before.length} earlier migrations`);
    for (const migration of before) {
      await fixture.pool.query(await readFile(`packages/db/migrations/${migration.name}`, 'utf8'));
      await fixture.pool.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [migration.version]);
    }
    const client = await fixture.pool.connect();
    try {
      // Restore only this fixture's rows; parents outside the project (people, connections) are not part of the question.
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      for (const [table, found] of dump) {
        const jsonColumns = new Set((await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND data_type IN ('json','jsonb')`, [table])).rows.map((r) => r.column_name));
        const generated = new Set((await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND is_generated='ALWAYS'`, [table])).rows.map((r) => r.column_name));
        // Only these columns were added after 0101 (0102 waiting_for_user_id); any other missing column must fail.
        const later = new Set(['waiting_for_user_id']);
        for (const row of found) {
          const columns = Object.keys(row).filter((c) => !generated.has(c) && !later.has(c));
          await client.query(`INSERT INTO "${table}"(${columns.map((c) => `"${c}"`).join(',')}) OVERRIDING SYSTEM VALUE VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
            columns.map((c) => jsonColumns.has(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const table of dump.keys()) out[table] = (await fixture.pool.query<{ v: string }>(`SELECT row_to_json(t)::text AS v FROM "${table}" t ORDER BY 1`)).rows.map((r) => r.v);
      return out;
    };
    const seeded = await snapshot();
    for (const [table, found] of dump) assert.equal(seeded[table]!.length, found.length, `${table} is restored`);

    // Before the upgrade the project cannot be erased: the receipts, grants, drafts and the rest refuse it.
    await assert.rejects(fixture.pool.query('DELETE FROM projects WHERE id=$1', [p]), { code: '23503' });

    await fixture.pool.query(await readFile(`packages/db/migrations/${upgrade.name}`, 'utf8'));
    assert.deepEqual(await snapshot(), seeded, 'the upgrade changes no row');

    const erase = await fixture.pool.connect();
    try {
      await erase.query('BEGIN');
      await erase.query('DELETE FROM projects WHERE id=$1', [p]);
      await erase.query('COMMIT');
    } catch (error) {
      await erase.query('ROLLBACK');
      throw error;
    } finally {
      erase.release();
    }
    for (const table of dump.keys())
      assert.equal((await fixture.pool.query(`SELECT count(*)::int n FROM "${table}" WHERE ${table === 'projects' ? 'id' : 'project_id'}=$1`, [p])).rows[0].n, 0, `${table} is erased`);
  } finally {
    guard.cleanup();
    await fixture.pool.end();
    const drop = { text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await pool.query(drop);
  }
  guard.assertNoEarlyErrors();
});
