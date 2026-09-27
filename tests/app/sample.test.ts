import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { createSample } from '@flux/core';
import { createDatabase, schema } from '@flux/db';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

test('sample command commits a domain row, event, outbox and queued job atomically', async () => {
  const { db, pool } = createDatabase(connectionString);
  const boss = new PgBoss({ connectionString, migrate: false });
  await boss.start();
  try {
    const command = await createSample({ id: 'test-principal', kind: 'fixture' }, { title: 'atomic sample' }, db, boss);
    assert.equal((await db.select().from(schema.samples).where(eq(schema.samples.id, command.id))).length, 1);
    assert.equal((await db.select().from(schema.events).where(eq(schema.events.id, command.eventId))).length, 1);
    assert.equal((await db.select().from(schema.outbox).where(eq(schema.outbox.eventId, command.eventId))).length, 1);
    assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id = $1', [command.jobId])).rowCount, 1);
  } finally {
    await boss.stop();
    await pool.end();
  }
});

test('forced failure after insert leaves no domain row or related job', async () => {
  const { db, pool } = createDatabase(connectionString);
  const boss = new PgBoss({ connectionString, migrate: false });
  await boss.start();
  try {
    const before = await pool.query('SELECT (SELECT count(*) FROM samples)::int AS samples, (SELECT count(*) FROM events)::int AS events, (SELECT count(*) FROM outbox)::int AS outbox, (SELECT count(*) FROM pgboss.job)::int AS jobs');
    await assert.rejects(createSample({ id: 'test-principal', kind: 'fixture' }, { title: 'rollback sentinel', failAfterInsert: true }, db, boss), /Forced rollback/);
    const after = await pool.query('SELECT (SELECT count(*) FROM samples)::int AS samples, (SELECT count(*) FROM events)::int AS events, (SELECT count(*) FROM outbox)::int AS outbox, (SELECT count(*) FROM pgboss.job)::int AS jobs');
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    await boss.stop();
    await pool.end();
  }
});
