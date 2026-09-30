import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExactMigrationLedger, assertKnownMigrationVersions, assertMigrationSqlLedgerChange, assertMigrationStepLedger, createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { PgBoss } from 'pg-boss';
import { NOTIFICATION_EMAIL_JOB, NOTIFICATION_EMAIL_QUEUE, PERSONAL_RUN_JOB, PERSONAL_RUN_QUEUE, PUSH_SEND_JOB, PUSH_SEND_QUEUE } from '@flux/core';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const migrationsDir = 'packages/db/migrations';
const { pool } = createDatabase(connectionString);
try {
  // Numbered files (NNNN_name.sql) apply once, in order, each in its own transaction.
  const files = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['flux-migrate']);
    let applied = await readAppliedMigrationVersions(client);
    assertKnownMigrationVersions(files, applied);
    for (const file of files) {
      if (applied.includes(file.version)) continue;
      const sql = await readFile(join(migrationsDir, file.name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        assertMigrationSqlLedgerChange(applied, await readAppliedMigrationVersions(client), file);
        await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
        const after = await readAppliedMigrationVersions(client);
        assertMigrationStepLedger(applied, after, file);
        await client.query('COMMIT');
        applied = after;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`Applied migration ${file.name}`);
    }
    assertExactMigrationLedger(files, await readAppliedMigrationVersions(client));
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['flux-migrate']).catch(() => undefined);
    client.release();
  }
  const boss = new PgBoss({ connectionString });
  boss.on('error', (error) => console.error(error));
  await boss.start();
  for (const queue of ['sample.process', 'draft.summarize.v1', 'idempotency.cleanup.v1']) {
    await boss.createQueue(queue);
  }
  // Existing queues keep their stored policy; updateQueue applies the reviewed retry bounds.
  await boss.createQueue(PUSH_SEND_JOB, PUSH_SEND_QUEUE);
  await boss.updateQueue(PUSH_SEND_JOB, PUSH_SEND_QUEUE);
  await boss.createQueue(NOTIFICATION_EMAIL_JOB, NOTIFICATION_EMAIL_QUEUE);
  await boss.updateQueue(NOTIFICATION_EMAIL_JOB, NOTIFICATION_EMAIL_QUEUE);
  await boss.createQueue(PERSONAL_RUN_JOB, PERSONAL_RUN_QUEUE);
  await boss.updateQueue(PERSONAL_RUN_JOB, PERSONAL_RUN_QUEUE);
  await boss.stop();
  console.log(`Flux schema ${FLUX_SCHEMA_VERSION} and pg-boss ready`);
} finally {
  await pool.end();
}
