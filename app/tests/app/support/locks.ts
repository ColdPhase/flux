import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { sql, type SQL } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '@flux/core';

/** Anything with drizzle's `execute`: a database handle or an open transaction. */
interface Executes {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

/** Backend pid of the PostgreSQL session running `tx`. */
export async function backendPid(tx: Executes): Promise<number> {
  const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  return Number((result.rows[0] as { pid: number }).pid);
}

/** Resolves once another session is waiting on a lock held by backend `holder`; no timing assumptions. */
export async function waitUntilBlockedBy(pool: Pool, holder: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holder]);
    if (result.rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No session became blocked by backend ${holder}`);
}

/** Returns a function that tells whether `promise` has settled yet. */
export function settled(promise: Promise<unknown>) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

/** A promise with its resolver, for test barriers. */
export function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Runs `first` inside a transaction on one pooled connection and keeps that transaction open after `first`
 * finished; then runs `second` on another connection, asserts that it is blocked by the first transaction's
 * locks, and finally commits the first. Returns the outcomes of both. Two real PostgreSQL sessions, no timing
 * assumptions.
 */
export async function interleave<A, B>(db: DatabaseHandle, pool: Pool, first: (tx: Database) => Promise<A>, second: () => Promise<B>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready!: (pid: number) => void;
  const holding = new Promise<number>((resolve) => { ready = resolve; });
  const outer = db.transaction(async (tx) => {
    const result = await first(tx as unknown as Database);
    ready(await backendPid(tx));
    await gate;
    return result;
  });
  outer.catch(() => ready(-1));
  const holder = await holding;
  if (holder < 0) await outer; // surfaces the error of `first`
  const later = second();
  const laterDone = settled(later);
  await waitUntilBlockedBy(pool, holder);
  assert.equal(laterDone(), false, 'the second session waits for the first transaction');
  release();
  const firstResult = await outer;
  const secondResult = await later.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }));
  return { firstResult, secondResult };
}
