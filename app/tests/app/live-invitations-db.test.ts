import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { grantProject, liveInvitationUseCases, type LiveInvitationCursor } from '@flux/core';
import type { Conversation } from '@flux/contracts';
import { liveInvitationStore } from '../../apps/server/src/live/invitations.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());
const errorCode = (code: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

async function fixture(label: string) {
  const owner = await person(`${label}-owner`);
  const recipient = await person(`${label}-recipient`);
  const stranger = await person(`${label}-stranger`);
  const ws = await workspace(owner, label);
  await addMember(owner, ws.id, recipient, 'member');
  await addMember(owner, ws.id, stranger, 'member');
  const place = await project(owner, ws.id, `${label} project`, 'restricted');
  await grant(owner, place.id, recipient, 'viewer');
  const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: `${label} private anchor body`, clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const anchor = { type: 'conversation' as const, id: conversation.id };
  const session = await liveSessionStore(db).createOrGet({ kind: 'human', id: owner.id },
    place.id, anchor, randomUUID(), async () => {});
  const invitations = liveInvitationUseCases(liveInvitationStore(db));
  return { owner, recipient, stranger, ws, place, conversation, anchor, session, invitations };
}

test('database invitation is idempotent, constrained to IDs and choice, and rejects a private recipient', async () => {
  const f = await fixture('live-invite-db');
  const caller = { kind: 'human' as const, id: f.owner.id };
  const recipient = { kind: 'human' as const, id: f.recipient.id };
  const same = await Promise.all(Array.from({ length: 3 }, () =>
    f.invitations.invite(caller, f.session.id, f.recipient.id)));
  assert.equal(new Set(same.map((row) => row.id)).size, 1);
  const stored = await pool.query('SELECT * FROM live_invitations WHERE session_id = $1', [f.session.id]);
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].response, 'pending');
  assert.deepEqual(Object.keys(stored.rows[0]).sort(), [
    'id', 'workspace_id', 'project_id', 'session_id', 'inviter_id', 'recipient_id',
    'response', 'created_at', 'responded_at',
  ].sort());
  assert.equal(JSON.stringify(stored.rows).includes(f.conversation.messages[0]?.body ?? 'impossible'), false);
  await assert.rejects(f.invitations.invite(caller, f.session.id, f.stranger.id), errorCode('LIVE_RECIPIENT_NOT_FOUND'));
  assert.deepEqual((await f.invitations.listPending(recipient)).items.map((row) => row.id), [same[0]!.id]);
  assert.deepEqual((await f.invitations.listPending({ kind: 'human', id: f.stranger.id })).items, []);

  const reply = await f.invitations.reply(recipient, same[0]!.id, 'text');
  assert.deepEqual(reply.next, { kind: 'open_project_conversation', projectId: f.place.id, context: f.anchor });
  assert.equal((await f.invitations.reply(recipient, same[0]!.id, 'text')).invitation.id, same[0]!.id);
  await assert.rejects(f.invitations.reply(recipient, same[0]!.id, 'later'), errorCode('LIVE_INVITATION_RESPONSE_CONFLICT'));
  const answered = await pool.query('SELECT response, responded_at FROM live_invitations WHERE id = $1', [same[0]!.id]);
  assert.equal(answered.rows[0].response, 'text');
  assert.ok(answered.rows[0].responded_at);
  assert.deepEqual((await f.invitations.listPending(recipient)).items, []);

  await grantProject(caller, f.place.id, { principal: recipient, role: 'denied' }, db);
  await assert.rejects(f.invitations.reply(recipient, same[0]!.id, 'text'), errorCode('LIVE_INVITATION_NOT_FOUND'));
});

test('invitation transaction blocks revocation until its authorized write commits', async () => {
  const f = await fixture('live-invite-lock');
  const caller = { kind: 'human' as const, id: f.owner.id };
  const recipient = { kind: 'human' as const, id: f.recipient.id };
  const ports = liveInvitationStore(db);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const write = ports.withTransaction(async (access, repository) => {
    const target = await access.loadSession(f.session.id);
    assert.ok(target);
    await access.requireProjectAndAnchor(caller, target);
    await access.requireProjectAndAnchor(recipient, target);
    entered();
    await held;
    return repository.insertOrGet(f.session.id, f.place.id, caller.id, recipient.id);
  });
  await started;
  let revoked = false;
  const revoke = grantProject(caller, f.place.id,
    { principal: recipient, role: 'denied' }, db).then(() => { revoked = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(revoked, false, 'the grant mutation waits for the invitation transaction');
  release();
  const invitation = await write;
  await revoke;
  assert.equal(revoked, true);
  assert.equal((await pool.query('SELECT count(*)::int AS total FROM live_invitations WHERE id = $1',
    [invitation.id])).rows[0].total, 1);
  assert.deepEqual((await f.invitations.listPending(recipient)).items, []);
  await assert.rejects(f.invitations.reply(recipient, invitation.id, 'later'), errorCode('LIVE_INVITATION_NOT_FOUND'));
});

test('recipient inbox cursor keeps PostgreSQL microseconds and walks equal-time rows', async () => {
  const f = await fixture('live-invite-page');
  const caller = { kind: 'human' as const, id: f.owner.id };
  const recipient = { kind: 'human' as const, id: f.recipient.id };
  const store = liveSessionStore(db);
  const sessions = [f.session];
  for (let index = 0; index < 2; index++) {
    sessions.push(await store.createOrGet(caller, f.place.id, f.anchor, randomUUID(), async () => {}));
  }
  const invited = await Promise.all(sessions.map((session) =>
    f.invitations.invite(caller, session.id, recipient.id)));
  await pool.query(`UPDATE live_invitations SET created_at = CASE
    WHEN id = $1::uuid OR id = $2::uuid THEN '2026-09-28T01:02:03.123456Z'::timestamptz
    ELSE '2026-09-28T01:02:03.123455Z'::timestamptz END
    WHERE id = ANY($3::uuid[])`, [invited[0]!.id, invited[1]!.id, invited.map((item) => item.id)]);
  const seen: string[] = [];
  let cursor: LiveInvitationCursor | null = null;
  for (let index = 0; index < 3; index++) {
    const page = await f.invitations.listPending(recipient, cursor, 1);
    assert.equal(page.items.length, 1);
    seen.push(page.items[0]!.id);
    if (page.nextCursor) assert.match(page.nextCursor.createdAt, /\.12345[56]/);
    cursor = page.nextCursor;
  }
  assert.deepEqual(new Set(seen), new Set(invited.map((item) => item.id)));
  assert.equal(cursor, null);
});

test('concurrent different replies perform one compare-and-set and preserve the winner', async () => {
  const f = await fixture('live-invite-cas');
  const caller = { kind: 'human' as const, id: f.owner.id };
  const recipient = { kind: 'human' as const, id: f.recipient.id };
  const invitation = await f.invitations.invite(caller, f.session.id, recipient.id);
  const results = await Promise.allSettled([
    f.invitations.reply(recipient, invitation.id, 'later'),
    f.invitations.reply(recipient, invitation.id, 'text'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.equal(errorCode('LIVE_INVITATION_RESPONSE_CONFLICT')(rejected.reason), true);
  const row = await pool.query('SELECT response FROM live_invitations WHERE id = $1', [invitation.id]);
  const fulfilled = results.find((result) => result.status === 'fulfilled');
  assert.ok(fulfilled && fulfilled.status === 'fulfilled');
  assert.equal(row.rows[0].response, fulfilled.value.invitation.response);
});
