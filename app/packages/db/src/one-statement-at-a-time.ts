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
 * stop the ones behind it, and the statement's own result or error reaches only its caller, with one exception: when a statement times
 * out (`query_timeout`) it may still be running on the server, so the ones waiting behind it fail with it at once. Left to wait their
 * turn they would each time out in turn (2, 4, 6 seconds ...), and a transaction with one hung statement would give up at the sum.
 */
export function oneStatementAtATime(client: pg.ClientBase): void {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  const waiting: { args: unknown[]; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  let running = false;
  const pump = () => {
    const next = waiting.shift();
    if (!next) { running = false; return; }
    running = true;
    let answer: Promise<unknown>;
    try { answer = Promise.resolve(query(...next.args)); } catch (error) { answer = Promise.reject(error); }
    answer.then(next.resolve, (error) => {
      next.reject(error);
      if (error instanceof Error && error.message === 'Query read timeout') for (const behind of waiting.splice(0)) behind.reject(error);
    }).then(pump);
  };
  client.query = function serialized(...args: unknown[]): unknown {
    const first = args[0] as { submit?: unknown } | string | undefined;
    if (typeof args[args.length - 1] === 'function' || (first !== null && typeof first === 'object' && typeof first.submit === 'function')) return query(...args);
    return new Promise((resolve, reject) => {
      waiting.push({ args, resolve, reject });
      if (!running) pump();
    });
  } as typeof client.query;
}
