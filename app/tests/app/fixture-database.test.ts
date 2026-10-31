import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { before, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { fixtureDatabase, prepareCurrentSchemaFixtures } from './support/undo-legacy-database.js';

before(prepareCurrentSchemaFixtures);

async function databaseExists(admin: ReturnType<typeof createDatabase>['pool'], name: string): Promise<boolean> {
  const result = await admin.query('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists', [name]);
  return result.rows[0].exists as boolean;
}

test('an idle Undo fixture backend terminated before cleanup fails and the fixture is still removed', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureDatabase();
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  try {
    const identity = (await fixture.db.query('SELECT pg_backend_pid() AS pid, current_database() AS database')).rows[0] as { pid: number; database: string };
    assert.equal(identity.database, fixture.name);
    t.diagnostic(`cleanupBoundary=not-started database=${identity.database} backend=${identity.pid}`);
    const backendError = once(fixture.db, 'error');
    const terminated = await admin.query('SELECT pg_terminate_backend($1::integer) AS terminated', [identity.pid]);
    assert.equal(terminated.rows[0].terminated, true, `controlled termination of backend ${identity.pid} in ${identity.database}`);
    const [error] = await backendError as [NodeJS.ErrnoException];
    assert.equal(error.code, '57P01');
    assert.match(error.message, /terminating connection due to administrator command/);

    await assert.rejects(fixture.close(), /no fixture database connection failed before cleanup/);
    assert.equal(await databaseExists(admin, fixture.name), false, 'the failing fixture still drops its own database');
  } finally {
    try { await fixture.close(); } finally { await admin.end(); }
  }
});

test('an idle Undo fixture backend error after cleanup starts is owned cleanup and is recorded without failing the close', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureDatabase();
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  try {
    const identity = (await fixture.db.query('SELECT pg_backend_pid() AS pid, current_database() AS database')).rows[0] as { pid: number; database: string };
    assert.equal(identity.database, fixture.name);
    fixture.guard.cleanup();
    t.diagnostic(`cleanupBoundary=started database=${identity.database} backend=${identity.pid}`);
    const backendError = once(fixture.db, 'error');
    const terminated = await admin.query('SELECT pg_terminate_backend($1::integer) AS terminated', [identity.pid]);
    assert.equal(terminated.rows[0].terminated, true, `controlled cleanup termination of backend ${identity.pid} in ${identity.database}`);
    const [error] = await backendError as [NodeJS.ErrnoException];
    assert.equal(error.code, '57P01');
    assert.match(error.message, /terminating connection due to administrator command/);

    await fixture.close();
    assert.equal(await databaseExists(admin, fixture.name), false, 'owned cleanup removes its fixture database');
  } finally {
    try { await fixture.close(); } finally { await admin.end(); }
  }
});

test('Undo fixture setup errors retain their cause and drop the partially created database', { timeout: 30_000 }, async () => {
  const name = `flux_undo_setup_error_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  try {
    await assert.rejects(
      fixtureDatabase([{ name: 'setup-error.sql', version: 0, sql: 'CREATE TABLE setup_failure (' }], name),
      /syntax error/,
    );
    assert.equal(await databaseExists(admin, name), false, 'setup failure removes the partial fixture database');
  } finally { await admin.end(); }
});
