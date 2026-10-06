import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import type { SessionResolver } from '../../apps/server/src/identity/index.js';
import { typingRoutes } from '../../apps/server/src/typing/routes.js';

const connectionString = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

test('512 timed-out upgrades keep unfinished identity permits until their promises settle', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const sessions: SessionResolver = {
    async resolveSession() { started++; await pending; return null; },
    async requirePrincipal() { throw new Error('Not used'); },
  };
  const app = Fastify();
  await app.register(typingRoutes, { db, sessions, connectionString, publicOrigin: 'http://admission.fixture' });
  const requests = Array.from({ length: 512 }, () => app.inject({ method: 'GET', url: '/api/v1/typing', headers: { origin: 'http://admission.fixture' } }));
  try {
    const deadline = performance.now() + 2000;
    while (started < 512 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started, 512);
    const next = () => app.inject({ method: 'GET', url: '/api/v1/typing', headers: { origin: 'http://admission.fixture' } });
    assert.equal((await next()).statusCode, 503);
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    assert.equal((await next()).statusCode, 503, 'timer expiry does not replenish unresolved authentication work');
    assert.equal(started, 512);
    release();
    assert.ok((await Promise.all(requests)).every((reply) => reply.statusCode === 503), 'timed-out work cannot upgrade later');
    assert.equal((await next()).statusCode, 401, 'settlement releases capacity; live authentication is still required');
    assert.equal(started, 513);
  } finally { release(); await Promise.all(requests); await app.close(); }
});
