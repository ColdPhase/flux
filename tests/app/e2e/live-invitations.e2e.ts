import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Conversation, LiveSession } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';

interface Invitation {
  id: string;
  sessionId: string;
  projectId: string;
  inviterId: string;
  recipientId: string;
  response: 'pending' | 'later' | 'text';
  createdAt: string;
  respondedAt: string | null;
}
interface Inbox { items: Invitation[]; nextCursor: string | null }
interface Reply { invitation: Invitation; next: { kind: string; projectId?: string; context?: { type: string; id: string } } }

const invitePath = (sessionId: string) => `/api/v1/live-sessions/${sessionId}/invitations`;
const replyPath = (invitationId: string) => `/api/v1/live-invitations/${invitationId}/reply`;
const inboxPath = '/api/v1/live-invitations';
const safeFields = ['id', 'sessionId', 'projectId', 'inviterId', 'recipientId', 'response', 'createdAt', 'respondedAt'].sort();

test('recipient discovers, pages and answers HTTP live invitations; access revocation hides pending invitations',
  { timeout: 120_000 }, async () => {
    const owner = await person('invite-api-owner');
    const recipient = await person('invite-api-recipient');
    const revoked = await person('invite-api-revoked');
    const outsider = await person('invite-api-outsider');
    const ws = await workspace(owner, 'Invitation HTTP integration');
    await addMember(owner, ws.id, recipient, 'member');
    await addMember(owner, ws.id, revoked, 'member');
    const place = await project(owner, ws.id, 'Private invitation project', 'restricted');
    await grant(owner, place.id, recipient, 'viewer');
    await grant(owner, place.id, revoked, 'viewer');
    const anchor = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
      body: { body: 'Private anchor body is never copied into invitations', clientMessageId: randomUUID() },
    }), 201) as Conversation;
    const context = { type: 'conversation' as const, id: anchor.id };
    const start = async () => expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
      body: { context, clientSessionId: randomUUID() },
    }), 201) as LiveSession;
    const first = await start();
    const second = await start();

    assert.deepEqual((expectStatus(await recipient.browser.request('GET', inboxPath), 200) as Inbox).items, []);
    const invite = async (sessionId: string, recipientId: string) => expectStatus(await owner.browser.request(
      'POST', invitePath(sessionId), { body: { recipientId } }), 201) as Invitation;
    const one = await invite(first.id, recipient.id);
    const two = await invite(second.id, recipient.id);
    const hidden = await invite(first.id, revoked.id);
    assert.equal((await invite(first.id, recipient.id)).id, one.id, 'an HTTP retry reuses the invitation');
    assert.deepEqual(Object.keys(one).sort(), safeFields);
    assert.equal(JSON.stringify([one, two, hidden]).includes('Private anchor body'), false);
    assert.equal(JSON.stringify([one, two, hidden]).includes('token'), false);
    assert.deepEqual((expectStatus(await owner.browser.request('GET', inboxPath), 200) as Inbox).items, []);
    assert.deepEqual((expectStatus(await outsider.browser.request('GET', inboxPath), 200) as Inbox).items, []);

    const firstPage = expectStatus(await recipient.browser.request('GET', `${inboxPath}?limit=1`), 200) as Inbox;
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);
    assert.match(firstPage.nextCursor, /^[A-Za-z0-9_-]+$/);
    assert.throws(() => JSON.parse(Buffer.from(firstPage.nextCursor!, 'base64url').toString('utf8')),
      'the cursor is sealed, not a readable ID/timestamp tuple');
    const nextPage = expectStatus(await recipient.browser.request('GET',
      `${inboxPath}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`), 200) as Inbox;
    assert.equal(nextPage.items.length, 1);
    assert.equal(nextPage.nextCursor, null);
    assert.deepEqual(new Set([...firstPage.items, ...nextPage.items].map((item) => item.id)), new Set([one.id, two.id]));
    assert.deepEqual(Object.keys(firstPage.items[0]!).sort(), safeFields);
    const deniedReply = await outsider.browser.request('POST', replyPath(one.id), { body: { choice: 'later' } });
    assert.equal(deniedReply.status, 404, deniedReply.text);
    const deniedInvite = await outsider.browser.request('POST', invitePath(first.id), { body: { recipientId: recipient.id } });
    assert.equal(deniedInvite.status, 404, deniedInvite.text);

    const later = expectStatus(await recipient.browser.request('POST', replyPath(one.id),
      { body: { choice: 'later' } }), 200) as Reply;
    assert.equal(later.invitation.response, 'later');
    assert.deepEqual(later.next, { kind: 'stay' });
    assert.equal((expectStatus(await recipient.browser.request('POST', replyPath(one.id),
      { body: { choice: 'later' } }), 200) as Reply).invitation.id, one.id);
    const conflict = await recipient.browser.request('POST', replyPath(one.id), { body: { choice: 'text' } });
    assert.equal(conflict.status, 409, conflict.text);
    const text = expectStatus(await recipient.browser.request('POST', replyPath(two.id),
      { body: { choice: 'text' } }), 200) as Reply;
    assert.equal(text.invitation.response, 'text');
    assert.deepEqual(text.next, { kind: 'open_project_conversation', projectId: place.id, context });
    assert.deepEqual((expectStatus(await recipient.browser.request('GET', inboxPath), 200) as Inbox).items, []);
    const saved = expectStatus(await recipient.browser.request('GET', `/api/v1/conversations/${anchor.id}`), 200) as Conversation;
    assert.equal(saved.messages.length, 1, 'text choice does not create a duplicate message');

    assert.deepEqual((expectStatus(await revoked.browser.request('GET', inboxPath), 200) as Inbox).items.map((row) => row.id), [hidden.id]);
    await grant(owner, place.id, revoked, 'denied');
    assert.deepEqual((expectStatus(await revoked.browser.request('GET', inboxPath), 200) as Inbox).items, []);
    const revokedReply = await revoked.browser.request('POST', replyPath(hidden.id), { body: { choice: 'later' } });
    assert.equal(revokedReply.status, 404, revokedReply.text);
    const revokedInvite = await owner.browser.request('POST', invitePath(first.id), { body: { recipientId: revoked.id } });
    assert.equal(revokedInvite.status, 404, revokedInvite.text);
    console.log(JSON.stringify({ sessions: [first.id, second.id], invited: [one.id, two.id, hidden.id],
      cursor: true, later: 200, text: 200, outsider: 404, revokedInbox: 0, revokedReply: 404 }));
  });
