import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { connectionString } from './support/db.js';

// #846: the migrator sent each migration file as one query through a pool with the API's 2 s request timeout, so on a host where the
// v0.1 baseline takes longer (a slow disk, a fraction of a CPU, arm64) every attempt rolled back with "Query read timeout".
// The real compiled migrator (`node tooling/dist/migrate.js`, as the Compose `migrate` service runs it) runs on a scratch database
// in which an event trigger makes the baseline's first statement take 3 s.
const run = promisify(execFile);

test('the API and worker pools keep their 2 s request timeout', async () => {
  const { pool: requests } = createDatabase(connectionString);
  try {
    assert.equal((requests as unknown as { options: { query_timeout: number } }).options.query_timeout, 2000);
  } finally { await requests.end(); }
});

test('migrate applies a baseline that takes longer than 2 s and records every file in the ledger', async () => {
  const scratch = `migrate_slow_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const scratchUrl = new URL(connectionString);
  scratchUrl.pathname = `/${scratch}`;
  // CREATE and DROP DATABASE can take longer than the 2 s request timeout on a loaded host (#916: the DROP hit it in 4 of 8 runs),
  // so the scratch database is made and removed on a pool with a long one.
  const { pool: admin } = createDatabase(connectionString, undefined, { queryTimeoutMs: 60_000, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${scratch}`);
    const { pool: setup } = createDatabase(scratchUrl.toString());
    try {
      // Only the migration session's query (it holds the whole baseline) sleeps, and only once; pg-boss's own setup is not slowed.
      await setup.query(`CREATE FUNCTION slow_baseline() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF position('CREATE TABLE public.flux_schema_version' IN current_query()) > 0
             AND current_setting('flux.slept', true) IS DISTINCT FROM 'yes' THEN
            PERFORM set_config('flux.slept', 'yes', false);
            PERFORM pg_sleep(3);
          END IF;
        END $$`);
      await setup.query('CREATE EVENT TRIGGER slow_baseline ON ddl_command_start EXECUTE FUNCTION slow_baseline()');
    } finally { await setup.end(); }

    const started = Date.now();
    const { stdout } = await run('node', ['tooling/dist/migrate.js'], { env: { ...process.env, DATABASE_URL: scratchUrl.toString() }, timeout: 120_000 });
    const seconds = (Date.now() - started) / 1000;
    assert.ok(seconds >= 3, `the baseline must have taken longer than the 2 s request timeout, took ${seconds} s`);
    assert.match(stdout, /Applied migration 0001_v0_1_baseline\.sql/);
    assert.match(stdout, new RegExp(`Flux schema ${FLUX_SCHEMA_VERSION} and pg-boss ready`));

    const { pool: scratchPool } = createDatabase(scratchUrl.toString());
    try {
      const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
      assert.deepEqual(await readAppliedMigrationVersions(scratchPool), manifest.map((file) => file.version));
    } finally { await scratchPool.end(); }
  } finally {
    try { await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`); } finally { await admin.end(); }
  }
});
