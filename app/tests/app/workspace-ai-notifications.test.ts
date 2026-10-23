import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PgBoss } from 'pg-boss';
import { INBOX_PATH, NEEDS_YOU_PATH, PERSONAL_RUN_CONSENT_VERSION, assistantChangeActionPath, assistantOperatorRequestPath, assistantSettingsPath, type AssistantSettings, type InboxResponse, type NeedsYouResponse, type Workspace, type Project, type Conversation } from '@flux/contracts';
import {
  DEFAULT_PREFERENCES, deliverNotificationEmail, deliverPlainSummary, generateNotifications, preferenceRepository,
  type GeneratorEvent, type GeneratorPorts, type NotificationFacts, type NotificationMailer, type ProjectMessageFacts, type ReviewFacts,
} from '@flux/core';
import { assistantJobRows, assistantReactionRows, morningSummaryRows, notificationGeneratorRows, pushDeliveryRepository } from '@flux/db';
import { emailUnitOfWork } from '../../apps/worker/src/notifications/adapters.js';
import { summaryUnitOfWork } from '../../apps/worker/src/jobs/morning-summary.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { publicOrigin } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { ensureWorkspaceAiAllowed, setWorkspaceAi } from './support/workspace-ai.js';

// F-029 follow-up (#642): the "AI origin" of a notification is written by whoever creates it, from the actor or the source, and the lock
// reads that column. One test per writer: a push and an e-mail queued before the flip are skipped while AI is off, the Inbox list, the unread
// count, the direct read, Needs you and the plain morning-summary count leave the item out, and the same notification delivers once AI is on.

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
async function assertGated(label: string, recipient: Person, workspaceId: string, notificationId: string, expectation: Expectation = {}) {
  // Every reason on every channel, so the controls show what is delivered while AI is on.
  const everything = { mention: 1, question: 1, reply: 1, dm: 1, assigned: 1, review: 1, invitation: 1 };
  expectStatus(await recipient.browser.request('PATCH', '/api/v1/notification-preferences', { body: { channels: Object.fromEntries(Object.keys(everything).map((reason) => [reason, { inApp: true, push: true, email: true }])) } }), 200);
  assert.equal(await aiOrigin(notificationId), true, `${label}: the writer persisted ai_origin`);
  const subscriptionId = await subscription(recipient);
  const emailId = randomUUID();
  await pool.query(`INSERT INTO notification_emails (id, notification_id, user_id, address_kind) VALUES ($1, $2, $3, 'account')`, [emailId, notificationId, recipient.id]);
  const target = () => pushDeliveryRepository(db).findTarget({ notificationId, subscriptionId, userId: recipient.id });
  const summaryRows = async () => (await morningSummaryRows(db).unread(recipient.id, 200)).map((row) => row.id);

  const hiddenCount = Number((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND workspace_id = $2 AND in_inbox AND read_at IS NULL AND ai_origin`,
    [recipient.id, workspaceId])).rows[0].n);
  assert.ok(hiddenCount >= 1, `${label}: the item is an unread AI-origin Inbox row`);
  const on = await unreadIn(recipient);
  assert.ok(on.items.some((item) => item.id === notificationId), `${label}: control, listed while AI is on`);
  assert.ok(await target(), `${label}: control, a push target while AI is on`);
  assert.ok((await summaryRows()).includes(notificationId), `${label}: control, in the plain summary count while AI is on`);
  if (expectation.needsYou) assert.ok((await needsYouKeys(recipient)).includes(`note:${notificationId}`), `${label}: control, in Needs you while AI is on`);

  const epoch = await setWorkspaceAi(workspaceId, 'blocked');
  try {
    assert.equal(await target(), null, `${label}: a push queued before the flip is not sent`);
    const sent: string[] = [];
    const mailer = { send: async (message: { to: string }) => { sent.push(message.to); return { messageId: randomUUID() }; } } as unknown as NotificationMailer;
    const mail = await deliverNotificationEmail({ available: true, origin: publicOrigin, uow: emailUnitOfWork(db, fakeBoss().boss), mailer }, { emailId });
    assert.equal((mail as { reason?: string }).reason, 'AI is off in this workspace', `${label}: ${JSON.stringify(mail)}`);
    assert.equal(sent.length, 0, `${label}: no e-mail left`);
    const off = await unreadIn(recipient);
    assert.ok(!off.items.some((item) => item.id === notificationId), `${label}: left out of the Inbox list`);
    assert.equal(off.unread, on.unread - hiddenCount, `${label}: and out of the unread count`);
    assert.equal((await recipient.browser.request('GET', `${INBOX_PATH}/${notificationId}`)).status, 404, `${label}: a direct read finds nothing`);
    assert.ok(!(await needsYouKeys(recipient)).includes(`note:${notificationId}`), `${label}: left out of Needs you`);
    assert.ok(!(await summaryRows()).includes(notificationId), `${label}: left out of the plain summary count`);
  } finally {
    await setWorkspaceAi(workspaceId, 'allowed');
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

describe('workspace AI lock: notifications by AI origin (#642)', () => {
  before(async () => { scene = await assistantScene('ai-notify'); });
  beforeEach(async () => { await ensureWorkspaceAiAllowed(scene.ws.id); });
  after(async () => { await ensureWorkspaceAiAllowed(scene.ws.id); });

  test('a message written by an agent (the event\'s actor is a person, the message\'s author is the agent)', async () => {
    const { owner, ws, agentId } = scene;
    const [id] = await generate({ id: randomUUID(), kind: 'project.message_sent.v1', objectId: scene.place.id, actorId: `human:${scene.peer.id}`, data: { messageId: randomUUID() } }, owner, {
      projectMessage: async () => message({ author: { kind: 'agent', id: agentId }, authorName: 'Ada assistant' }) });
    await assertGated('agent-authored message', owner, ws.id, id!, { needsYou: true });
  });

  test('a question card asked by an agent', async () => {
    const { owner, ws, agentId } = scene;
    const [id] = await generate({ id: randomUUID(), kind: 'project.message_sent.v1', objectId: scene.place.id, actorId: `agent:${agentId}`, data: { messageId: randomUUID() } }, owner, {
      projectMessage: async () => message({ author: { kind: 'agent', id: agentId }, authorName: 'Ada assistant', body: 'Which sensor?', asked: { userId: owner.id, question: 'Which sensor?' } }) });
    await assertGated('agent question', owner, ws.id, id!, { needsYou: true });
  });

  test('a decision proposed by an agent and a result recorded by an agent (the event\'s actor is a person)', async () => {
    const { owner, ws } = scene;
    const [decision] = await generate({ id: randomUUID(), kind: 'project.decision_proposed.v1', objectId: scene.place.id, actorId: `human:${scene.peer.id}`, data: { decisionId: randomUUID() } }, owner, {
      decision: async () => review({}) });
    await assertGated('agent decision', owner, ws.id, decision!);
    const [result] = await generate({ id: randomUUID(), kind: 'project.result_recorded.v1', objectId: scene.place.id, actorId: `human:${scene.peer.id}`, data: { resultId: randomUUID() } }, owner, {
      result: async () => review({ title: 'Bench result' }) });
    await assertGated('agent result', owner, ws.id, result!);
  });

  test('work assigned by an agent (the actor is the agent)', async () => {
    const { owner, ws, agentId } = scene;
    const workId = (await scene.task(owner, 'Recalibrate the lamp')).id;
    const [id] = await generate({ id: randomUUID(), kind: 'project.work_updated.v1', objectId: scene.place.id, actorId: `agent:${agentId}`, data: { workId, assignedTo: owner.id } }, owner, {
      work: async () => ({ id: workId, projectId: scene.place.id, projectName: scene.place.name, title: 'Recalibrate', number: 1, ownerUserId: owner.id, waitingForUserId: null, status: 'open', blocker: null }) });
    await assertGated('work assigned by an agent', owner, ws.id, id!);
  });

  test('controls: what people write is not AI origin and stays while AI is off', async () => {
    const { owner, ws, peer } = scene;
    const [id] = await generate({ id: randomUUID(), kind: 'project.message_sent.v1', objectId: scene.place.id, actorId: `human:${peer.id}`, data: { messageId: randomUUID() } }, owner, {
      projectMessage: async () => message({}) });
    assert.equal(await aiOrigin(id!), false, 'a person\'s message is not AI origin');
    const subscriptionId = await subscription(owner);
    await setWorkspaceAi(ws.id, 'blocked');
    try {
      assert.ok(await pushDeliveryRepository(db).findTarget({ notificationId: id!, subscriptionId, userId: owner.id }), 'still pushed');
      assert.ok((await unreadIn(owner)).items.some((item) => item.id === id), 'still in the Inbox');
      assert.ok((await morningSummaryRows(db).unread(owner.id, 200)).some((row) => row.id === id), 'still counted in the plain summary');
    } finally { await setWorkspaceAi(ws.id, 'allowed'); }
  });

  test('an assistant\'s note on a task', async () => {
    const { owner, ws, place } = scene;
    const taskId = randomUUID();
    const rule = { id: randomUUID(), workspaceId: ws.id, projectId: place.id, projectName: place.name, ownerUserId: owner.id, event: 'failed_result', action: 'tell', enabled: true, dailyLimit: 10, version: 1 };
    const event = { id: randomUUID(), reactionId: rule.id, ownerUserId: owner.id, objectId: taskId, sourceId: randomUUID(), action: 'tell', event: 'failed_result', reactionVersion: 1, state: 'running', runId: null, createdAt: new Date(), data: null, aiEpoch: 1 };
    await pool.query(`INSERT INTO assistant_reactions(id,workspace_id,project_id,owner_user_id,event,action,enabled) VALUES($1,$2,$3,$4,'failed_result','tell',true)`, [rule.id, ws.id, place.id, owner.id]);
    await pool.query(`INSERT INTO assistant_reaction_events(reaction_id,owner_user_id,object_id,source_id,action,event,reaction_version,state,ai_epoch,id) VALUES($1,$2,$3,$4,'tell','failed_result',1,'running',(SELECT epoch FROM workspace_ai_policies WHERE workspace_id=$5),$6)`,
      [rule.id, owner.id, taskId, event.sourceId, ws.id, event.id]);
    await assistantReactionRows(db).deliver(event as never, rule as never, 'The result contradicts the task; check the criteria.');
    const id = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1 AND title = 'Your assistant has a note for your task' AND url LIKE $2`, [owner.id, `%${taskId}`])).rows[0].id as string;
    await assertGated('assistant reaction note', owner, ws.id, id, { needsYou: true });
  });

  test('an assistant\'s schedule paused notice', async () => {
    const { owner, ws, place } = scene;
    const id = await assistantJobRows(db).notify(owner.id, place.id, 'Paused Daily check: it could not run', 'Your assistant paused this schedule. Turn it on again when it is fixed.', '/settings/assistant');
    await assertGated('assistant schedule notice', owner, ws.id, id);
  });

  test('an assistant-written morning summary (the plain count is not AI origin)', async () => {
    const { owner, ws, place } = scene;
    const subscriptionId = await subscription(owner);
    const { boss } = fakeBoss();
    const uow = summaryUnitOfWork(db, boss);
    await uow.run((ports) => deliverPlainSummary(ports, owner.id));
    const plain = (await pool.query(`SELECT id, ai_origin FROM notifications WHERE user_id = $1 AND delivery_kind = 'morning_summary' ORDER BY created_at DESC LIMIT 1`, [owner.id])).rows[0];
    assert.equal(plain.ai_origin, false, 'the plain count is not AI origin');
    await uow.run((ports) => deliverPlainSummary(ports, owner.id, 'Your assistant: the lamp sensor is on track.'));
    const written = (await pool.query(`SELECT id, ai_origin FROM notifications WHERE user_id = $1 AND delivery_kind = 'morning_summary' ORDER BY created_at DESC, id LIMIT 1`, [owner.id])).rows[0];
    assert.equal(written.ai_origin, true, 'the assistant-written line is AI origin');
    const target = () => pushDeliveryRepository(db).findTarget({ notificationId: written.id, subscriptionId, userId: owner.id });
    assert.ok(await target(), 'control: pushed while AI is on');
    await setWorkspaceAi(ws.id, 'blocked');
    try {
      assert.equal(await target(), null, 'the assistant-written summary queued before the flip is not pushed');
      assert.ok(await pushDeliveryRepository(db).findTarget({ notificationId: plain.id, subscriptionId, userId: owner.id }), 'the plain one is');
    } finally { await setWorkspaceAi(ws.id, 'allowed'); }
    assert.ok(place.id);
  });

  test('the plain morning-summary count leaves out AI-origin items while AI is off', async () => {
    const { owner, ws } = scene;
    const { boss } = fakeBoss();
    const uow = summaryUnitOfWork(db, boss);
    const unread = async () => (await morningSummaryRows(db).unread(owner.id, 200)).length;
    /** The number the plain summary announces now (0 when there is nothing to announce). */
    const announced = async () => {
      const known = new Set((await pool.query(`SELECT id FROM notifications WHERE user_id = $1 AND delivery_kind = 'morning_summary'`, [owner.id])).rows.map((row) => row.id as string));
      if (await uow.run((ports) => deliverPlainSummary(ports, owner.id)) === 'empty') return 0;
      const fresh = (await pool.query(`SELECT id, title FROM notifications WHERE user_id = $1 AND delivery_kind = 'morning_summary'`, [owner.id])).rows
        .filter((row) => !known.has(row.id as string));
      assert.equal(fresh.length, 1, 'one summary was stored');
      return Number(/^(\d+)\+? things?/.exec(fresh[0].title as string)?.[1]);
    };
    const hiddenRows = Number((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND workspace_id = $2 AND in_inbox AND read_at IS NULL AND ai_origin`, [owner.id, ws.id])).rows[0].n);
    assert.ok(hiddenRows > 0, 'the earlier tests left AI-origin items unread');
    const [rowsOn, countOn] = [await unread(), await announced()];
    assert.equal(countOn, rowsOn, 'control: the summary announces every unread item while AI is on');
    await setWorkspaceAi(ws.id, 'blocked');
    try {
      assert.equal(await unread(), rowsOn - hiddenRows, 'the unread rows it counts drop by exactly the AI-origin items');
      assert.equal(await announced(), countOn - hiddenRows, 'and so does the number it announces');
    } finally { await setWorkspaceAi(ws.id, 'allowed'); }
  });

  test('a join request from an assistant and an operator request', async () => {
    const { owner, ws, place, peer, connections, runs } = scene;
    // Jonas's assistant asks to join a project he cannot manage; Ada (owner) is asked.
    const requester = await person('ai-notify-requester');
    await addMember(owner, ws.id, requester, 'member');
    const agent = expectStatus(await requester.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Requester assistant', owner: 'self' } }), 201) as { id: string };
    connections.connect(requester.id, randomUUID());
    await runs.enable(human(requester), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agent.id });
    const target = await createProject(owner, ws.id, 'Join target', 'workspace');
    expectStatus(await requester.browser.request('POST', `/api/v1/projects/${target.id}/assistant-join-requests`), 201);
    const join = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1 AND source_id = $2 AND assistant_join_request_id IS NOT NULL`, [owner.id, target.id])).rows[0].id as string;
    await assertGated('assistant join request', owner, ws.id, join, { needsYou: true });
    const operator = expectStatus(await peer.browser.request('POST', assistantOperatorRequestPath(ws.id), { body: {} }), 201) as { sent: number };
    assert.ok(operator.sent >= 1, 'the owner was told');
    const note = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1 AND title LIKE '% would like to use their % plan here' ORDER BY created_at DESC LIMIT 1`, [owner.id])).rows[0].id as string;
    await assertGated('operator request', owner, ws.id, note, { needsYou: true });
    assert.ok(place.id);
  });
});

describe('workspace AI lock: an assistant suggestion to another person (#642)', () => {
  let ada: Person; let jonas: Person; let jonasWs: Workspace; let shared: Project; let sharedThread: Conversation; let ctx: AssistantScene;
  before(async () => {
    ctx = await assistantScene('ai-notify-suggest');
    ada = ctx.owner; jonas = ctx.peer;
    jonasWs = await createWorkspace(jonas, 'Jonas lab');
    await addMember(jonas, jonasWs.id, ada, 'member');
    shared = await createProject(jonas, jonasWs.id, 'Shared rig', 'restricted');
    await grant(jonas, shared.id, ada, 'contributor');
    const jonasAgent = (expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${jonasWs.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    await ctx.runs.selectAgent(human(ada), { agentId: jonasAgent });
    expectStatus(await jonas.browser.request('POST', `/api/v1/projects/${shared.id}/grants`, { body: { principal: { kind: 'agent', id: jonasAgent }, role: 'contributor' } }), 201);
    sharedThread = expectStatus(await jonas.browser.request('POST', `/api/v1/projects/${shared.id}/conversations`,
      { body: { body: 'Rig notes', clientMessageId: randomUUID() } }), 201) as Conversation;
    const path = assistantSettingsPath(jonasWs.id, ada.id);
    const current = expectStatus(await ada.browser.request('GET', path), 200) as unknown as AssistantSettings;
    if (!current.policy.selectedProjectIds.includes(shared.id))
      expectStatus(await ada.browser.request('PATCH', path, { body: { projectMode: 'chosen', selectedProjectIds: [shared.id] }, headers: { 'if-match': `"${current.version}"` } }), 200);
  });
  after(async () => { await ensureWorkspaceAiAllowed(jonasWs.id); });

  test('the suggestion Ada sends to Jonas', async () => {
    const run = await ctx.liveRun(sharedThread);
    await pool.query(`UPDATE project_grants SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [shared.id, ada.id]);
    try {
      await run.call('flux_create_task', { task: { title: 'Recalibrate the bench' } });
      const [row] = (await pool.query(`SELECT id, version FROM assistant_changes WHERE run_id = $1`, [run.runId])).rows as { id: string; version: number }[];
      expectStatus(await ada.browser.request('POST', assistantChangeActionPath(row!.id, 'send'), { body: { expectedVersion: row!.version } }), 200);
      const id = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1 AND title LIKE '%assistant suggests%' ORDER BY created_at DESC LIMIT 1`, [jonas.id])).rows[0].id as string;
      await assertGated('assistant suggestion', jonas, jonasWs.id, id);
    } finally {
      await pool.query(`UPDATE project_grants SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [shared.id, ada.id]);
      await ctx.complete(run.runId);
    }
  });
});
