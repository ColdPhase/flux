import type pg from 'pg';

/**
 * A COMMIT is waited for longer than other statements. Once it is sent its outcome cannot be learned any other way: given up at the read
 * timeout, the server still commits, the ROLLBACK sent after it finds no transaction ("WARNING: there is no transaction in progress"), and
 * the caller is told a stored write failed, a 500 for a message or a conversation that was saved and is then sent again. On a database
 * whose commits took 2 to 5 s (a CI runner, #1389) that answered writes with 500 that had been stored.
 */
export const COMMIT_TIMEOUT_MS = 15_000;
const COMMIT = /^\s*commit\s*;?\s*$/i;

/** The statement's arguments, with the longer read timeout when it is a COMMIT. */
function patientCommit(args: unknown[]): unknown[] {
  const first = args[0];
  const text = typeof first === 'string' ? first : first !== null && typeof first === 'object' ? (first as { text?: unknown }).text : undefined;
  if (typeof text !== 'string' || !COMMIT.test(text)) return args;
  return [{ ...(typeof first === 'string' ? { text: first } : first as object), query_timeout: COMMIT_TIMEOUT_MS }, ...args.slice(1)];
}

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
 * turn they would each time out in turn (2, 4, 6 seconds ...), and a transaction with one hung statement would give up at the sum. A COMMIT
 * has its own, longer read timeout (`COMMIT_TIMEOUT_MS`).
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
      waiting.push({ args: patientCommit(args), resolve, reject });
      if (!running) pump();
    });
  } as typeof client.query;
}
