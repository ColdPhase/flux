import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aiPriceListRepository, assertExactMigrationLedger, assertKnownMigrationVersions, assertMigrationSqlLedgerChange, assertMigrationStepLedger, assertNotV01Database, createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest, V01DatabaseError } from '@flux/db';
import { PgBoss } from 'pg-boss';
import { AI_PRICE_LIST_JOB, API_KEY_MODEL_LIST_JOB, SEARCH_CHANGES_CLEANUP_JOB, SPACE_AI_SWEEP_JOB, WORKSPACE_ENCRYPTION_RESUME_JOB } from '@flux/contracts';
import { ASSISTANT_TICK_JOB, ASSISTANT_TICK_QUEUE, ASSISTANT_TICK_RETRY, NOTIFICATION_EMAIL_JOB, NOTIFICATION_EMAIL_QUEUE, PERSONAL_RUN_JOB, PERSONAL_RUN_QUEUE, PUSH_SEND_JOB, PUSH_SEND_QUEUE, shippedPriceList } from '@flux/core';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const migrationsDir = 'packages/db/migrations';
// A migration file is one statement that runs as long as the host needs: the v0.1 baseline takes 3 s on a slow disk or arm64 VPS (#846).
// The 2 s request timeout of the API's and worker's pools would roll it back on every retry, so the migrator has its own, long bound.
const MIGRATION_QUERY_TIMEOUT_MS = 30 * 60_000;
const { pool, db } = createDatabase(connectionString, undefined, { queryTimeoutMs: MIGRATION_QUERY_TIMEOUT_MS });
try {
  // Numbered files (NNNN_name.sql) apply once, in order, each in its own transaction. 0001 is the
  // v0.1 baseline (#779): the whole schema of a fresh install; later changes are 0002 onwards.
  const files = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['flux-migrate']);
    let applied = await readAppliedMigrationVersions(client);
    assertKnownMigrationVersions(files, applied);
    // v0.1 had no users and v0.2 converts nothing (#1176): a v0.1 database is refused before any file runs.
    await assertNotV01Database(client, applied);
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
  // Every queue wakes its worker by NOTIFY when a job is ready (the worker listens, #862), so the worker only polls as a backstop.
  // Existing queues keep their stored policy; updateQueue applies the reviewed retry bounds and the wake-up to them too.
  const wake = { notify: true };
  for (const queue of ['sample.process', 'draft.summarize.v1', 'idempotency.cleanup.v1']) {
    await boss.createQueue(queue, wake);
    await boss.updateQueue(queue, wake);
  }
  await boss.createQueue(PUSH_SEND_JOB, { ...PUSH_SEND_QUEUE, ...wake });
  await boss.updateQueue(PUSH_SEND_JOB, { ...PUSH_SEND_QUEUE, ...wake });
  await boss.createQueue(NOTIFICATION_EMAIL_JOB, { ...NOTIFICATION_EMAIL_QUEUE, ...wake });
  await boss.updateQueue(NOTIFICATION_EMAIL_JOB, { ...NOTIFICATION_EMAIL_QUEUE, ...wake });
  await boss.createQueue(PERSONAL_RUN_JOB, { ...PERSONAL_RUN_QUEUE, ...wake });
  await boss.updateQueue(PERSONAL_RUN_JOB, { ...PERSONAL_RUN_QUEUE, ...wake });
  // "On a schedule" (F-027 A8): the per-minute tick is one active job at a time across workers.
  await boss.createQueue(ASSISTANT_TICK_JOB, { ...ASSISTANT_TICK_QUEUE, ...wake });
  await boss.updateQueue(ASSISTANT_TICK_JOB, { ...ASSISTANT_TICK_RETRY, ...wake });
  // AG-10: the turn-off sweep, retried so a lost job cannot leave queued AI work behind (the sweep is idempotent).
  await boss.createQueue(SPACE_AI_SWEEP_JOB, { retryLimit: 5, retryDelay: 5, ...wake });
  await boss.updateQueue(SPACE_AI_SWEEP_JOB, { retryLimit: 5, retryDelay: 5, ...wake });
  // F-030: sent with every unlock of an encrypted workspace; replays the work that waited while it was locked.
  await boss.createQueue(WORKSPACE_ENCRYPTION_RESUME_JOB, { retryLimit: 5, retryDelay: 5, ...wake });
  await boss.updateQueue(WORKSPACE_ENCRYPTION_RESUME_JOB, { retryLimit: 5, retryDelay: 5, ...wake });
  // F-030 S2b: prunes the search change log of encrypted workspaces.
  await boss.createQueue(SEARCH_CHANGES_CLEANUP_JOB, wake);
  await boss.updateQueue(SEARCH_CHANGES_CLEANUP_JOB, wake);
  // #1218: a stored key's models, read by the worker. One waiting job per key (`short` with the key's id as singletonKey); Try again
  // waits for it, so it is not retried.
  await boss.createQueue(API_KEY_MODEL_LIST_JOB, { policy: 'short', retryLimit: 0, ...wake });
  await boss.updateQueue(API_KEY_MODEL_LIST_JOB, { retryLimit: 0, ...wake });
  // #1465: Flux's price list, fetched daily by the worker; a failed fetch is tried again three times, 15 minutes apart.
  await boss.createQueue(AI_PRICE_LIST_JOB, { policy: 'singleton', retryLimit: 3, retryDelay: 900, ...wake });
  await boss.updateQueue(AI_PRICE_LIST_JOB, { retryLimit: 3, retryDelay: 900, ...wake });
  await boss.stop();
  // The price list this release ships (#1465): stored when the database has none or one fetched before it, so a server without internet
  // prices with it from its first start.
  if (await aiPriceListRepository(db).store(shippedPriceList(), 'keep')) console.log(`Stored the shipped price list of ${shippedPriceList().fetchedOn}`);
  console.log(`Flux schema ${FLUX_SCHEMA_VERSION} and pg-boss ready`);
} catch (error) {
  // The refusal is a message for the operator, not a stack trace.
  if (!(error instanceof V01DatabaseError)) throw error;
  console.error(`FLUX_V01_DATABASE ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
