import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { createDatabase, holdingSessionLock, SessionLockLostError, withRuntimeReconcileLock } from '@flux/db';
import { connectionString, pool as admin } from './support/db.js';

// A session advisory lock lives and dies with its connection (#916). The holder's connection is idle while it works, so a restart, a
// failover or a killed backend ends it unseen and the server hands the lock to whoever asks next, while the holder still believes it
// has it. These tests kill the holder's real backend and follow what the holder and a rival see.

const CLASS = 77_001;
const lockOf = (key: string) => ({
  acquire: { text: 'SELECT pg_advisory_lock($1, hashtext($2))', values: [CLASS, key] },
  release: { text: 'SELECT pg_advisory_unlock($1, hashtext($2))', values: [CLASS, key] },
});
const tryLockOf = (key: string) => ({ try: true as const,
  acquire: { text: 'SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', values: [CLASS, key] },
  release: { text: 'SELECT pg_advisory_unlock($1, hashtext($2))', values: [CLASS, key] } });
/** The backend that holds the lock now. */
const holder = async (classId: number, key: string) => (await admin.query<{ pid: number }>(
  `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid::bigint = (hashtext($2)::bigint & 4294967295) AND granted`, [classId, key])).rows[0]?.pid ?? null;
const kill = async (pid: number) => { await admin.query('SELECT pg_terminate_backend($1)', [pid]); };
/** A rival can take the lock: the server has dropped the holder's. */
const rivalTakes = async (classId: number, key: string) => {
  for (let i = 0; i < 50; i++) {
    const { rows } = await admin.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [classId, key]);
    if (rows[0]!.ok) { await admin.query('SELECT pg_advisory_unlock($1, hashtext($2))', [classId, key]); return true; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a session lock holder is told when its connection dies (#916)', () => {
  const database = createDatabase(connectionString, undefined, { onError: () => undefined });
  after(async () => { await database.pool.end(); });

  test('work runs under the lock and the lock is given back', async () => {
    const key = randomUUID();
    const seen = await holdingSessionLock(database.pool, lockOf(key), async () => ({ pid: await holder(CLASS, key) }));
    assert.ok(seen.pid, 'the lock was held while it worked');
    assert.equal(await holder(CLASS, key), null, 'and is gone after');
    const tried = await holdingSessionLock(database.pool, tryLockOf(key), async () => 'ran');
    assert.equal(tried, 'ran');
  });

  test('a try-lock held by someone else answers null and runs nothing', async () => {
    const key = randomUUID();
    let release: () => void = () => undefined;
    const holding = holdingSessionLock(database.pool, tryLockOf(key), () => new Promise<string>((resolve) => { release = () => resolve('first'); }));
    for (let i = 0; i < 50 && !(await holder(CLASS, key)); i++) await settle(20);
    let ran = false;
    assert.equal(await holdingSessionLock(database.pool, tryLockOf(key), async () => { ran = true; return 'second'; }), null);
    assert.equal(ran, false);
    release();
    assert.equal(await holding, 'first');
  });

  test('when its connection dies the holder\'s work is aborted and its call rejects, while a rival takes the lock', async () => {
    const key = randomUUID();
    let aborted: unknown = null;
    let finished = false;
    const outcome = holdingSessionLock(database.pool, lockOf(key), (signal) => new Promise<string>((resolve) => {
      signal.addEventListener('abort', () => { aborted = signal.reason; });
      // The work goes on a while after the loss: its end is nobody's to hear.
      setTimeout(() => { finished = true; resolve('too late'); }, 600);
    })).then(() => null, (error: unknown) => error);
    let pid: number | null = null;
    for (let i = 0; i < 50 && !pid; i++) { pid = await holder(CLASS, key); await settle(20); }
    assert.ok(pid, 'the holder has the lock');
    await kill(pid);
    const error = await outcome;
    assert.ok(error instanceof SessionLockLostError, String(error));
    assert.ok(aborted instanceof SessionLockLostError, 'and the work was told, to stop at its next step');
    assert.equal(finished, false, 'the caller did not wait for the work to end');
    assert.equal(await rivalTakes(CLASS, key), true, 'the server gave the lock to a rival');
    await settle(700);
    // The dead connection was destroyed, not given back: the pool serves the next query.
    assert.equal((await database.pool.query('SELECT 1 AS one')).rows[0].one, 1);
  });

  test('the reconcile lock of the worker is the same: a killed connection aborts the reconciliation', async () => {
    let seen: AbortSignal | null = null;
    const outcome = withRuntimeReconcileLock(database.pool, (signal) => { seen = signal; return new Promise<string>((resolve) => setTimeout(() => resolve('done'), 800)); })
      .then(() => null, (error: unknown) => error);
    let pid: number | null = null;
    for (let i = 0; i < 50 && !pid; i++) { pid = (await admin.query<{ pid: number }>(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND granted
      AND ((classid::bigint << 32) | objid::bigint) = hashtext('agent-runtime-reconcile')::bigint`)).rows[0]?.pid ?? null; await settle(20); }
    assert.ok(pid, 'the worker holds the reconcile lock');
    await kill(pid);
    assert.ok((await outcome) instanceof SessionLockLostError);
    assert.equal(seen!.aborted, true);
    await settle(900);
  });
});
