import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DomainError, liveInvitationUseCases, type LiveMedia } from '@flux/core';
import type { InboxItem, InboxResponse } from '@flux/contracts';
import { liveAccess } from '../../apps/server/src/live/access.js';
import { discoverLiveSessions } from '../../apps/server/src/live/discovery.js';
import { liveInvitationStore } from '../../apps/server/src/live/invitations.js';
import { liveRevocationCoordinator } from '../../apps/server/src/live/revocation.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { db, pool, removeFromSpaceCore } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// A call of the space (F-041, #1223 point 1, #1230): a call started from a space's conversation belongs to the space, not to the
// message that happened to be newest. Its context is `{ type: 'space', id: <space> }` and its row names no conversation, task, map or page.

const human = (someone: Person) => ({ kind: 'human' as const, id: someone.id });
const missing = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

const media: LiveMedia = {
  async ensureRoom() {},
  async requireRoom() {},
  async grant() { return { token: 'unused', expiresAt: new Date(Date.now() + 90_000) }; },
  async participants() { return []; },
  async occupancy() { return 0; },
  async removeAdmissions() {},
  async deleteRoom() {},
};

test('a call of the space is stored without an object, found by its space, and replayed by its key', async () => {
  const owner = await person('space-call-owner');
  const member = await person('space-call-member');
  const outsider = await person('space-call-outsider');
  const ws = await workspace(owner, 'Space call');
  await addMember(owner, ws.id, member, 'member');
  await addMember(owner, ws.id, outsider, 'member');
  const place = await project(owner, ws.id, 'Gesture lamp', 'restricted');
  const other = await project(owner, ws.id, 'Rain barrel', 'restricted');
  await grant(owner, place.id, member, 'contributor');

  // The context resolves to its own space for someone who can read it, and to nothing for someone who cannot.
  assert.deepEqual(await liveAccess(db).resolveContext(human(member), { type: 'space', id: place.id }), { projectId: place.id });
  await assert.rejects(liveAccess(db).resolveContext(human(outsider), { type: 'space', id: place.id }), missing('PROJECT_NOT_FOUND'));
  await assert.rejects(liveAccess(db).resolveContext(human(member), { type: 'space', id: randomUUID() }), missing('LIVE_CONTEXT_NOT_FOUND'));

  const store = liveSessionStore(db);
  const key = randomUUID();
  const session = await store.createOrGet(human(member), place.id, { type: 'space', id: place.id }, key, async () => {});
  assert.deepEqual(session.context, { type: 'space', id: place.id });
  const { rows } = await pool.query('SELECT conversation_id, work_id, sketch_id, doc_id FROM live_sessions WHERE id = $1', [session.id]);
  assert.deepEqual(rows[0], { conversation_id: null, work_id: null, sketch_id: null, doc_id: null }, 'a call of the space names no object');
  assert.equal((await store.createOrGet(human(member), place.id, { type: 'space', id: place.id }, key, async () => {})).id, session.id, 'a retry is the same call');
  // A space context names its own space only: another space's id under this one is refused, and a key cannot change its place.
  await assert.rejects(store.createOrGet(human(owner), place.id, { type: 'space', id: other.id }, randomUUID(), async () => {}), missing('LIVE_CONTEXT_NOT_FOUND'));
  const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Is the IR-cut filter stuck?', clientMessageId: randomUUID() },
  }), 201) as { id: string };
  await assert.rejects(store.createOrGet(human(member), place.id, { type: 'conversation', id: conversation.id }, key, async () => {}), missing('IDEMPOTENCY_CONFLICT'));

  // A message posted after the call started does not move it: it is still the space's call (#1230).
  expectStatus(await owner.browser.request('POST', `/api/v1/conversations/${conversation.id}/messages`, {
    body: { body: 'Posting after the call started', clientMessageId: randomUUID() },
  }), 201);
  const found = await discoverLiveSessions(db, media, human(owner), place.id);
  assert.deepEqual(found.items.map((item) => [item.id, item.context]), [[session.id, { type: 'space', id: place.id }]]);
  assert.deepEqual((await store.find(session.id))?.context, { type: 'space', id: place.id });
  await assert.rejects(discoverLiveSessions(db, media, human(outsider), place.id), missing('PROJECT_NOT_FOUND'), 'never for someone without access');

  // Admission and reads recheck the space: someone removed from it loses the call.
  const admitted = await store.withAdmission(human(member), session.id, async (current) => current.context);
  assert.deepEqual(admitted, { type: 'space', id: place.id });
  await liveRevocationCoordinator(db, pool, media).withProjectChange(place.id, () => removeFromSpaceCore(human(owner), place.id, human(member), db));
  await assert.rejects(discoverLiveSessions(db, media, human(member), place.id), missing('PROJECT_NOT_FOUND'));
  await assert.rejects(store.withRead(human(member), session.id, async () => null), missing('PROJECT_NOT_FOUND'));
});

test('an invitation to a call of the space is named by the space', async () => {
  const owner = await person('space-call-inviter');
  const recipient = await person('space-call-invited');
  const ws = await workspace(owner, 'Space call invite');
  await addMember(owner, ws.id, recipient, 'member');
  const place = await project(owner, ws.id, 'Harbour permit', 'restricted');
  await grant(owner, place.id, recipient, 'contributor');
  const session = await liveSessionStore(db).createOrGet(human(owner), place.id, { type: 'space', id: place.id }, randomUUID(), async () => {});
  const invitation = await liveInvitationUseCases(liveInvitationStore(db)).invite(human(owner), session.id, recipient.id);
  const url = `/projects/${place.id}/live/${session.id}?invitation=${invitation.id}`;
  const item = await waitFor(async () => ((expectStatus(await recipient.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse).items)
    .find((entry: InboxItem) => entry.url === url), 'the invitation in the inbox');
  assert.equal(item.reason, 'invitation');
  assert.equal(item.title, 'space-call-inviter invited you to a call');
  assert.equal(item.body, 'Call in Harbour permit');
});
