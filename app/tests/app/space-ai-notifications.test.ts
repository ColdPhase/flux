import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PgBoss } from 'pg-boss';
import { INBOX_PATH, NEEDS_YOU_PATH, assistantOperatorRequestPath, type InboxResponse, type NeedsYouResponse } from '@flux/contracts';
import {
  DEFAULT_PREFERENCES, deliverNotificationEmail, generateNotifications, preferenceRepository,
  type GeneratorEvent, type GeneratorPorts, type NotificationFacts, type NotificationMailer, type ProjectMessageFacts, type ReviewFacts,
} from '@flux/core';
import { assistantJobRows, notificationGeneratorRows, pushDeliveryRepository } from '@flux/db';
import { emailUnitOfWork } from '../../apps/worker/src/notifications/adapters.js';
import { assistantScene, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { publicOrigin } from './support/http.js';
import { expectStatus, type Person } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';

// AG-10 (F-029 follow-up #642; per space under F-037): the "AI origin" of a notification is written by whoever creates it, from the
// actor or the source, and the switch of the space it is about reads that column. One test per writer: a push and an e-mail queued before the flip are skipped while AI is off, the Inbox list, the unread
// count, the direct read and Needs you leave the item out, and the same notification delivers once AI is on.

const fakeBoss = () => {
  const sent: { name: string; data: unknown }[] = [];
  const boss = { send: async (name: string, data?: unknown) => { sent.push({ name, data }); return randomUUID(); } } as unknown as Pick<PgBoss, 'send'> & PgBoss;
  return { boss, sent };
};

let scene: AssistantScene;
const subscriptions = new Map<string, string>();

async function subscription(owner: Person) {
  const known = subscriptions.get(owner.id);
  if (known) return known;
  const session = (await pool.query('SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [owner.id])).rows[0].id as string;
  const id = randomUUID();
  await pool.query(`INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, 'p256dh', 'auth')`,
    [id, owner.id, session, `https://push.example.test/${id}`]);
  subscriptions.set(owner.id, id);
  return id;
}

const unreadIn = async (who: Person) => expectStatus(await who.browser.request('GET', INBOX_PATH), 200) as InboxResponse;
const needsYouKeys = async (who: Person) => (expectStatus(await who.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.map((item) => item.key);

async function aiOrigin(notificationId: string) {
  return (await pool.query('SELECT ai_origin FROM notifications WHERE id = $1', [notificationId])).rows[0]?.ai_origin as boolean | undefined;
}

interface Expectation {
  /** The notification is a Needs-you note while it is visible (a mention or question). */
  needsYou?: boolean;
}

/** The notification of one writer, queued for push and e-mail before the flip, then the flip and the re-enable. */
async function assertGated(label: string, recipient: Person, projectId: string, notificationId: string, expectation: Expectation = {}) {
  // Every reason on every channel, so the controls show what is delivered while AI is on.
  const everything = { mention: 1, question: 1, reply: 1, dm: 1, assigned: 1, review: 1, invitation: 1 };
  expectStatus(await recipient.browser.request('PATCH', '/api/v1/notification-preferences', { body: { channels: Object.fromEntries(Object.keys(everything).map((reason) => [reason, { inApp: true, push: true, email: true }])) } }), 200);
  assert.equal(await aiOrigin(notificationId), true, `${label}: the writer persisted ai_origin`);
  const subscriptionId = await subscription(recipient);
  const emailId = randomUUID();
  await pool.query(`INSERT INTO notification_emails (id, notification_id, user_id, address_kind) VALUES ($1, $2, $3, 'account')`, [emailId, notificationId, recipient.id]);
  const target = () => pushDeliveryRepository(db).findTarget({ notificationId, subscriptionId, userId: recipient.id });

  const hiddenCount = Number((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND source_type = 'project' AND source_id = $2 AND in_inbox AND read_at IS NULL AND ai_origin`,
    [recipient.id, projectId])).rows[0].n);
  assert.ok(hiddenCount >= 1, `${label}: the item is an unread AI-origin Inbox row`);
  const on = await unreadIn(recipient);
  assert.ok(on.items.some((item) => item.id === notificationId), `${label}: control, listed while AI is on`);
  assert.ok(await target(), `${label}: control, a push target while AI is on`);
  if (expectation.needsYou) assert.ok((await needsYouKeys(recipient)).includes(`note:${notificationId}`), `${label}: control, in Needs you while AI is on`);

  const epoch = await setSpaceAi(projectId, 'blocked');
  try {
    assert.equal(await target(), null, `${label}: a push queued before the flip is not sent`);
    const sent: string[] = [];
    const mailer = { send: async (message: { to: string }) => { sent.push(message.to); return { messageId: randomUUID() }; } } as unknown as NotificationMailer;
    const mail = await deliverNotificationEmail({ available: true, origin: publicOrigin, uow: emailUnitOfWork(db, fakeBoss().boss), mailer }, { emailId });
    assert.equal((mail as { reason?: string }).reason, 'AI is off in this space', `${label}: ${JSON.stringify(mail)}`);
    assert.equal(sent.length, 0, `${label}: no e-mail left`);
    const off = await unreadIn(recipient);
    assert.ok(!off.items.some((item) => item.id === notificationId), `${label}: left out of the Inbox list`);
    assert.equal(off.unread, on.unread - hiddenCount, `${label}: and out of the unread count`);
    assert.equal((await recipient.browser.request('GET', `${INBOX_PATH}/${notificationId}`)).status, 404, `${label}: a direct read finds nothing`);
    assert.ok(!(await needsYouKeys(recipient)).includes(`note:${notificationId}`), `${label}: left out of Needs you`);
  } finally {
    await setSpaceAi(projectId, 'allowed');
  }
  assert.ok(epoch > 0);
  // The same notification delivers once AI is on (the skipped e-mail row is terminal, so a new one is queued).
  assert.ok(await target(), `${label}: a push target again once AI is on`);
  assert.ok((await unreadIn(recipient)).items.some((item) => item.id === notificationId), `${label}: listed again`);
  await pool.query('DELETE FROM notification_emails WHERE id = $1', [emailId]);
  const again = randomUUID();
  await pool.query(`INSERT INTO notification_emails (id, notification_id, user_id, address_kind) VALUES ($1, $2, $3, 'account')`, [again, notificationId, recipient.id]);
  const sent: string[] = [];
  const mailer = { send: async (message: { to: string }) => { sent.push(message.to); return { messageId: randomUUID() }; } } as unknown as NotificationMailer;
  const mail = await deliverNotificationEmail({ available: true, origin: publicOrigin, uow: emailUnitOfWork(db, fakeBoss().boss), mailer }, { emailId: again });
  assert.equal(mail.outcome, 'sent', `${label}: control, e-mailed while AI is on: ${JSON.stringify(mail)}`);
}

/** Generation with in-memory facts but the real row writer, so what is persisted is what the lock reads. */
async function generate(event: Omit<GeneratorEvent, 'seq' | 'workspaceId'>, recipient: Person, facts: Partial<NotificationFacts>) {
  const { ws } = scene;
  const written: string[] = [];
  const rows = notificationGeneratorRows(db);
  const all: NotificationFacts = {
    audience: async () => [recipient.id], projectMessage: async () => null, dmMessage: async () => null, work: async () => null,
    decision: async () => null, result: async () => null, liveInvitation: async () => null,
    names: async (ids) => new Map(ids.map((id) => [id, id === recipient.id ? 'Ada' : 'Someone'])), ...facts,
  };
  const generated: GeneratorEvent = { ...event, seq: 1, workspaceId: ws.id };
  // notifications.event_id references events.
  await pool.query(`INSERT INTO events (id, workspace_id, kind, object_id, actor_id, data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [generated.id, ws.id, generated.kind, generated.objectId, generated.actorId, JSON.stringify(generated.data)]);
  const ports: GeneratorPorts = {
    lockCursor: async () => 0, advanceCursor: async () => undefined, eventsAfter: async () => [generated], facts: all,
    preferences: preferenceRepository({ find: async () => ({ ...DEFAULT_PREFERENCES, channels: {} }), save: async () => undefined, isMuted: async () => false, mutes: async () => [], setMuted: async () => undefined }),
    authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId: ws.id }) },
    insertNotification: async (notification) => { written.push(notification.id); return rows.insertNotification(notification); },
    deliverableSubscriptions: async () => [], emailedRecently: async () => false, insertEmail: async () => true,
    enqueuePush: async () => null, enqueueEmail: async () => null, recordFailure: async () => 1, deadLetter: async () => undefined,
    isolate: async (work) => work(),
  };
  const logged: unknown[] = [];
  const result = await generateNotifications({ run: (work) => work(ports) }, { emailAvailable: false, log: (message, details) => { logged.push([message, details]); } });
  assert.deepEqual([result.processed, result.created, written.length], [1, 1, 1], `the event was processed: ${JSON.stringify(logged)}`);
  return written;
}

const message = (overrides: Partial<ProjectMessageFacts>): ProjectMessageFacts => ({
  id: randomUUID(), workspaceId: scene.ws.id, projectId: scene.place.id, projectName: scene.place.name, conversationId: randomUUID(), opening: 'Sensor notes',
  conversationCreatedBy: { kind: 'human', id: scene.peer.id }, author: { kind: 'human', id: scene.peer.id }, authorName: null, body: 'Ada, can you check the lamp sensor?',
  attachmentCount: 0, sequence: 2, earlierAuthors: [], asked: null, ...overrides,
});
const review = (overrides: Partial<ReviewFacts>): ReviewFacts => ({
  id: randomUUID(), projectId: scene.place.id, projectName: scene.place.name, title: 'Use the 3V sensor', by: { kind: 'agent', id: scene.agentId },
  workOwners: [], agentOwner: scene.owner.id, ...overrides,
});

describe('space AI switch: notifications by AI origin (#642)', () => {
  before(async () => { scene = await assistantScene('ai-notify'); });
  beforeEach(async () => { await ensureSpaceAiAllowed(scene.place.id); });
  after(async () => { await ensureSpaceAiAllowed(scene.place.id); });

  test('a message written by an agent (the event\'s actor is a person, the message\'s author is the agent)', async () => {
    const { owner, agentId } = scene;
    const [id] = await generate({ id: randomUUID(), kind: 'project.message_sent.v1', objectId: scene.place.id, actorId: `human:${scene.peer.id}`, data: { messageId: randomUUID() } }, owner, {
      projectMessage: async () => message({ author: { kind: 'agent', id: agentId }, authorName: 'Ada assistant' }) });
    await assertGated('agent-authored message', owner, scene.place.id, id!, { needsYou: true });
  });

  test('a question card asked by an agent', async () => {
    const { owner, agentId } = scene;
    const [id] = await generate({ id: randomUUID(), kind: 'project.message_sent.v1', objectId: scene.place.id, actorId: `agent:${agentId}`, data: { messageId: randomUUID() } }, owner, {
      projectMessage: async () => message({ author: { kind: 'agent', id: agentId }, authorName: 'Ada assistant', body: 'Which sensor?', asked: { userId: owner.id, question: 'Which sensor?' } }) });
    await assertGated('agent question', owner, scene.place.id, id!, { needsYou: true });
  });

  test('a decision proposed by an agent and a result recorded by an agent (the event\'s actor is a person)', async () => {
    const { owner } = scene;
    const [decision] = await generate({ id: randomUUID(), kind: 'project.decision_proposed.v1', objectId: scene.place.id, actorId: `human:${scene.peer.id}`, data: { decisionId: randomUUID() } }, owner, {
      decision: async () => review({}) });
    await assertGated('agent decision', owner, scene.place.id, decision!);
    const [result] = await generate({ id: randomUUID(), kind: 'project.result_recorded.v1', objectId: scene.place.id, actorId: `human:${scene.peer.id}`, data: { resultId: randomUUID() } }, owner, {
      result: async () => review({ title: 'Bench result' }) });
    await assertGated('agent result', owner, scene.place.id, result!);
  });

  test('work assigned by an agent (the actor is the agent)', async () => {
    const { owner, agentId } = scene;
    const workId = (await scene.task(owner, 'Recalibrate the lamp')).id;
    const [id] = await generate({ id: randomUUID(), kind: 'project.work_updated.v1', objectId: scene.place.id, actorId: `agent:${agentId}`, data: { workId, assignedTo: owner.id } }, owner, {
      work: async () => ({ id: workId, projectId: scene.place.id, projectName: scene.place.name, title: 'Recalibrate', number: 1, ownerUserId: owner.id, waitingForUserId: null, status: 'open', blocker: null }) });
    await assertGated('work assigned by an agent', owner, scene.place.id, id!);
  });

  test('controls: what people write is not AI origin and stays while AI is off', async () => {
    const { owner, peer } = scene;
    const [id] = await generate({ id: randomUUID(), kind: 'project.message_sent.v1', objectId: scene.place.id, actorId: `human:${peer.id}`, data: { messageId: randomUUID() } }, owner, {
      projectMessage: async () => message({}) });
    assert.equal(await aiOrigin(id!), false, 'a person\'s message is not AI origin');
    const subscriptionId = await subscription(owner);
    await setSpaceAi(scene.place.id, 'blocked');
    try {
      assert.ok(await pushDeliveryRepository(db).findTarget({ notificationId: id!, subscriptionId, userId: owner.id }), 'still pushed');
      assert.ok((await unreadIn(owner)).items.some((item) => item.id === id), 'still in the Inbox');
    } finally { await setSpaceAi(scene.place.id, 'allowed'); }
  });

  test('an assistant\'s schedule paused notice', async () => {
    const { owner, place } = scene;
    const id = await assistantJobRows(db).notify(owner.id, place.id, 'Paused Daily check: it could not run', 'Your assistant paused this schedule. Turn it on again when it is fixed.', '/settings/assistant');
    await assertGated('assistant schedule notice', owner, scene.place.id, id);
  });

  test('an operator request', async () => {
    const { lead: owner, ws, place, peer } = scene;
    // An operator request belongs to the company, not to a space: it is not hidden by any space's switch.
    const operator = expectStatus(await peer.browser.request('POST', assistantOperatorRequestPath(ws.id), { body: {} }), 201) as { sent: number };
    assert.ok(operator.sent >= 1, 'the owner was told');
    const note = (await pool.query(`SELECT id, source_type FROM notifications WHERE user_id = $1 AND title LIKE '% would like to use their % plan here' ORDER BY created_at DESC LIMIT 1`, [owner.id])).rows[0];
    await setSpaceAi(place.id, 'blocked');
    try { assert.ok((await unreadIn(owner)).items.some((item) => item.id === note.id), 'still in the Inbox while a space has AI off'); }
    finally { await setSpaceAi(place.id, 'allowed'); }
  });
});
