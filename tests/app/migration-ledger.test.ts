import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION } from '@flux/db';

const migrationsDir = 'packages/db/migrations';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

test('migration ledger records exactly the numbered files, including reserved gaps', async () => {
  const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const versions = files.map((file) => Number(file.slice(0, 4)));
  assert.equal(versions.at(-1), FLUX_SCHEMA_VERSION);
  for (const [index, file] of files.entries()) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const embedded = [...sql.matchAll(/INSERT\s+INTO\s+flux_schema_version\s*\(version\)\s*VALUES\s*\((\d+)\)/gi)];
    assert.ok(embedded.length <= 1, `${file} must not write multiple ledger versions`);
    if (embedded.length) assert.equal(Number(embedded[0]![1]), versions[index], `${file} writes a foreign ledger version`);
  }
  const result = await pool.query<{ version: number }>('SELECT version FROM flux_schema_version ORDER BY version');
  assert.deepEqual(result.rows.map((row) => Number(row.version)), versions,
    'a fresh migration run must not mark reserved or future versions as applied');
});
