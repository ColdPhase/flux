import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createDatabase, holdingSessionLock, SessionLockLostError, sql, withRuntimeReconcileLock } from '@flux/db';
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
    // A caller that must not start the same work again meanwhile (the worker's timer) waits for the abandoned work to stop.
    await (error as SessionLockLostError).abandoned;
    assert.equal(finished, true, 'and `abandoned` settles when it has');
    assert.equal(await rivalTakes(CLASS, key), true, 'the server gave the lock to a rival');
    await settle(700);
    // The dead connection was destroyed, not given back: the pool serves the next query.
    assert.equal((await database.pool.query('SELECT 1 AS one')).rows[0].one, 1);
  });

  test('a write on the lock\'s own connection that the loss cuts off is rolled back, never committed (#961)', async () => {
    const table = `session_lock_probe_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE TABLE ${table} (n int)`);
    try {
      const key = randomUUID();
      let commit = 'not tried';
      const outcome = await holdingSessionLock(database.pool, lockOf(key), async (_signal, connection) => {
        await connection.query('BEGIN');
        await connection.query(`INSERT INTO ${table} VALUES (1)`);
        // The lock's connection is cut off in the middle of the step, as a restart or a failover would.
        await kill((await holder(CLASS, key))!);
        await settle(100);
        commit = await connection.query('COMMIT').then(() => 'committed', () => 'refused');
        return 'went on';
      }).then(() => null, (error: unknown) => error);
      assert.ok(outcome instanceof SessionLockLostError);
      await outcome.abandoned;
      assert.equal(commit, 'refused', 'the commit on the dead connection fails');
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, 'and the write is not there');
      // A write on another connection of the pool, by contrast, is its own transaction: it commits whatever happened to the lock.
      await database.pool.query(`INSERT INTO ${table} VALUES (2)`);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
    } finally { await admin.query(`DROP TABLE ${table}`); }
  });

  test('work that fails after a statement timed out never gives the lock\'s connection back inside its open transaction (#961)', async () => {
    // A statement on the lock's connection that outlasts `query_timeout` makes pg drop the ROLLBACK queued behind it, unsent; the
    // transaction is then still open on the server when the lock is given up. Handing that connection to the pool would give the next
    // borrower an old transaction with a half-done write in it.
    const table = `session_lock_timeout_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE TABLE ${table} (n int)`);
    const quick = createDatabase(connectionString, undefined, { onError: () => undefined, queryTimeoutMs: 300, max: 1 });
    try {
      let heldPid = 0;
      const outcome = await holdingSessionLock(quick.pool, lockOf(randomUUID()), async (_signal, connection) => {
        heldPid = (await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await drizzle({ client: connection }).transaction(async (tx) => {
          await tx.execute(sql.raw(`INSERT INTO ${table} VALUES (1)`));
          await tx.execute(sql.raw('SELECT pg_sleep(0.75)'));
        });
      }).then(() => null, (error: unknown) => error);
      assert.ok(outcome instanceof Error && !(outcome instanceof SessionLockLostError), `the work failed on the timeout: ${String(outcome)}`);
      // The next borrower of the one-connection pool gets a connection of its own, outside any transaction, that does not see the row.
      const next = await quick.pool.connect();
      try {
        const seen = (await next.query<{ pid: number; rows: number; clean: boolean }>(
          `SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM ${table}) AS rows, pg_current_xact_id_if_assigned() IS NULL AS clean`)).rows[0]!;
        assert.notEqual(seen.pid, heldPid, 'not the connection the lock was held on');
        assert.deepEqual([seen.rows, seen.clean], [0, true], 'and it is outside the old transaction');
      } finally { next.release(); }
      await settle(900);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, 'the half-done write never committed');
    } finally {
      await quick.pool.end();
      await admin.query(`DROP TABLE ${table}`);
    }
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
