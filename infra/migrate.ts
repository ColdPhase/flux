import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase, FLUX_SCHEMA_VERSION } from '@flux/db';
import { PgBoss } from 'pg-boss';
import { PUSH_SEND_JOB, PUSH_SEND_QUEUE } from '@flux/core';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const migrationsDir = 'packages/db/migrations';
const { pool } = createDatabase(connectionString);
try {
  // Numbered files (NNNN_name.sql) apply once, in order, each in its own transaction.
  const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['flux-migrate']);
    for (const file of files) {
      const version = Number(file.slice(0, 4));
      const table = await client.query("SELECT to_regclass('flux_schema_version') AS name");
      if (table.rows[0]?.name) {
        const applied = await client.query('SELECT 1 FROM flux_schema_version WHERE version = $1', [version]);
        if (applied.rowCount) continue;
      }
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`Applied migration ${file}`);
    }
    const current = await client.query('SELECT max(version) AS version FROM flux_schema_version');
    if (Number(current.rows[0]?.version) !== FLUX_SCHEMA_VERSION) throw new Error(`Expected Flux schema ${FLUX_SCHEMA_VERSION}, found ${current.rows[0]?.version}`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['flux-migrate']).catch(() => undefined);
    client.release();
  }
  const boss = new PgBoss({ connectionString });
  boss.on('error', (error) => console.error(error));
  await boss.start();
  await boss.createQueue('sample.process');
  // Existing queues keep their stored policy; updateQueue applies the reviewed retry bounds.
  await boss.createQueue(PUSH_SEND_JOB, PUSH_SEND_QUEUE);
  await boss.updateQueue(PUSH_SEND_JOB, PUSH_SEND_QUEUE);
  await boss.stop();
  console.log(`Flux schema ${FLUX_SCHEMA_VERSION} and pg-boss ready`);
} finally {
  await pool.end();
}
