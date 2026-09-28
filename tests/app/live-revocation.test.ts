import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import { DomainError, grantProject, removeMember as removeWorkspaceMember, type LiveMedia } from '@flux/core';
import type { Conversation } from '@flux/contracts';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { liveRevocationCoordinator, withNoMediaAccessChange } from '../../apps/server/src/live/revocation.js';
import { accessRoutes } from '../../apps/server/src/access/routes.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

function mediaFixture() {
  const rooms = new Set<string>();
  const retired: string[] = [];
  let deleteCalls = 0;
  let failOnCall = 0;
  const media: LiveMedia = {
    async ensureRoom(roomId) { rooms.add(roomId); },
    async grant(roomId) { return { token: `jwt:${roomId}`, expiresAt: new Date(Date.now() + 90_000) }; },
    async participants() { return []; },
    async removeParticipant() {},
    async deleteRoom(roomId) {
      deleteCalls += 1;
      if (deleteCalls === failOnCall) throw new Error('SFU unavailable');
      rooms.delete(roomId);
      retired.push(roomId);
    },
  };
  return { media, rooms, retired, failNextDelete: () => { failOnCall = deleteCalls + 1; },
    failSecondDelete: () => { failOnCall = deleteCalls + 2; } };
}

async function fixture(label: string) {
  const owner = await person(`${label}-owner`);
  const member = await person(`${label}-member`);
  const ws = await workspace(owner, label);
  await addMember(owner, ws.id, member, 'member');
  const place = await project(owner, ws.id, label, 'restricted');
  await grant(owner, place.id, member, 'viewer');
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: `${label} anchor`, clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const store = liveSessionStore(db);
  const transport = mediaFixture();
  const principal = { kind: 'human' as const, id: member.id };
  const context = { type: 'conversation' as const, id: thread.id };
  const session = await store.createOrGet(principal, place.id, context, randomUUID(), transport.media.ensureRoom);
  const coordinator = liveRevocationCoordinator(db, pool, transport.media);
  return { owner, member, ws, place, store, transport, principal, context, session, coordinator };
}

test('grant revocation retires the old room before commit and leaves only a new-generation owner room', async () => {
  const f = await fixture('live-revoke');
  const old = await f.store.withAdmission(f.principal, f.session.id, async (session) => f.transport.media.grant(session.roomId, f.member.id));
  assert.equal(old.token, `jwt:${f.session.roomId}`);
  await f.coordinator.withProjectChange(f.place.id, async () => {
    assert.equal(f.transport.rooms.has(f.session.roomId), false);
    await grantProject({ kind: 'human', id: f.owner.id }, f.place.id,
      { principal: f.principal, role: 'denied' }, db);
  });
  const next = await f.store.find(f.session.id);
  assert.equal(next?.generation, 2);
  assert.equal(next?.state, 'available');
  assert.notEqual(next?.roomId, f.session.roomId);
  assert.equal(f.transport.rooms.has(f.session.roomId), false);
  await assert.rejects(f.store.withAdmission(f.principal, f.session.id, async () => 'unexpected'),
    (error) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND');
  const owner = { kind: 'human' as const, id: f.owner.id };
  const replacement = await f.store.withAdmission(owner, f.session.id, async (session) => {
    await f.transport.media.ensureRoom(session.roomId);
    return f.transport.media.grant(session.roomId, f.owner.id);
  });
  assert.equal(replacement.token, `jwt:${next?.roomId}`);
});

test('an in-flight join finishes before the revocation fence and old-room deletion', async () => {
  const f = await fixture('live-race');
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const admission = f.store.withAdmission(f.principal, f.session.id, async () => {
    entered();
    await held;
    return 'issued';
  });
  await started;
  const revocation = f.coordinator.withProjectChange(f.place.id, () => grantProject(
    { kind: 'human', id: f.owner.id }, f.place.id, { principal: f.principal, role: 'denied' }, db));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.transport.retired.length, 0);
  release();
  assert.equal(await admission, 'issued');
  await revocation;
  assert.ok(f.transport.retired.includes(f.session.roomId));
});

test('workspace membership removal retires all old media while a remaining member rejoins a new generation', async () => {
  const f = await fixture('live-member');
  const remaining = await person('live-member-remaining');
  await addMember(f.owner, f.ws.id, remaining, 'member');
  await grantProject({ kind: 'human', id: f.owner.id }, f.place.id,
    { principal: { kind: 'human', id: remaining.id }, role: 'viewer' }, db);
  const remainingPrincipal = { kind: 'human' as const, id: remaining.id };
  const original = await f.store.withAdmission(remainingPrincipal, f.session.id, async (session) => session.roomId);
  assert.equal(original, f.session.roomId);
  await f.coordinator.withWorkspaceChange(f.ws.id, async () => {
    assert.equal(f.transport.rooms.has(original), false);
    await removeWorkspaceMember({ kind: 'human', id: f.owner.id }, f.ws.id, f.member.id, db);
  });
  await assert.rejects(f.store.withAdmission(f.principal, f.session.id, async () => 'unexpected'),
    (error) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND');
  const replacement = await f.store.withAdmission(remainingPrincipal, f.session.id, async (session) => session.roomId);
  assert.notEqual(replacement, original);
  assert.equal((await f.store.find(f.session.id))?.generation, 2);
});

test('API without an SFU rejects revocation while a live room may still exist', async () => {
  const f = await fixture('live-no-media');
  const response = await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/grants`, {
    body: { principal: f.principal, role: 'denied' },
  });
  assert.equal(response.status, 503);
  assert.equal((response.json as { code?: string }).code, 'LIVE_MEDIA_UNAVAILABLE');
  assert.equal(await f.store.withAdmission(f.principal, f.session.id, async () => 'still-authorized'), 'still-authorized');
});

test('an SFU failure after policy commit returns an error and retains the fence for reconciliation', async () => {
  const f = await fixture('live-finalize-failure');
  f.transport.failSecondDelete();
  const app = Fastify();
  await app.register(accessRoutes, {
    db,
    sessions: { requirePrincipal: async () => ({ principal: { kind: 'human', id: f.owner.id } }) } as never,
    boss: {} as never,
    liveRevocation: f.coordinator,
  });
  try {
    const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${f.place.id}/grants`,
      payload: { principal: f.principal, role: 'denied' } });
    assert.equal(response.statusCode, 500);
    assert.equal((await f.store.find(f.session.id))?.state, 'rotating');
    await assert.rejects(f.store.withAdmission(f.principal, f.session.id, async () => 'unexpected'),
      (error) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND');
    await f.coordinator.recoverPending();
    assert.equal((await f.store.find(f.session.id))?.generation, 2);
  } finally { await app.close(); }
});

test('no-media access mutation holds the project guard until commit against concurrent admission', async () => {
  const f = await fixture('live-mixed-replica');
  const second = await project(f.owner, f.ws.id, 'Fresh project without media', 'restricted');
  await grant(f.owner, second.id, f.member, 'viewer');
  const thread = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${second.id}/conversations`, {
    body: { body: 'Fresh anchor', clientMessageId: randomUUID() },
  }), 201) as Conversation;

  let inside!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { inside = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const change = withNoMediaAccessChange(db, { workspaceId: f.ws.id, projectId: second.id }, async (conn) => {
    inside();
    await held;
    await grantProject({ kind: 'human', id: f.owner.id }, second.id,
      { principal: f.principal, role: 'denied' }, conn);
  });
  await started;
  let admitted = false;
  const admission = f.store.createOrGet(f.principal, second.id,
    { type: 'conversation', id: thread.id }, randomUUID(), async (roomId) => {
      admitted = true;
      await f.transport.media.ensureRoom(roomId);
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(admitted, false);
  release();
  await change;
  await assert.rejects(admission, (error) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND');
  assert.equal(admitted, false);
});

test('no-media guard rolls back a failed access mutation under the same lock', async () => {
  const f = await fixture('live-no-media-rollback');
  const second = await project(f.owner, f.ws.id, 'Rollback project', 'restricted');
  await grant(f.owner, second.id, f.member, 'viewer');
  await assert.rejects(withNoMediaAccessChange(db, { workspaceId: f.ws.id, projectId: second.id }, async (conn) => {
    await grantProject({ kind: 'human', id: f.owner.id }, second.id,
      { principal: f.principal, role: 'denied' }, conn);
    throw new Error('forced rollback');
  }), /forced rollback/);
  const allowed = await f.member.browser.request('GET', `/api/v1/projects/${second.id}`);
  assert.equal(allowed.status, 200);
});

test('SFU delete failure leaves a durable admission fence; recovery rotates without applying the change', async () => {
  const f = await fixture('live-failure');
  const outsider = await person('live-failure-outsider');
  f.transport.failNextDelete();
  let mutationRan = false;
  await assert.rejects(f.coordinator.withProjectChange(f.place.id, async () => { mutationRan = true; }), /SFU unavailable/);
  assert.equal(mutationRan, false);
  assert.equal((await f.store.find(f.session.id))?.state, 'rotating');
  await assert.rejects(f.store.withAdmission(f.principal, f.session.id, async () => 'unexpected'),
    (error) => error instanceof DomainError && error.code === 'LIVE_SESSION_ROTATING');
  await assert.rejects(f.store.withAdmission({ kind: 'human', id: outsider.id }, f.session.id, async () => 'unexpected'),
    (error) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND');
  await assert.rejects(f.store.createOrGet(f.principal, f.place.id, f.context, randomUUID(), f.transport.media.ensureRoom),
    (error) => error instanceof DomainError && error.code === 'LIVE_SESSION_ROTATING');
  await f.coordinator.recoverPending();
  const next = await f.store.find(f.session.id);
  assert.equal(next?.state, 'available');
  assert.equal(next?.generation, 2);
  assert.notEqual(next?.roomId, f.session.roomId);
  assert.equal(f.transport.rooms.has(f.session.roomId), false);
  assert.equal(await f.store.withAdmission(f.principal, f.session.id, async () => 'authorized'), 'authorized');
});
