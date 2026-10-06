import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, databaseConnectTimeoutMs, DEFAULT_DB_CONNECT_TIMEOUT_MS } from '@flux/db';

// #271: how long a pool waits to hand out a connection. Production keeps 1.5 s; the Docker test stack
// sets FLUX_DB_CONNECT_TIMEOUT_MS for its bursts of concurrent requests (docs/development/containers.md).
test('a pool waits 1.5 s for a connection unless FLUX_DB_CONNECT_TIMEOUT_MS names a bounded integer', async () => {
  assert.equal(DEFAULT_DB_CONNECT_TIMEOUT_MS, 1500);
  assert.equal(databaseConnectTimeoutMs({}), 1500);
  assert.equal(databaseConnectTimeoutMs({ FLUX_DB_CONNECT_TIMEOUT_MS: '' }), 1500);
  assert.equal(databaseConnectTimeoutMs({ FLUX_DB_CONNECT_TIMEOUT_MS: '10000' }), 10_000);
  for (const value of ['abc', '1.5', '99', '60001', '-1']) {
    assert.throws(() => databaseConnectTimeoutMs({ FLUX_DB_CONNECT_TIMEOUT_MS: value }), /FLUX_DB_CONNECT_TIMEOUT_MS/, value);
  }
  const { pool } = createDatabase('postgres://flux@127.0.0.1:1/unused', 2500);
  try {
    assert.equal((pool as unknown as { options: { connectionTimeoutMillis: number } }).options.connectionTimeoutMillis, 2500);
  } finally { await pool.end(); }
});
