import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss } from 'pg-boss';
import { SAMPLE_JOB, sampleRepository } from '@flux/db';
import { drainBacklogs } from '../../apps/worker/src/drain-backlogs.js';
import { connectionString, db, pool } from './support/db.js';
import { waitFor } from './support/wait.js';

// #862: a worker is woken by one NOTIFY per transaction and polls only as a backstop (a minute, #850), so the jobs a single transaction
// queues must drain back to back (apps/worker/src/drain-backlogs.ts), on every queue. The sample queue is the worker's fixture queue; a
// backlog taken one job per backstop would need 300 s for these six.

test('six jobs queued in one transaction are all processed within seconds, not one per backstop', async () => {
  const boss = new PgBoss({ connectionString, migrate: false });
  await boss.start();
  try {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const started = Date.now();
    await db.transaction(async (tx) => {
      for (const id of ids) {
        await sampleRepository(tx).create({ id, title: 'backlog', createdBy: 'drain-test', eventId: randomUUID(), outboxId: randomUUID() });
        await boss.send(SAMPLE_JOB, { sampleId: id }, { db: fromDrizzle(tx, sql) });
      }
    });
    await waitFor(async () => Number((await pool.query('SELECT count(*)::int AS n FROM sample_results WHERE sample_id = ANY($1::uuid[])', [ids])).rows[0].n) === ids.length,
      'the worker to process all six jobs', 15_000);
    assert.ok(Date.now() - started < 15_000);
  } finally {
    await boss.stop();
  }
});

test('a finished handler wakes its queue at once; a failed one rethrows and wakes it after the delay', async () => {
  const registered: { name: string; args: unknown[] }[] = [];
  const woken: string[] = [];
  const fake = {
    work: async (name: string, ...args: unknown[]) => { registered.push({ name, args }); return 'first-worker'; },
    getWipData: () => [{ id: 'one', name: 'queue.a' }, { id: 'two', name: 'queue.b' }, { id: 'three', name: 'queue.a' }],
    notifyWorker: (id: string) => { woken.push(id); },
  };
  drainBacklogs(fake as unknown as PgBoss, 40);
  const options = { localConcurrency: 4 };
  assert.equal(await (fake.work as (...args: unknown[]) => Promise<string>)('queue.a', options, async () => 'done'), 'first-worker');
  assert.equal(await (fake.work as (...args: unknown[]) => Promise<string>)('queue.a', async () => { throw new Error('boom'); }), 'first-worker');
  assert.deepEqual(registered.map((entry) => [entry.name, entry.args.length]), [['queue.a', 2], ['queue.a', 2]], 'options pass through');
  assert.deepEqual(registered[0]!.args[0], { notifyPollingIntervalSeconds: 60, localConcurrency: 4 }, 'a queue looks at itself once a minute, and keeps the options it asked for');
  assert.deepEqual(registered[1]!.args[0], { notifyPollingIntervalSeconds: 60 }, 'also when it asked for none');
  const [finished, failed] = registered.map((entry) => entry.args.at(-1) as (jobs: unknown[]) => Promise<unknown>);
  assert.equal(await finished!([{}]), 'done');
  assert.deepEqual(woken, ['one', 'three'], 'every worker of that queue, no other queue');
  await assert.rejects(failed!([{}]), /boom/);
  assert.deepEqual(woken, ['one', 'three'], 'a failure does not wake it at once');
  await waitFor(async () => woken.length === 4, 'the delayed wake-up', 2_000);
  assert.deepEqual(woken, ['one', 'three', 'one', 'three']);
});

test('failures that overlap share one pending wake-up per queue, so several workers never compound', async () => {
  const registered: ((jobs: unknown[]) => Promise<unknown>)[] = [];
  const woken: string[] = [];
  const fake = {
    work: async (_name: string, ...args: unknown[]) => { registered.push(args.at(-1) as (jobs: unknown[]) => Promise<unknown>); return 'worker'; },
    getWipData: () => [{ id: 'one', name: 'queue.a' }, { id: 'two', name: 'queue.a' }],
    notifyWorker: (id: string) => { woken.push(id); },
  };
  drainBacklogs(fake as unknown as PgBoss, 40);
  await (fake.work as (...args: unknown[]) => Promise<string>)('queue.a', async () => { throw new Error('boom'); });
  for (let failure = 0; failure < 5; failure++) await assert.rejects(registered[0]!([{}]), /boom/);
  await waitFor(async () => woken.length >= 2, 'the single wake-up', 2_000);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(woken, ['one', 'two'], 'five failures inside the delay woke the queue once, not five times');
  await assert.rejects(registered[0]!([{}]), /boom/);
  await waitFor(async () => woken.length === 4, 'a later failure schedules a new wake-up', 2_000);
});
