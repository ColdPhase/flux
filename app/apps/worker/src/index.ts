import { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import { assertExactMigrationLedger, createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest, schema } from '@flux/db';
import { deleteExpiredIdempotencyKeys, DRAFT_SUMMARY_JOB, IDEMPOTENCY_CLEANUP_JOB, processDraftSummary, SAMPLE_JOB } from '@flux/core';
import { registerPushWorker } from './push/index.js';
import { registerNotificationEmailWorker, startNotificationGenerator } from './notifications/index.js';
import { personalRunWorkerComposition, registerPersonalRunWorker } from './personal-runs/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
assertExactMigrationLedger(await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION), await readAppliedMigrationVersions(pool));
pool.on('error', (error) => console.error('Database connection interrupted', error));
const boss = new PgBoss({ connectionString, migrate: false });
boss.on('error', (error) => console.error(error));
await boss.start();
await boss.work<{ sampleId: string }>(SAMPLE_JOB, async (jobs) => {
  for (const job of jobs) {
    const [sample] = await db.select({ id: schema.samples.id }).from(schema.samples).where(eq(schema.samples.id, job.data.sampleId));
    if (!sample) throw new Error(`Sample ${job.data.sampleId} missing`);
    await db.insert(schema.sampleResults).values({ sampleId: sample.id, workerId: process.env.HOSTNAME ?? 'worker' }).onConflictDoNothing();
  }
});
await registerPushWorker(boss, db);
// Notifications from committed events and their email (#116).
const email = await registerNotificationEmailWorker(boss, db);
const generator = startNotificationGenerator({ db, boss, connectionString, emailAvailable: email.available });
// The payload is a result id only. processDraftSummary rechecks the requester's access
// before reading the draft and inside the commit transaction.
await boss.work<{ resultId: string }>(DRAFT_SUMMARY_JOB, async (jobs) => {
  for (const job of jobs) {
    const outcome = await processDraftSummary(job.data.resultId, db);
    console.log(JSON.stringify({ job: DRAFT_SUMMARY_JOB, id: job.id, resultId: job.data.resultId, outcome }));
  }
});
// Personal assistant runs (#68): the payload is a run id; every step rechecks the owner.
const personalRuns = personalRunWorkerComposition(process.env, db);
if (personalRuns.mode !== 'production') console.warn(JSON.stringify({ warning: 'TEST ONLY: personal runs use fixture connections and a mock provider', mode: personalRuns.mode }));
const personalRunRecovery = await registerPersonalRunWorker(boss, db, personalRuns);
await boss.work(IDEMPOTENCY_CLEANUP_JOB, async () => {
  const deleted = await deleteExpiredIdempotencyKeys(db);
  console.log(JSON.stringify({ job: IDEMPOTENCY_CLEANUP_JOB, deleted }));
});
// Hourly; idempotency keys are retained for 24 hours (see docs/development/access-policy.md).
await boss.schedule(IDEMPOTENCY_CLEANUP_JOB, '17 * * * *');
console.log('Flux worker ready');
const stop = async () => { await personalRunRecovery.stop(); await generator.stop(); await boss.stop(); email.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
