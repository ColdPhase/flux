import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { createSample } from '@flux/core';
import { createDatabase, schema } from '@flux/db';
import { SAMPLE_COMMAND_PATH } from '@flux/contracts';
import { Browser } from './support/http.js';

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
    // Only sample rows are counted: other test files write access events concurrently.
    const before = await pool.query('SELECT (SELECT count(*) FROM samples)::int AS samples, (SELECT count(*) FROM events WHERE kind = \'sample.created.v1\')::int AS events, (SELECT count(*) FROM outbox)::int AS outbox, (SELECT count(*) FROM pgboss.job)::int AS jobs');
    await assert.rejects(createSample({ id: 'test-principal', kind: 'fixture' }, { title: 'rollback sentinel' }, db, boss, true), /Forced rollback/);
    const after = await pool.query('SELECT (SELECT count(*) FROM samples)::int AS samples, (SELECT count(*) FROM events WHERE kind = \'sample.created.v1\')::int AS events, (SELECT count(*) FROM outbox)::int AS outbox, (SELECT count(*) FROM pgboss.job)::int AS jobs');
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    await boss.stop();
    await pool.end();
  }
});

test('test deployment failure header rolls back; the public command body rejects failure flags', async () => {
  const token = process.env.FLUX_FIXTURE_TOKEN;
  if (!token) throw new Error('FLUX_FIXTURE_TOKEN is required');
  const { pool } = createDatabase(connectionString);
  const browser = new Browser();
  const headers = { authorization: `Bearer ${token}`, 'x-flux-test-failure': 'after-insert' };
  try {
    const before = await pool.query('SELECT (SELECT count(*) FROM samples)::int AS samples, (SELECT count(*) FROM events)::int AS events, (SELECT count(*) FROM outbox)::int AS outbox, (SELECT count(*) FROM pgboss.job)::int AS jobs');
    const failure = await browser.request('POST', SAMPLE_COMMAND_PATH, { headers, body: { title: 'rollback over HTTP' } });
    assert.equal(failure.status, 409);
    const rejected = await browser.request('POST', SAMPLE_COMMAND_PATH, { headers, body: { title: 'invalid public flag', failAfterInsert: true } });
    assert.equal(rejected.status, 400);
    const after = await pool.query('SELECT (SELECT count(*) FROM samples)::int AS samples, (SELECT count(*) FROM events)::int AS events, (SELECT count(*) FROM outbox)::int AS outbox, (SELECT count(*) FROM pgboss.job)::int AS jobs');
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    await pool.end();
  }
});
