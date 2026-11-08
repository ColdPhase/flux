import type { Pool, PoolClient } from 'pg';

/**
 * The connection that held a session lock failed (#916). PostgreSQL drops a session advisory lock with its session, so from that moment
 * another process may hold the lock while this one still believes it does.
 */
export class SessionLockLostError extends Error {
  constructor(cause?: unknown, private readonly work: { ended: Promise<void> } = { ended: Promise.resolve() }) {
    super('The connection holding a session lock was lost', { cause });
    this.name = 'SessionLockLostError';
  }
  /**
   * Settles when the work the lock protected has stopped (at its next checkpoint, or because it finished). The caller was told of the
   * loss at once and does not wait for it; one that must not start the same work again meanwhile, such as a timer, waits for this.
   */
  get abandoned(): Promise<void> { return this.work.ended; }
}

export interface SessionLock {
  /** The statement that takes the lock. With `try`, it must return a row with `ok`; otherwise it waits for the lock. */
  acquire: { text: string; values?: unknown[] };
  /** The statement that gives it back. */
  release: { text: string; values?: unknown[] };
  /** `pg_try_advisory_lock`: another holder means `null`, not a wait. */
  try?: boolean;
}

/**
 * Runs `work` while this process holds a session advisory lock on one pooled connection, so two processes never work at once. The
 * connection is idle while `work` runs, so a database restart, a failover or a killed backend ends it unseen, and the lock with it.
 * Then the caller's promise rejects at once with {@link SessionLockLostError} and `signal` aborts, so `work` can stop at its next
 * step (`signal.throwIfAborted()`); it is not left going on as if it still held the lock. The broken connection is destroyed and not
 * given back to the pool. Null when `try` was asked and another process holds the lock.
 *
 * `work` is also given the lock's own connection. A statement run on it can only succeed while the session, and so the lock, is alive:
 * a transaction there that was cut off by the loss is rolled back by the server, so it never commits after the lock is gone. Work that
 * must not overlap the next holder by even one step runs its writes on it; a write on another connection can still commit once.
 */
export function holdingSessionLock<T>(pool: Pick<Pool, 'connect'>, lock: SessionLock & { try?: false }, work: (signal: AbortSignal, connection: PoolClient) => Promise<T>): Promise<T>;
export function holdingSessionLock<T>(pool: Pick<Pool, 'connect'>, lock: SessionLock & { try: true }, work: (signal: AbortSignal, connection: PoolClient) => Promise<T>): Promise<T | null>;
export async function holdingSessionLock<T>(pool: Pick<Pool, 'connect'>, lock: SessionLock, work: (signal: AbortSignal, connection: PoolClient) => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  const controller = new AbortController();
  let broken: Error | null = null;
  let reject: (error: Error) => void = () => undefined;
  const lost = new Promise<never>((_, fail) => { reject = fail; });
  // Settles when `work` has ended; an error made before `work` began says it ended already.
  const workState = { ended: Promise.resolve() as Promise<void> };
  lost.catch(() => undefined);
  const onError = (error: Error) => {
    if (broken) return;
    broken = new SessionLockLostError(error, workState);
    controller.abort(broken);
    reject(broken);
  };
  client.on('error', onError);
  try {
    const taken = await Promise.race([client.query<{ ok?: boolean }>(lock.acquire.text, lock.acquire.values), lost]);
    if (lock.try && !taken.rows[0]?.ok) return null;
    const running = work(controller.signal, client);
    // If the lock is lost first, whatever `work` ends with later is nobody's to hear.
    workState.ended = running.then(() => undefined, () => undefined);
    return await Promise.race([running, lost]);
  } catch (error) {
    // A failed statement on the lock's own connection (a lost connection among them) leaves it unfit to give back.
    if (!broken && error instanceof Error && String((error as { code?: unknown }).code).startsWith('57')) broken = error;
    throw error;
  } finally {
    if (!broken) await client.query(lock.release.text, lock.release.values).catch((error: Error) => { broken = error; });
    client.removeListener('error', onError);
    client.release(broken ?? undefined);
  }
}
