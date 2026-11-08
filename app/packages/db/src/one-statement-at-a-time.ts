import type pg from 'pg';

/**
 * Makes a pool's connection run one statement at a time, in the order they were asked for (#916).
 *
 * `pg` 8 queues a statement issued while another is running on the same connection and, since 8.23, warns that this "is deprecated and
 * will be removed in pg@9.0". The queue is what `Promise.all` over a transaction's `tx` reaches (a presenter reading links, names and a
 * plan at once, for one): the statements cannot run in parallel on one connection anyway, so the order is the same as it ever was. Here
 * the wait is Flux's own and `pg` is never asked while it is busy, so the warning has nothing to say and pg 9 changes nothing.
 *
 * Statements with a callback and `Submittable`s (cursors, streams) keep `pg`'s own path; Flux issues none. A failed statement does not
 * stop the ones behind it, and the statement's own result or error reaches only its caller.
 */
export function oneStatementAtATime(client: pg.ClientBase): void {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  client.query = function serialized(...args: unknown[]): unknown {
    const first = args[0] as { submit?: unknown } | string | undefined;
    if (typeof args[args.length - 1] === 'function' || (first !== null && typeof first === 'object' && typeof first.submit === 'function')) return query(...args);
    const start = (): Promise<unknown> => { try { return Promise.resolve(query(...args)); } catch (error) { return Promise.reject(error); } };
    // Nothing is running or waiting: ask `pg` at once, so the common case costs nothing and keeps its stack.
    const run = waiting === 0 ? start() : tail.then(start);
    waiting++;
    tail = run.then(() => undefined, () => undefined).finally(() => { waiting--; });
    return run;
  } as typeof client.query;
}
