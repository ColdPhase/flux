import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ForbiddenError } from '../../packages/core/src/access/errors.js';
import type { Principal } from '../../packages/core/src/principal.js';
import {
  liveInvitationUseCases, type LiveInvitation, type LiveInvitationCursor,
  type LiveInvitationPorts, type LiveInvitationTarget,
} from '../../packages/core/src/live/invitations.js';

const person = (id: string = randomUUID()): Principal => ({ kind: 'human', id });
const code = (expected: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === expected;

function fixture() {
  const inviter = person();
  const recipient = person('auth-user_opaque-abc');
  const stranger = person();
  const target: LiveInvitationTarget = {
    id: randomUUID(), projectId: randomUUID(),
    context: { type: 'conversation', id: randomUUID() }, state: 'available',
  };
  const admitted = new Set([inviter.id, recipient.id]);
  const rows = new Map<string, LiveInvitation>();
  const steps: string[] = [];
  let inTransaction = false;
  const ports: LiveInvitationPorts = {
    async withTransaction(work) {
      assert.equal(inTransaction, false);
      inTransaction = true;
      steps.push('begin');
      try { return await work(access, invitations); }
      finally { steps.push('end'); inTransaction = false; }
    },
  };
  const access = {
    async loadSession(id: string) {
      assert.equal(inTransaction, true);
      steps.push('load');
      return id === target.id ? target : null;
    },
    async requireProjectAndAnchor(principal: Principal, current: LiveInvitationTarget) {
      assert.equal(inTransaction, true);
      assert.equal(current.id, target.id);
      steps.push(`authorize:${principal.id}`);
      if (!admitted.has(principal.id)) throw new ForbiddenError();
    },
  };
  const invitations = {
    async pendingForRecipient(recipientId: string, cursor: LiveInvitationCursor | null, limit: number) {
      assert.equal(inTransaction, true);
      steps.push('list');
      return [...rows.values()].filter((row) => row.recipientId === recipientId && row.response === 'pending')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .filter((row) => !cursor || row.createdAt < cursor.createdAt ||
          (row.createdAt === cursor.createdAt && row.id < cursor.id))
        .slice(0, limit).map((row) => ({ invitation: row,
          cursor: { createdAt: row.createdAt, id: row.id } }));
    },
    async insertOrGet(sessionId: string, projectId: string, inviterId: string, recipientId: string) {
      assert.equal(inTransaction, true);
      steps.push('insert');
      const key = `${sessionId}:${recipientId}`;
      let row = rows.get(key);
      if (!row) {
        row = { id: randomUUID(), sessionId, projectId, inviterId, recipientId,
          response: 'pending' as const, createdAt: new Date().toISOString(), respondedAt: null };
        // A careless adapter may return an extra private field; core still projects IDs and choice only.
        (row as LiveInvitation & { privateTitle?: string }).privateTitle = 'private anchor title';
        rows.set(key, row);
      }
      return row;
    },
    async find(id: string) {
      assert.equal(inTransaction, true);
      steps.push('find');
      return [...rows.values()].find((row) => row.id === id) ?? null;
    },
    async respondIfPending(id: string, recipientId: string, choice: 'later' | 'text') {
      assert.equal(inTransaction, true);
      steps.push('respond');
      const row = [...rows.values()].find((entry) => entry.id === id && entry.recipientId === recipientId);
      assert.ok(row);
      if (row.response === 'pending') {
        row.response = choice;
        row.respondedAt = new Date().toISOString();
      }
      return row;
    },
  };
  return { inviter, recipient, stranger, target, admitted, rows, steps, api: liveInvitationUseCases(ports) };
}

test('invitation is unique per live session and recipient, authorized at the current anchor', async () => {
  const f = fixture();
  const first = await f.api.invite(f.inviter, f.target.id, f.recipient.id);
  const retry = await f.api.invite(f.inviter, f.target.id, f.recipient.id);
  assert.equal(retry.id, first.id);
  assert.equal(f.rows.size, 1);
  assert.deepEqual(Object.keys(first).sort(),
    ['id', 'sessionId', 'projectId', 'inviterId', 'recipientId', 'response', 'createdAt', 'respondedAt'].sort());
  assert.equal(first.response, 'pending');
  assert.deepEqual(f.steps.slice(0, 6), ['begin', 'load', `authorize:${f.inviter.id}`,
    `authorize:${f.recipient.id}`, 'insert', 'end']);
});

test('private or revoked anchor denies invites before write and hides the recipient', async () => {
  const f = fixture();
  f.admitted.delete(f.inviter.id);
  await assert.rejects(f.api.invite(f.inviter, f.target.id, f.recipient.id), code('LIVE_SESSION_NOT_FOUND'));
  assert.equal(f.rows.size, 0);
  f.admitted.add(f.inviter.id);
  f.admitted.delete(f.recipient.id);
  await assert.rejects(f.api.invite(f.inviter, f.target.id, f.recipient.id), code('LIVE_RECIPIENT_NOT_FOUND'));
  assert.equal(f.rows.size, 0);
  await assert.rejects(f.api.invite(f.stranger, f.target.id, f.recipient.id), code('LIVE_SESSION_NOT_FOUND'));
  assert.equal(f.rows.size, 0);
});

test('later reply is idempotent, and a different reply cannot overwrite it', async () => {
  const f = fixture();
  const invited = await f.api.invite(f.inviter, f.target.id, f.recipient.id);
  const first = await f.api.reply(f.recipient, invited.id, 'later');
  assert.deepEqual(first.next, { kind: 'stay' });
  assert.equal(first.invitation.response, 'later');
  assert.ok(first.invitation.respondedAt);
  const second = await f.api.reply(f.recipient, invited.id, 'later');
  assert.equal(second.invitation.id, first.invitation.id);
  assert.equal(f.steps.filter((step) => step === 'respond').length, 1);
  await assert.rejects(f.api.reply(f.recipient, invited.id, 'text'), code('LIVE_INVITATION_RESPONSE_CONFLICT'));
  assert.equal(f.rows.size, 1);
});

test('text reply points to the ordinary project conversation without a message, media grant or copied title', async () => {
  const f = fixture();
  const invited = await f.api.invite(f.inviter, f.target.id, f.recipient.id);
  const reply = await f.api.reply(f.recipient, invited.id, 'text');
  assert.deepEqual(reply.next, { kind: 'open_project_conversation',
    projectId: f.target.projectId, context: f.target.context });
  assert.equal(reply.invitation.response, 'text');
  assert.deepEqual(Object.keys(reply.invitation).sort(), Object.keys(invited).sort());
  assert.equal(f.rows.size, 1);
});

test('recipient inbox fills a page past hidden pending invitations', async () => {
  const f = fixture();
  const visible = await f.api.invite(f.inviter, f.target.id, f.recipient.id);
  const hidden: LiveInvitation = { ...visible, id: randomUUID(), sessionId: randomUUID(),
    createdAt: new Date(Date.now() + 1000).toISOString() };
  f.rows.set('hidden', hidden);
  const page = await f.api.listPending(f.recipient, null, 1);
  assert.deepEqual(page.items.map((row) => row.id), [visible.id]);
  assert.equal(page.nextCursor, null);
  assert.deepEqual((await f.api.listPending(f.stranger)).items, []);
  f.admitted.delete(f.recipient.id);
  assert.deepEqual((await f.api.listPending(f.recipient)).items, []);
  await assert.rejects(f.api.listPending(f.recipient, null, 101), code('INVALID_INPUT'));
});

test('a full hidden inbox scan returns a generic failure without exposing its cursor', async () => {
  const f = fixture();
  for (let i = 0; i < 500; i++) {
    const hidden: LiveInvitation = {
      id: randomUUID(), sessionId: randomUUID(), projectId: f.target.projectId,
      inviterId: f.inviter.id, recipientId: f.recipient.id, response: 'pending',
      createdAt: new Date(Date.now() + i * 1000).toISOString(), respondedAt: null,
    };
    f.rows.set(`hidden-${i}`, hidden);
  }
  await assert.rejects(f.api.listPending(f.recipient, null, 1), code('LIVE_INVITATION_INBOX_UNAVAILABLE'));
});

test('reply rechecks current access and session state, including retries', async () => {
  const f = fixture();
  const invited = await f.api.invite(f.inviter, f.target.id, f.recipient.id);
  await assert.rejects(f.api.reply(f.stranger, invited.id, 'later'), code('LIVE_INVITATION_NOT_FOUND'));
  f.admitted.delete(f.recipient.id);
  await assert.rejects(f.api.reply(f.recipient, invited.id, 'later'), code('LIVE_INVITATION_NOT_FOUND'));
  assert.equal(f.rows.values().next().value?.response, 'pending');
  f.admitted.add(f.recipient.id);
  f.target.state = 'rotating';
  await assert.rejects(f.api.reply(f.recipient, invited.id, 'later'), code('LIVE_SESSION_UNAVAILABLE'));
  f.target.state = 'available';
  await f.api.reply(f.recipient, invited.id, 'later');
  f.admitted.delete(f.recipient.id);
  await assert.rejects(f.api.reply(f.recipient, invited.id, 'later'), code('LIVE_INVITATION_NOT_FOUND'));
});

test('only a person can invite or reply, and malformed IDs stop before storage', async () => {
  const f = fixture();
  const agent: Principal = { kind: 'agent', id: randomUUID() };
  await assert.rejects(f.api.invite(agent, f.target.id, f.recipient.id), code('HUMAN_INVITATION_REQUIRED'));
  await assert.rejects(f.api.invite(f.inviter, f.target.id, f.inviter.id), code('LIVE_SELF_INVITATION'));
  await assert.rejects(f.api.invite(f.inviter, 'bad', f.recipient.id), code('INVALID_INPUT'));
  await assert.rejects(f.api.invite(f.inviter, f.target.id, ''), code('INVALID_INPUT'));
  await assert.rejects(f.api.reply(agent, randomUUID(), 'later'), code('HUMAN_INVITATION_REQUIRED'));
  await assert.rejects(f.api.reply(f.recipient, 'bad', 'later'), code('INVALID_INPUT'));
  assert.deepEqual(f.steps, []);
});
