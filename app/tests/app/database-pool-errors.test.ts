import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { registerDatabase } from '../../apps/server/src/plugins/database.js';

// #889: a database restart ends every connection with a 57P01 `error` event. A pool or a client with no listener turns
// that into an uncaught exception, which ends the API or the worker. Terminating the backend of a pooled connection
// from a second connection is the same event, so these run against the real database of the suite.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const admin = createDatabase(connectionString);
after(() => admin.pool.end());

async function until(check: () => boolean, label: string, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function terminate(pid: number) {
  assert.equal((await admin.pool.query('SELECT pg_terminate_backend($1) AS ended', [pid])).rows[0].ended, true);
}

describe('every pool survives its database going away', () => {
  test('an idle connection that is terminated is reported, dropped, and the pool opens a new one', async () => {
    const errors: Array<Error & { code?: string }> = [];
    const { pool } = createDatabase(connectionString, undefined, { onError: (error) => errors.push(error) });
    try {
      const first = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await terminate(first);
      await until(() => errors.length > 0, 'the pool to report the lost connection');
      assert.equal(errors[0]!.code, '57P01');
      const next = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      assert.notEqual(next, first, 'the next query runs on a new connection');
    } finally { await pool.end(); }
  });

  test('a pool made without a handler still has one, and logs the loss', async () => {
    const logged = mock.method(console, 'error', () => undefined);
    const { pool } = createDatabase(connectionString);
    try {
      assert.ok(pool.listenerCount('error') >= 1, 'the pool has an error listener');
      await terminate((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number);
      await until(() => logged.mock.callCount() > 0, 'the default report');
      assert.equal(logged.mock.calls[0]!.arguments[0], 'Database connection interrupted');
      assert.equal(((await pool.query('SELECT 1 AS ok')).rows[0] as { ok: number }).ok, 1, 'and the pool still answers');
    } finally { logged.mock.restore(); await pool.end(); }
  });

  test('a checked-out connection that is terminated does not end the process, and is not handed out again', async () => {
    const { pool } = createDatabase(connectionString, undefined, { onError: () => undefined });
    try {
      const client = await pool.connect();
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await terminate(pid);
      // The pool removes its own listener while a client is checked out, so only the listener of createDatabase stands
      // between this event and an uncaught exception. Wait until the client has seen the loss.
      await until(() => !(client as unknown as { _queryable: boolean })._queryable, 'the client to see the loss');
      await assert.rejects(client.query('SELECT 1'));
      client.release();
      const next = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      assert.notEqual(next, pid, 'the broken connection was destroyed on release');
    } finally { await pool.end(); }
  });

  test('the API pool reports through its own log', async () => {
    const warned: unknown[][] = [];
    const hooks: Array<() => Promise<unknown>> = [];
    const app = { log: { warn: (...args: unknown[]) => warned.push(args) }, addHook: (_name: string, hook: () => Promise<unknown>) => hooks.push(hook) };
    const { pool } = registerDatabase(app as never, connectionString);
    try {
      await terminate((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number);
      await until(() => warned.length > 0, 'the API log');
      assert.equal(warned[0]![1], 'Database connection interrupted');
    } finally { for (const hook of hooks) await hook(); }
  });
});
