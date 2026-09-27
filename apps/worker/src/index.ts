import { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import { createDatabase, schema } from '@flux/db';
import { SAMPLE_JOB } from '@flux/core';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
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
console.log('Flux worker ready');
const stop = async () => { await boss.stop(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
