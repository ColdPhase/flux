import type { Pool } from 'pg';
import { sql, type SQL } from 'drizzle-orm';

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
