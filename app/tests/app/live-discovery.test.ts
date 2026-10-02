import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Conversation } from '@flux/contracts';
import { DomainError, grantProject, type LiveMedia } from '@flux/core';
import { discoverLiveSessions } from '../../apps/server/src/live/discovery.js';
import { liveRevocationCoordinator } from '../../apps/server/src/live/revocation.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';


function missing(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('live discovery pages only currently authorized project anchors and reports SFU uncertainty', async () => {
  const owner = await person('live-discovery-owner');
  const viewer = await person('live-discovery-viewer');
  const outsider = await person('live-discovery-outsider');
  const ws = await workspace(owner, 'Live discovery');
  const otherWs = await workspace(outsider, 'Elsewhere');
  await addMember(owner, ws.id, viewer, 'member');
  const place = await project(owner, ws.id, 'Private work', 'restricted');
  const another = await project(owner, ws.id, 'Another private project', 'restricted');
  await grant(owner, place.id, viewer, 'viewer');

  const first = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'First private source', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const second = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Second private source', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const third = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${another.id}/conversations`, {
    body: { body: 'Other project source', clientMessageId: randomUUID() },
  }), 201) as Conversation;

  const principal = { kind: 'human' as const, id: owner.id };
  const store = liveSessionStore(db);
  const a = await store.createOrGet(principal, place.id, { type: 'conversation', id: first.id }, randomUUID(), async () => {});
  const b = await store.createOrGet(principal, place.id, { type: 'conversation', id: second.id }, randomUUID(), async () => {});
  const foreign = await store.createOrGet(principal, another.id, { type: 'conversation', id: third.id }, randomUUID(), async () => {});
  const media: LiveMedia = {
    async ensureRoom() {},
    async requireRoom() {},
    async grant() { return { token: 'unused', expiresAt: new Date(Date.now() + 90_000) }; },
    async participants(roomId) {
      if (roomId === a.roomId) return [{ userId: owner.id, joinedAt: '2026-09-28T00:00:00.000Z' }];
      throw new Error('SFU is unavailable');
    },
    async occupancy() { return 0; },
    async removeAdmissions() {},
    async deleteRoom() {},
  };
  const reader = { kind: 'human' as const, id: viewer.id };

  const page1 = await discoverLiveSessions(db, media, reader, place.id, { limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.ok(page1.nextBefore);
  const page2 = await discoverLiveSessions(db, media, reader, place.id, { limit: 1, before: page1.nextBefore! });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextBefore, null);
  const rows = [...page1.items, ...page2.items];
  assert.deepEqual(new Set(rows.map((item) => item.id)), new Set([a.id, b.id]));
  assert.ok(rows.every((item) => item.projectId === place.id && item.state === 'available'));
  assert.deepEqual(rows.find((item) => item.id === a.id)?.participants, [{ userId: owner.id, joinedAt: '2026-09-28T00:00:00.000Z' }]);
  assert.equal(rows.find((item) => item.id === b.id)?.participants, null, 'SFU failure is unknown, never empty');
  assert.ok(!JSON.stringify(rows).includes(a.roomId), 'opaque room ID is not a discovery payload');
  assert.ok(!JSON.stringify(rows).includes('private source'), 'source text is not a discovery payload');

  await assert.rejects(discoverLiveSessions(db, media, reader, place.id, { before: foreign.id }), missing('LIVE_SESSION_NOT_FOUND'));
  await assert.rejects(discoverLiveSessions(db, media, { kind: 'human', id: outsider.id }, place.id), missing('PROJECT_NOT_FOUND'));
  await assert.rejects(discoverLiveSessions(db, media, reader, otherWs.id), missing('PROJECT_NOT_FOUND'));
  // Access mutation uses the same room-retirement fence as production. The test API
  // intentionally has no SFU and rejects a live revocation with 503.
  await liveRevocationCoordinator(db, pool, media).withProjectChange(place.id, () =>
    grantProject(principal, place.id, { principal: reader, role: 'denied' }, db));
  await assert.rejects(discoverLiveSessions(db, media, reader, place.id), missing('PROJECT_NOT_FOUND'));

  await pool.query('UPDATE live_sessions SET state = $1 WHERE id = $2', ['ended', a.id]);
  const ownerPage = await discoverLiveSessions(db, media, principal, place.id);
  assert.deepEqual(ownerPage.items.map((item) => item.id), [b.id]);
});

test('live discovery does not return presence for a session ended during the SFU read', async () => {
  const owner = await person('live-discovery-ending-owner');
  const ws = await workspace(owner, 'Live discovery ending');
  const place = await project(owner, ws.id, 'Ending project', 'restricted');
  const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Ending anchor', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const principal = { kind: 'human' as const, id: owner.id };
  const session = await liveSessionStore(db).createOrGet(principal, place.id,
    { type: 'conversation', id: conversation.id }, randomUUID(), async () => {});

  await assert.rejects(discoverLiveSessions(db, {
    async participants() {
      await pool.query("UPDATE live_sessions SET state = 'ended' WHERE id = $1", [session.id]);
      return [{ userId: owner.id, joinedAt: new Date().toISOString() }];
    },
  }, principal, place.id), missing('LIVE_SESSION_NOT_FOUND'));
});
