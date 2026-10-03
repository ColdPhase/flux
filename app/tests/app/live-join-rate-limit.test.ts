import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { RateLimitedError, type LiveMedia } from '@flux/core';
import type { Conversation } from '@flux/contracts';
import { liveAccess } from '../../apps/server/src/live/access.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { liveRoutes } from '../../apps/server/src/live/routes.js';
import { joinRateLimiter } from '../../apps/server/src/live/rate-limit.js';
import { db } from './support/db.js';
import { addMember, expectStatus, person, project, workspace } from './support/people.js';

// Per-user, per-API-instance limit on live join grants (#62), with an injected clock and an
// in-memory media port.

function memoryMedia(): LiveMedia {
  const rooms = new Set<string>();
  return {
    async ensureRoom(roomId) { rooms.add(roomId); },
    async requireRoom() {},
    async grant(roomId) { return { token: `jwt:${roomId}`, expiresAt: new Date(Date.now() + 90_000) }; },
    async participants() { return []; },
    async occupancy() { return 0; },
    async removeAdmissions() {},
    async deleteRoom(roomId) { rooms.delete(roomId); },
  };
}

test('the limiter allows 20 per rolling minute per person, says when to retry and stays bounded', () => {
  let clock = 1_000_000;
  const limiter = joinRateLimiter({ now: () => clock, maxUsers: 3 });
  for (let index = 0; index < 20; index++) { limiter.take('ada'); clock += 1000; }
  assert.throws(() => limiter.take('ada'), (error: unknown) => error instanceof RateLimitedError
    && error.status === 429 && error.code === 'LIVE_JOIN_RATE_LIMITED' && error.retryAfterSeconds === 40);
  limiter.take('ben');
  clock = 1_000_000 + 60_001;
  limiter.take('ada');
  for (const id of ['cy', 'dee', 'eli', 'fay']) limiter.take(id);
  assert.ok(limiter.size() <= 3, 'memory stays bounded by maxUsers');
});

test('the 21st join within the window is 429 LIVE_JOIN_RATE_LIMITED with Retry-After; others are unaffected', async () => {
  const owner = await person('live-join-limit-owner');
  const member = await person('live-join-limit-member');
  const ws = await workspace(owner, 'live-join-limit');
  await addMember(owner, ws.id, member, 'member');
  const place = await project(owner, ws.id, 'live-join-limit project', 'workspace');
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'live-join-limit anchor', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const media = memoryMedia();
  const store = liveSessionStore(db);
  const session = await store.createOrGet({ kind: 'human', id: owner.id }, place.id,
    { type: 'conversation', id: thread.id }, randomUUID(), media.ensureRoom);
  let clock = Date.now();
  const app = Fastify();
  await app.register(liveRoutes, {
    sessions: { requirePrincipal: async (request: { headers: Record<string, unknown> }) =>
      ({ principal: { kind: 'human', id: String(request.headers['x-test-user']) },
        sessionId: `auth-${String(request.headers['x-test-user'])}` }) } as never,
    ports: { access: liveAccess(db), sessions: store, media, mediaUrl: 'wss://media.example.test' },
    joinLimiter: joinRateLimiter({ now: () => clock }),
  });
  const join = (userId: string) => app.inject({ method: 'POST', url: `/api/v1/live-sessions/${session.id}/join`, headers: { 'x-test-user': userId } });
  try {
    for (let index = 0; index < 20; index++) assert.equal((await join(owner.id)).statusCode, 200, `join ${index + 1}`);
    const limited = await join(owner.id);
    assert.equal(limited.statusCode, 429);
    assert.equal((limited.json() as { code: string }).code, 'LIVE_JOIN_RATE_LIMITED');
    assert.equal((limited.json() as { error: string }).error, 'Too many join attempts; try again shortly');
    assert.ok(Number(limited.headers['retry-after']) >= 1 && Number(limited.headers['retry-after']) <= 60);
    assert.equal((await join(member.id)).statusCode, 200, 'another person is unaffected');
    clock += 60_001;
    assert.equal((await join(owner.id)).statusCode, 200, 'the window expires');
  } finally { await app.close(); }
});
