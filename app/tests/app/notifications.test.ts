import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  DEFAULT_PREFERENCES,
  NOTIFICATION_EMAIL_JOB,
  applyPreferenceChange,
  buildNotificationEmail,
  addressLimitKey,
  deliverNotificationEmail,
  localMinutes,
  loadNotificationMailConfig,
  normalizeEmail,
  type NotificationMailer,
  type PushSendJob,
} from '@flux/core';
import { MAX_EXTRA_ADDRESSES, type InboxItem, type InboxResponse, type NotificationPreferences, type NotificationReason, type VerifiedNotificationAddress } from '@flux/contracts';
import { emailUnitOfWork, smtpNotificationMailer } from '../../apps/worker/src/notifications/index.js';
import { PgBoss } from 'pg-boss';
import { createVapidAuthorizer, deliverPush } from '../../apps/worker/src/push/index.js';
import { loadPushSenderConfig } from '@flux/core';
import { EVENTS_CHANNEL, notificationEmailRows } from '@flux/db';
import { connectionString, db, pool } from './support/db.js';
import { Browser, mailpitUrl, publicOrigin, register, signIn } from './support/http.js';
import { addMember, expectStatus, password, person, project, removeMember, workspace, type Person } from './support/people.js';
import { recordedPushes, subscribe, waitFor } from './support/push.js';

// Notifications from committed events, preferences, delivery addresses and email (issue #116)
// against the running API and worker containers, Mailpit and the push mock. Delivery rechecks
// run in-process on real rows where timing matters.

const mailConfig = loadNotificationMailConfig();
if (mailConfig.status !== 'available') throw new Error('The test stack must configure SMTP');
const origin = mailConfig.origin;
const smtp = smtpNotificationMailer(mailConfig);
after(() => smtp.close());
// Sends the jobs delivery itself queues (a promoted same-mailbox copy, #329).
const vapid = createVapidAuthorizer();
const queue = new PgBoss({ connectionString, migrate: false });
before(() => queue.start());
after(() => queue.stop());

/** A person with a real display name, which mentions match against. */
async function named(name: string, email: string): Promise<Person> {
  const { browser } = await register(email, password, name);
  const me = expectStatus(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
  return { id: me.user.id, email, browser };
}

async function inbox(someone: Person) {
  return expectStatus(await someone.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse;
}

async function waitForItem(someone: Person, match: (item: InboxItem) => boolean, what: string) {
  return waitFor(async () => (await inbox(someone)).items.find(match), what);
}

async function prefs(someone: Person, change: object) {
  return expectStatus(await someone.browser.request('PATCH', '/api/v1/notification-preferences', { body: change }), 200) as NotificationPreferences;
}

async function conversation(someone: Person, projectId: string, body: string) {
  return expectStatus(await someone.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string; messages: { id: string }[] };
}

async function reply(someone: Person, conversationId: string, body: string) {
  return expectStatus(await someone.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
}

async function dm(from: Person, workspaceId: string, to: Person) {
  const created = await from.browser.request('POST', `/api/v1/workspaces/${workspaceId}/dms`, { body: { participantIds: [to.id] } });
  assert.ok(created.status === 201 || created.status === 200, created.text);
  return (created.json as { id: string }).id;
}

async function dmMessage(from: Person, dmId: string, body: string) {
  return expectStatus(await from.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
}

interface MailpitMessage { ID: string; Subject: string; To: { Address: string }[] }

async function mailsTo(address: string): Promise<MailpitMessage[]> {
  const response = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  return (await response.json() as { messages: MailpitMessage[] }).messages;
}

async function mailText(id: string) {
  const message = await (await fetch(`${mailpitUrl}/api/v1/message/${id}`)).json() as { Text: string; HTML: string; Subject: string };
  const headers = await (await fetch(`${mailpitUrl}/api/v1/message/${id}/headers`)).json() as Record<string, string[]>;
  return { ...message, headers };
}

async function waitForMails(address: string, count: number, what: string) {
  return waitFor(async () => { const mails = await mailsTo(address); return mails.length >= count ? mails : null; }, what);
}

async function notificationRows(userId: string) {
  return (await pool.query('SELECT id, event_id, reason, source_type, source_id FROM notifications WHERE user_id = $1', [userId])).rows as { id: string; event_id: string; reason: NotificationReason }[];
}

async function emailRows(userId: string) {
  return (await pool.query('SELECT id, notification_id, address_kind, status, skip_reason, address FROM notification_emails WHERE user_id = $1 ORDER BY created_at', [userId])).rows as { id: string; notification_id: string; address_kind: string; status: string; skip_reason: string | null; address: string | null }[];
}

/**
 * Wakes the generator as a committed event does. The generator looks on its own only every 30 s (#862), and a test that moves the
 * cursor with a plain UPDATE commits no event, so it sends the wake-up the event trigger would have sent.
 */
async function wakeGenerator() {
  await pool.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, '']);
}

/** Waits until the generator has passed every event committed so far. */
async function generatorCaughtUp() {
  const { rows } = await pool.query('SELECT max(seq) AS seq FROM events');
  const target = Number(rows[0].seq);
  await waitFor(async () => Number((await pool.query("SELECT seq FROM notification_cursor WHERE id = 'generator'")).rows[0].seq) >= target, 'the generator to catch up');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quiet hours that cover the current minute in a zone, so push and email are not sent (C-31) while the inbox fills. */
function quietNow(timeZone = 'UTC') {
  const start = (localMinutes(new Date(), timeZone) + 1440 - 30) % 1440;
  const end = (start + 120) % 1440;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { enabled: true, start: clock(start), end: clock(end), timeZone };
}

/**
 * Quiet hours send nothing, so a test that must run a delivery itself (without the worker racing it) queues the email row
 * of a stored notification here, with the job held far in the future, as the generator would have outside quiet hours.
 */
async function queueEmailRow(userId: string, notificationId: string, addressKind: 'account' | 'extra' = 'account') {
  const id = randomUUID();
  const addressId = addressKind === 'extra' ? (await pool.query('SELECT id FROM notification_addresses WHERE user_id = $1 ORDER BY created_at LIMIT 1', [userId])).rows[0]?.id ?? null : null;
  await pool.query('INSERT INTO notification_emails (id, notification_id, user_id, address_kind, address_id) VALUES ($1, $2, $3, $4, $5)', [id, notificationId, userId, addressKind, addressId]);
  await queue.send(NOTIFICATION_EMAIL_JOB, { emailId: id }, { singletonKey: id, startAfter: new Date(Date.now() + 3_600_000) });
  return id;
}

describe('the address limit counts mailboxes (#1070)', () => {
  test('its key drops a +tag, takes one letter form and lower case, and leaves the stored address alone', () => {
    assert.equal(addressLimitKey('Name+News@Example.ORG'), 'name@example.org');
    assert.equal(addressLimitKey('name+a+b@example.org'), 'name@example.org');
    assert.equal(addressLimitKey('name@example.org'), 'name@example.org');
    assert.equal(addressLimitKey('+only@example.org'), '+only@example.org', 'a local part that starts with + is kept whole');
    assert.equal(addressLimitKey('jose\u0301+x@example.org'), 'jos\u00e9@example.org');
    assert.equal(normalizeEmail('Name+News@Example.ORG'), 'Name+News@example.org');
  });
});

describe('preference rules', () => {
  test('changes are validated and applied: the level, Email me too and quiet hours', () => {
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { quietHours: { start: '25:00' } }), /time/);
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { quietHours: { timeZone: 'Mars/Olympus' } }), /time zone/);
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { level: 'loud' as never }), /level/);
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { emailMe: 'sometimes' as never }), /emailMe/);
    const next = applyPreferenceChange(DEFAULT_PREFERENCES, { level: 'everything', emailMe: false, quietHours: { enabled: true, start: '21:30', end: '06:45', timeZone: 'Asia/Tokyo' } });
    assert.deepEqual([next.level, next.emailMe, next.quietStart, next.quietEnd, next.timeZone], ['everything', false, 21 * 60 + 30, 6 * 60 + 45, 'Asia/Tokyo']);
  });

  test('the email is generic: a fixed subject, an in-app link and one-click unsubscribe', () => {
    const mail = buildNotificationEmail({ origin: 'https://flux.example.org', to: 'a@example.org', emailId: 'e1', notificationId: 'n1', token: 'tok' });
    assert.equal(mail.subject, 'New activity in Flux');
    assert.match(mail.text, /https:\/\/flux\.example\.org\/inbox\/n1/);
    assert.equal(mail.headers['List-Unsubscribe'], '<https://flux.example.org/api/v1/notifications/unsubscribe?token=tok>');
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.equal(mail.messageId, '<notification-e1@flux.example.org>');
  });
});

describe('notifications from committed events', () => {
  let ada: Person;
  let ben: Person;
  let cy: Person;
  let workspaceId: string;
  let projectId: string;

  before(async () => {
    ada = await person('Ada Quill');
    ben = await person('Ben Oduya');
    cy = await person('Cyra Lind');
    workspaceId = (await workspace(ada, 'Harbour studio')).id;
    await addMember(ada, workspaceId, ben, 'member');
    await addMember(ada, workspaceId, cy, 'member');
    projectId = (await project(ada, workspaceId, 'Tide tables', 'workspace')).id;
  });

  test('mentions, questions and replies reach the right people once, with why and a link to the message', async () => {
    const thread = await conversation(ada, projectId, 'Kickoff: printing the autumn tide tables');
    const asked = await reply(ben, thread.id, '@Ada Quill can you check the October proofs?');
    const mentioned = await reply(cy, thread.id, 'Thanks @Ben, the proofs are uploaded');

    const question = await waitForItem(ada, (item) => item.url?.endsWith(asked.id) === true, 'Ada\'s question');
    assert.equal(question.reason, 'question');
    assert.equal(question.title, 'Ben Oduya asked you in Tide tables');
    assert.equal(question.body, '@Ada Quill can you check the October proofs?');
    assert.deepEqual(question.source, { workspaceId, type: 'project', id: projectId });
    assert.equal(question.url, `/projects/${projectId}/conversations/${thread.id}#message-${asked.id}`);

    const mention = await waitForItem(ben, (item) => item.url?.endsWith(mentioned.id) === true, 'Ben\'s mention');
    assert.equal(mention.reason, 'mention');
    // Ada started the conversation: Cyra's message is a reply for her, and nobody hears of their own message.
    const replied = await waitForItem(ada, (item) => item.url?.endsWith(mentioned.id) === true, 'Ada\'s reply');
    assert.equal(replied.reason, 'reply');
    assert.match(replied.title, /^Cyra Lind replied in “Kickoff: printing the autumn tide tables”$/);
    await generatorCaughtUp();
    assert.equal((await inbox(cy)).items.filter((item) => item.source.id === projectId).length, 0);
    assert.equal((await inbox(ben)).items.filter((item) => item.url?.endsWith(asked.id)).length, 0);
  });

  test('a direct message, assigned work and work to review each notify with their own reason', async () => {
    const dmId = await dm(ada, workspaceId, ben);
    const message = await dmMessage(ada, dmId, 'Lunch at the harbour on Friday?');
    const direct = await waitForItem(ben, (item) => item.reason === 'dm' && item.url?.endsWith(message.id) === true, 'Ben\'s DM');
    assert.equal(direct.title, 'Ada Quill sent you a message');
    assert.deepEqual(direct.source, { workspaceId, type: 'dm', id: dmId });
    assert.equal(direct.url, `/dm/${dmId}#message-${message.id}`);

    const work = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${projectId}/work`, { body: { title: 'Proofread the October page', owner: { kind: 'human', id: ben.id } } }), 201) as { id: string };
    const own = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${projectId}/work`, { body: { title: 'Ada keeps this', owner: { kind: 'human', id: ada.id } } }), 201) as { id: string };
    const assigned = await waitForItem(ben, (item) => item.reason === 'assigned', 'Ben\'s assignment');
    assert.equal(assigned.title, 'Ada Quill assigned you “Proofread the October page”');
    assert.equal(assigned.url, `/projects/${projectId}/tasks?open=work:${work.id}`);

    const decision = expectStatus(await cy.browser.request('POST', `/api/v1/projects/${projectId}/decisions`, { body: { title: 'Print on recycled paper', affects: [work.id] } }), 201) as { id: string };
    const review = await waitForItem(ben, (item) => item.url?.endsWith(`decision:${decision.id}`) === true, 'Ben\'s decision review');
    assert.equal(review.reason, 'review');
    assert.equal(review.title, 'Decision proposed: Print on recycled paper');
    await generatorCaughtUp();
    assert.equal((await inbox(ada)).items.filter((item) => item.url?.includes(own.id)).length, 0, 'assigning yourself notifies nobody');
  });

  test('each (person, event) is stored once, even when the generator processes events again', async () => {
    const thread = await conversation(cy, projectId, '@Ben Oduya one more question about the ferry page?');
    await waitForItem(ben, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'Ben\'s question');
    const before = await notificationRows(ben.id);
    const emails = (await emailRows(ben.id)).length;
    const { rows } = await pool.query("SELECT min(seq) AS seq FROM events WHERE workspace_id = $1", [workspaceId]);
    // Rewind the shared cursor over this workspace's events; the unique (user, event) row stops repeats.
    await pool.query("UPDATE notification_cursor SET seq = LEAST(seq, $1) WHERE id = 'generator'", [Number(rows[0].seq) - 1]);
    await wakeGenerator();
    await generatorCaughtUp();
    const afterRows = await notificationRows(ben.id);
    assert.deepEqual(afterRows.map((row) => row.id).sort(), before.map((row) => row.id).sort());
    assert.equal((await emailRows(ben.id)).length, emails);
    const perEvent = new Map<string, number>();
    for (const row of afterRows) perEvent.set(row.event_id, (perEvent.get(row.event_id) ?? 0) + 1);
    assert.ok([...perEvent.values()].every((count) => count === 1));
  });

  test('a muted place notifies nothing, on any channel; unmuting brings it back', async () => {
    const muted = expectStatus(await cy.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: projectId, muted: true } }), 200) as NotificationPreferences;
    assert.deepEqual(muted.muted, [{ type: 'project', id: projectId, name: 'Tide tables' }]);
    const thread = await conversation(ada, projectId, '@Cyra Lind the harbour master sent new times');
    const dmId = await dm(ada, workspaceId, cy);
    const message = await dmMessage(ada, dmId, 'Did you see the new times?');
    // The DM (later in the event log) arrives, so the muted mention before it was skipped.
    await waitForItem(cy, (item) => item.url?.endsWith(message.id) === true, 'Cyra\'s DM');
    assert.equal((await inbox(cy)).items.filter((item) => item.url?.endsWith(thread.messages[0]!.id)).length, 0);
    // Someone else cannot mute a place they cannot read.
    const outsider = await person('Oli Outsider');
    expectStatus(await outsider.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: projectId, muted: true } }), 404);
    const unmuted = expectStatus(await cy.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: projectId, muted: false } }), 200) as NotificationPreferences;
    assert.deepEqual(unmuted.muted, []);
    const again = await conversation(ada, projectId, '@Cyra Lind and one more change');
    await waitForItem(cy, (item) => item.url?.endsWith(again.messages[0]!.id) === true, 'Cyra\'s mention after unmuting');
  });

  test('Nothing still fills the inbox but sends no push; Only what needs me pushes a question, not a plain reply', async () => {
    const { subscription } = await subscribe(cy.browser);
    await prefs(cy, { level: 'nothing' });
    const thread = await conversation(cy, projectId, 'Cyra opens a thread about fonts');
    const plain = await reply(ada, thread.id, 'Serif for the headings');
    const asked = await reply(ada, thread.id, '@Cyra Lind which serif for the tables?');
    await waitForItem(cy, (item) => item.url?.endsWith(plain.id) === true, 'the reply in the inbox');
    await waitForItem(cy, (item) => item.url?.endsWith(asked.id) === true, 'the question in the inbox');
    await sleep(1500);
    assert.equal((await recordedPushes(subscription.mockId)).length, 0, 'Nothing: no push, not even for a question');

    await prefs(cy, { level: 'needsYou' });
    await reply(ada, thread.id, '@Cyra Lind and which sans for the schedule?');
    await waitFor(async () => (await recordedPushes(subscription.mockId)).length === 1, 'the push for the question');
    const quiet = await reply(ada, thread.id, 'No rush on any of this');
    await waitForItem(cy, (item) => item.url?.endsWith(quiet.id) === true, 'the plain reply in the inbox');
    await sleep(1500);
    assert.equal((await recordedPushes(subscription.mockId)).length, 1, 'a plain reply is in the inbox only');
  });

  test('an event that fails is retried after 2 s, then 4 s, and the message behind it waits for exactly that (#862)', async (t) => {
    const flaky = await person('Rhea Marsh');
    await addMember(ada, workspaceId, flaky, 'member');
    // The retry contract (docs/development/notifications.md) is 2, 4 … 60 s. The generator's own poll is 30 s, so only a retry
    // timer meets it: a database trigger refuses Rhea's row on the first two attempts, and the worker is the real one.
    const suffix = randomUUID().replaceAll('-', '');
    const name = `refuse_retry_${suffix}`;
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN
      IF NEW.user_id = '${flaky.id}' AND coalesce((SELECT attempts FROM notification_generation_failures WHERE event_id = NEW.event_id), 0) < 2
      THEN RAISE EXCEPTION 'refused by the retry test'; END IF; RETURN NEW; END $body$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      const started = Date.now();
      const failing = await conversation(ada, projectId, '@Rhea Marsh the survey boat is ready');
      const behind = await conversation(ada, projectId, '@Ben Oduya the survey boat is ready for you too');
      const arrived = new Map<string, number>();
      while (arrived.size < 2 && Date.now() - started < 30_000) {
        if (!arrived.has('flaky') && (await inbox(flaky)).items.some((item) => item.url?.endsWith(failing.messages[0]!.id))) arrived.set('flaky', Date.now() - started);
        if (!arrived.has('behind') && (await inbox(ben)).items.some((item) => item.url?.endsWith(behind.messages[0]!.id))) arrived.set('behind', Date.now() - started);
        await sleep(100);
      }
      t.diagnostic(`retried event reached its inbox after ${arrived.get('flaky')} ms, the message behind it after ${arrived.get('behind')} ms`);
      assert.equal(arrived.size, 2, 'both messages arrive within 30 s');
      // Attempts at about 0.2, 2.2 and 6.3 s. A retry left to the 30 s poll arrives after about 60 s; a hot loop before 2 s.
      assert.ok(arrived.get('flaky')! >= 5_000 && arrived.get('flaky')! < 15_000, 'attempts wait 2 s, then 4 s: not a tight loop, not the 30 s poll');
      assert.ok(arrived.get('behind')! < 15_000);
      const { rows } = await pool.query('SELECT attempts, dead_at FROM notification_generation_failures WHERE event_id = $1', [(await notificationRows(flaky.id))[0]!.event_id]);
      assert.deepEqual(rows.map((row) => [row.attempts, row.dead_at]), [[2, null]]);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON notifications`);
      await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  });
});

describe('email and push delivery', () => {
  let owner: Person;
  let reader: Person;
  let workspaceId: string;
  let projectId: string;

  before(async () => {
    owner = await person('Maja Sten');
    reader = await person('Raf Okoye');
    workspaceId = (await workspace(owner, 'Northside co-op')).id;
    await addMember(owner, workspaceId, reader, 'member');
    projectId = (await project(owner, workspaceId, 'Seed library', 'workspace')).id;
  });

  test('a mention emails the sign-in address a generic notice with no private text and a working unsubscribe', async () => {
    const before = (await mailsTo(reader.email)).length;
    const thread = await conversation(owner, projectId, '@Raf Okoye the secret heirloom tomato list is ready for Ingrid');
    const item = await waitForItem(reader, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'Raf\'s mention');
    const mails = await waitForMails(reader.email, before + 1, 'the notification email');
    const mail = await mailText(mails[0]!.ID);
    assert.equal(mail.Subject, 'New activity in Flux');
    for (const secret of ['heirloom', 'tomato', 'Ingrid', 'Seed library', 'Maja', 'Northside']) assert.ok(!mail.Text.includes(secret) && !mail.Subject.includes(secret), `mail leaks ${secret}`);
    assert.ok(mail.Text.includes(`${publicOrigin || origin}/inbox/${item.id}`));
    const unsubscribe = mail.headers['List-Unsubscribe']?.[0] ?? '';
    assert.equal(mail.headers['List-Unsubscribe-Post']?.[0], 'List-Unsubscribe=One-Click');
    const url = /^<(.+)>$/.exec(unsubscribe)?.[1];
    assert.ok(url?.startsWith(`${origin}/api/v1/notifications/unsubscribe?token=`), unsubscribe);

    // RFC 8058: the mail provider POSTs a form without cookies or Origin.
    const target = new URL(url!);
    const oneClick = await fetch(new URL(`${target.pathname}${target.search}`, process.env.FLUX_API_URL ?? 'http://api:8080'), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(oneClick.status, 200, await oneClick.clone().text());
    assert.deepEqual(await oneClick.json(), { result: 'stopped', stopped: 'account' });
    const settings = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(settings.email.accountEnabled, false, 'the link switches off the address it came to');
    assert.equal(settings.emailMe, true, 'and leaves Email me too as it was (C-49)');
    // Unsubscribing changes nothing about sign-in.
    assert.equal((await signIn(reader.email, password)).response.status, 200);

    const count = (await mailsTo(reader.email)).length;
    const next = await conversation(owner, projectId, '@Raf Okoye another list');
    await waitForItem(reader, (entry) => entry.url?.endsWith(next.messages[0]!.id) === true, 'the next mention');
    await generatorCaughtUp();
    await sleep(1500);
    assert.equal((await mailsTo(reader.email)).length, count, 'no email after unsubscribing');
    await prefs(reader, { accountEnabled: true });
  });

  test('access is rechecked before email and push: someone removed meanwhile receives nothing', async () => {
    const leaver = await person('Lena Vos');
    await addMember(owner, workspaceId, leaver, 'member');
    // Quiet hours store the notification and queue nothing (C-31); the test queues the email itself, then ends them.
    await prefs(leaver, { quietHours: quietNow() });
    const { subscription, id: subscriptionId } = await subscribe(leaver.browser);
    const thread = await conversation(owner, projectId, '@Lena Vos the donor spreadsheet with phone numbers');
    const item = await waitForItem(leaver, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'Lena\'s mention');
    await generatorCaughtUp();
    assert.equal((await emailRows(leaver.id)).length, 0, 'quiet hours queue no email');
    await prefs(leaver, { quietHours: { enabled: false } });
    const emailId = await queueEmailRow(leaver.id, item.id);

    await removeMember(owner, workspaceId, leaver);
    const outcome = await deliverNotificationEmail({ available: true, origin, uow: emailUnitOfWork(db, queue), mailer: smtp }, { emailId });
    assert.deepEqual(outcome, { outcome: 'skipped', reason: 'recipient can no longer read the source' });
    const push = await deliverPush({ db, vapid, config: loadPushSenderConfig() }, { notificationId: item.id, subscriptionId, userId: leaver.id } satisfies PushSendJob);
    assert.equal(push.outcome, 'skipped');
    assert.equal((await mailsTo(leaver.email)).length, 0);
    assert.equal((await recordedPushes(subscription.mockId)).length, 0);
    assert.equal((await inbox(leaver)).items.length, 0, 'the inbox hides what the person can no longer read');
  });

  test('one message that mentions six people reaches every device and mailbox within seconds, not one per backstop (#862)', async (t) => {
    const names = ['Anya Brook', 'Bram Cole', 'Cleo Dunn', 'Dov Eames', 'Edda Frost', 'Finn Gale'];
    const recipients = [];
    for (const name of names) {
      const member = await person(name);
      await addMember(owner, workspaceId, member, 'member');
      recipients.push({ member, ...(await subscribe(member.browser)) });
    }
    // The generator queues six push jobs and six e-mail jobs in one transaction each: one wake-up per queue, then a backlog.
    const started = Date.now();
    await conversation(owner, projectId, `${names.map((name) => `@${name}`).join(' ')} the seed list is ready`);
    const pushAt = new Map<string, number>();
    const mailAt = new Map<string, number>();
    while ((pushAt.size < names.length || mailAt.size < names.length) && Date.now() - started < 20_000) {
      await Promise.all(recipients.map(async ({ member, subscription }) => {
        if (!pushAt.has(member.id) && (await recordedPushes(subscription.mockId)).length) pushAt.set(member.id, Date.now() - started);
        if (!mailAt.has(member.id) && (await mailsTo(member.email)).length) mailAt.set(member.id, Date.now() - started);
      }));
      await sleep(100);
    }
    const seconds = (times: Map<string, number>) => [...times.values()].sort((a, b) => a - b).map((ms) => (ms / 1000).toFixed(1)).join(', ');
    t.diagnostic(`push arrival, s: ${seconds(pushAt)}; e-mail arrival, s: ${seconds(mailAt)}`);
    assert.equal(pushAt.size, names.length, 'every device got its push within 20 s (a 30 s backstop per job would deliver the second after 30 s)');
    assert.equal(mailAt.size, names.length, 'every mailbox got its e-mail within 20 s');
  });

  test('push follows the same preferences: at Nothing the device gets nothing', async () => {
    const { subscription } = await subscribe(reader.browser);
    const dmId = await dm(owner, workspaceId, reader);
    const first = await dmMessage(owner, dmId, 'Seedlings are ready');
    await waitFor(async () => (await recordedPushes(subscription.mockId)).length === 1, 'the first push');
    await waitForItem(reader, (entry) => entry.url?.endsWith(first.id) === true, 'the first DM');
    await prefs(reader, { level: 'nothing' });
    const second = await dmMessage(owner, dmId, 'Pick them up by Sunday');
    await waitForItem(reader, (entry) => entry.url?.endsWith(second.id) === true, 'the second DM');
    await sleep(1500);
    assert.equal((await recordedPushes(subscription.mockId)).length, 1);
    await prefs(reader, { level: 'needsYou' });
  });

  test('retries never send an email twice', async () => {
    const quiet = await person('Quinn Hale');
    await addMember(owner, workspaceId, quiet, 'member');
    await prefs(quiet, { quietHours: quietNow() });
    const thread = await conversation(owner, projectId, '@Quinn Hale please water the trays');
    const stored = await waitForItem(quiet, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'Quinn\'s mention');
    // Quiet hours queued nothing; end them and queue the email here, so the in-process deliveries below are the only ones.
    await prefs(quiet, { quietHours: { enabled: false } });
    const email = { id: await queueEmailRow(quiet.id, stored.id) };
    const options = { available: true, origin, uow: emailUnitOfWork(db, queue) };

    // SMTP refuses: the row goes back to queued and the job is retried.
    const failing: NotificationMailer = { send: async () => ({ kind: 'failed', message: '421 try later' }) };
    await assert.rejects(deliverNotificationEmail({ ...options, mailer: failing }, { emailId: email.id }), /SMTP did not accept/);
    assert.equal((await emailRows(quiet.id))[0]!.status, 'queued');
    // Two deliveries race (a retry overlapping a slow first attempt): one email.
    const results = await Promise.all([1, 2].map(() => deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: email.id })));
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['sent', 'skipped']);
    assert.equal((await emailRows(quiet.id))[0]!.status, 'sent');
    const again = await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: email.id });
    assert.deepEqual(again, { outcome: 'skipped', reason: 'already sent' });
    // A send that may have reached SMTP before a crash (left "sending") is not repeated.
    await pool.query("UPDATE notification_emails SET status = 'sending' WHERE id = $1", [email.id]);
    assert.deepEqual(await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: email.id }), { outcome: 'skipped', reason: 'already sending' });
    await waitForMails(quiet.email, 1, 'the one email');
    await sleep(500);
    assert.equal((await mailsTo(quiet.email)).length, 1);
  });

  test('an extra address is verified by a single-use link, receives email once confirmed and can never sign in', async () => {
    const extra = `raf.home-${randomUUID()}@example.test`;
    const added = expectStatus(await reader.browser.request('POST', '/api/v1/notification-addresses', { body: { email: extra } }), 200) as NotificationPreferences;
    const [address] = added.email.addresses;
    assert.deepEqual({ ...address, id: 'id', sentAt: null }, { id: 'id', email: extra, enabled: true, verified: false, verifiedAt: null, sentAt: null });
    expectStatus(await reader.browser.request('POST', '/api/v1/notification-addresses', { body: { email: reader.email.toUpperCase() } }), 409);
    expectStatus(await reader.browser.request('POST', `/api/v1/notification-addresses/${address!.id}/resend`), 429);
    const [verification] = await waitForMails(extra, 1, 'the verification email');
    const text = (await mailText(verification!.ID)).Text;
    assert.match(text, /can never be used to sign in/);
    const token = new URL(/(http\S+verify\?token=\S+)/.exec(text)![1]!).searchParams.get('token')!;

    // Only the account that added it can verify it.
    expectStatus(await owner.browser.request('POST', '/api/v1/notification-addresses/verify', { body: { token } }), 400);
    const verified = expectStatus(await reader.browser.request('POST', '/api/v1/notification-addresses/verify', { body: { token } }), 200) as VerifiedNotificationAddress;
    assert.equal(verified.confirmed, extra);
    assert.equal(verified.email.addresses[0]?.verified, true);
    expectStatus(await reader.browser.request('POST', '/api/v1/notification-addresses/verify', { body: { token } }), 400, 'single use');

    // An expired link is refused.
    const other = await person('Tess Marlow');
    const pending = `tess.other-${randomUUID()}@example.test`;
    expectStatus(await other.browser.request('POST', '/api/v1/notification-addresses', { body: { email: pending } }), 200);
    const [otherMail] = await waitForMails(pending, 1, 'Tess\'s verification email');
    const otherToken = new URL(/(http\S+verify\?token=\S+)/.exec((await mailText(otherMail!.ID)).Text)![1]!).searchParams.get('token')!;
    await pool.query('UPDATE notification_address_tokens SET expires_at = now() - interval \'1 minute\' WHERE address_id = (SELECT id FROM notification_addresses WHERE user_id = $1)', [other.id]);
    expectStatus(await other.browser.request('POST', '/api/v1/notification-addresses/verify', { body: { token: otherToken } }), 400);

    // Email me too (on again after the unsubscribe above) reaches every address that is switched on: the sign-in address and this one.
    await prefs(reader, { emailMe: true });
    const accountBefore = (await mailsTo(reader.email)).length;
    const room = (await project(owner, workspaceId, 'Compost rota', 'workspace')).id;
    const thread = await conversation(owner, room, '@Raf Okoye the rota for October');
    await waitForItem(reader, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'the mention');
    const [delivered] = await waitForMails(extra, 2, 'the email to the extra address');
    assert.equal((await mailText(delivered!.ID)).Subject, 'New activity in Flux');
    await waitForMails(reader.email, accountBefore + 1, 'the email to the sign-in address');
    await sleep(1000);
    assert.equal((await mailsTo(reader.email)).length, accountBefore + 1, 'one email per address');
    assert.equal((await mailsTo(extra)).length, 2, 'the verification link and one notification');

    // The delivery address is never a login identity: no sign-in, no password reset mail.
    const login = await signIn(extra, password);
    assert.notEqual(login.response.status, 200);
    const extraMails = (await mailsTo(extra)).length;
    const reset = await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email: extra, redirectTo: `${publicOrigin}/reset-password` } });
    assert.equal(reset.status, 200);
    await sleep(1500);
    assert.equal((await mailsTo(extra)).length, extraMails);
    assert.equal((await signIn(reader.email, password)).response.status, 200, 'the sign-in address still works');

    // A second address is listed after the first, gets a confirmation link and no notification until it is opened.
    await skipCooldown(reader);
    const second = `raf.work-${randomUUID()}@example.test`;
    const both = expectStatus(await reader.browser.request('POST', '/api/v1/notification-addresses', { body: { email: second } }), 200) as NotificationPreferences;
    assert.deepEqual(both.email.addresses.map((item) => [item.email, item.verified, item.enabled]), [[extra, true, true], [second, false, true]]);
    expectStatus(await reader.browser.request('POST', '/api/v1/notification-addresses', { body: { email: second.toUpperCase() } }), 409);
    await waitForMails(second, 1, 'the second verification email');

    // Each address has its own switch: this one is off, so the next notification reaches only the sign-in address.
    const off = expectStatus(await reader.browser.request('PATCH', `/api/v1/notification-addresses/${address!.id}`, { body: { enabled: false } }), 200) as NotificationPreferences;
    assert.deepEqual(off.email.addresses.map((item) => item.enabled), [false, true]);
    assert.equal(off.emailMe, true);
    const next = await conversation(owner, (await project(owner, workspaceId, 'Compost rota II', 'workspace')).id, '@Raf Okoye the rota for November');
    await waitForItem(reader, (entry) => entry.url?.endsWith(next.messages[0]!.id) === true, 'the next mention');
    await waitForMails(reader.email, accountBefore + 2, 'the next email to the sign-in address');
    await sleep(1000);
    assert.equal((await mailsTo(extra)).length, extraMails, 'a switched-off address gets nothing');
    assert.equal((await mailsTo(second)).length, 1, 'and neither does one that is not confirmed yet: only its link');
    expectStatus(await reader.browser.request('PATCH', `/api/v1/notification-addresses/${randomUUID()}`, { body: { enabled: true } }), 404);
    expectStatus(await owner.browser.request('PATCH', `/api/v1/notification-addresses/${address!.id}`, { body: { enabled: true } }), 404);

    // Removing an address changes nothing else: Email me too and the other address stay as they were.
    const removed = expectStatus(await reader.browser.request('DELETE', `/api/v1/notification-addresses/${address!.id}`), 200) as NotificationPreferences;
    assert.deepEqual(removed.email.addresses.map((item) => item.email), [second]);
    assert.equal(removed.emailMe, true);
    assert.equal(removed.email.accountEnabled, true);
    expectStatus(await reader.browser.request('DELETE', `/api/v1/notification-addresses/${address!.id}`), 404);
  });

  test('a person keeps up to five extra addresses', async () => {
    const someone = await person('Bea Quill');
    for (let index = 0; index < MAX_EXTRA_ADDRESSES; index++) {
      await skipCooldown(someone);
      expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: `bea.${index}-${randomUUID()}@example.test` } }), 200);
    }
    await skipCooldown(someone);
    const refused = await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: `bea.six-${randomUUID()}@example.test` } });
    assert.equal(refused.status, 409);
    assert.match(refused.text, /TOO_MANY_ADDRESSES/);
    const stored = expectStatus(await someone.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(stored.email.addresses.length, MAX_EXTRA_ADDRESSES);
  });

  test('read-all quiets the inbox without deleting anything', async () => {
    const before = await inbox(reader);
    assert.ok(before.items.length > 0);
    expectStatus(await reader.browser.request('POST', '/api/v1/inbox/read-all'), 200);
    const afterAll = await inbox(reader);
    assert.equal(afterAll.unread, 0);
    assert.equal(afterAll.items.length, before.items.length);
    assert.ok(afterAll.items.every((item) => item.readAt));
  });
});

describe('recipient matrix and operator TLS (#113)', () => {
  test('two SSO-style people get exactly the mailboxes Email me too covers: every confirmed address, or none', async () => {
    const lead = await person('Olek Brand');
    const iga = await named('Iga Nowak', `iga.${randomUUID().slice(0, 8)}@nebula.homes`);
    const jon = await named('Jon Petit', `jon.${randomUUID().slice(0, 8)}@nebula.homes`);
    const space = (await workspace(lead, 'Nebula homes')).id;
    await addMember(lead, space, iga, 'member');
    await addMember(lead, space, jon, 'member');
    const extras = new Map<Person, string>([[iga, `iga.private-${randomUUID()}@gmail.test`], [jon, `jon.private-${randomUUID()}@gmail.test`]]);
    for (const [someone, address] of extras) {
      expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: address } }), 200);
      const [mail] = await waitForMails(address, 1, 'the verification email');
      const token = new URL(/(http\S+verify\?token=\S+)/.exec((await mailText(mail!.ID)).Text)![1]!).searchParams.get('token')!;
      expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses/verify', { body: { token } }), 200);
    }
    const counts = async () => Object.fromEntries(await Promise.all([iga, jon].flatMap((someone) => [
      mailsTo(someone.email).then((mails) => [`${someone.id}:account`, mails.length] as const),
      mailsTo(extras.get(someone)!).then((mails) => [`${someone.id}:extra`, mails.length - 1] as const),
    ]))) as Record<string, number>;
    const phases: [boolean, boolean][] = [[true, false], [false, true], [true, true], [false, false]];
    for (const [igaChoice, jonChoice] of phases) {
      await prefs(iga, { emailMe: igaChoice });
      await prefs(jon, { emailMe: jonChoice });
      const before = await counts();
      // A new project per phase: the calm window allows one email per person and place.
      const room = (await project(lead, space, `Unit ${igaChoice}-${jonChoice}`, 'workspace')).id;
      const thread = await conversation(lead, room, '@Iga Nowak and @Jon Petit, the lift inspection report is in');
      for (const someone of [iga, jon]) await waitForItem(someone, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'the in-app record');
      const expected = (someone: Person, choice: boolean) => ({
        [`${someone.id}:account`]: before[`${someone.id}:account`]! + (choice ? 1 : 0),
        [`${someone.id}:extra`]: before[`${someone.id}:extra`]! + (choice ? 1 : 0),
      });
      const want = { ...expected(iga, igaChoice), ...expected(jon, jonChoice) };
      await waitFor(async () => JSON.stringify(await counts()) === JSON.stringify(want), `mail for ${igaChoice}/${jonChoice}`).catch(async () => {
        assert.deepEqual(await counts(), want, `mailboxes for ${igaChoice}/${jonChoice}`);
      });
      await sleep(800);
      assert.deepEqual(await counts(), want, `no extra mail for ${igaChoice}/${jonChoice}`);
    }
    // Every delivered notification email is the same generic notice.
    for (const address of [iga.email, extras.get(jon)!]) {
      const [latest] = await mailsTo(address);
      const mail = await mailText(latest!.ID);
      assert.equal(mail.Subject, 'New activity in Flux');
      assert.ok(!/lift|inspection|Olek|Nebula|Unit/.test(mail.Text), 'no private text');
    }
    // Neither extra address is a login identity.
    for (const address of extras.values()) assert.notEqual((await signIn(address, password)).response.status, 200);
  });

  test('an identity email that becomes the verified extra address gets one message, not two (#113)', async () => {
    const lead = await person('Ula Brandt');
    const someone = await named('Kim Ostrowska', `kim.${randomUUID().slice(0, 8)}@nebula.homes`);
    const space = (await workspace(lead, 'Mailbox merge')).id;
    await addMember(lead, space, someone, 'member');
    const extra = `kim.private-${randomUUID()}@gmail.test`;
    await verifyExtra(someone, extra);
    // The identity provider later reports the same verified address as the sign-in email.
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [extra.toUpperCase(), someone.id]);
    const before = (await mailsTo(extra)).length;
    const room = (await project(lead, space, 'Mail merge', 'workspace')).id;
    const thread = await conversation(lead, room, '@Kim Ostrowska the meter readings are in');
    await waitForItem(someone, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'the in-app record');
    const rows = await waitFor(async () => {
      const found = await emailRows(someone.id);
      return found.length === 2 && found.every((row) => row.status === 'sent' || row.status === 'skipped') ? found : null;
    }, 'both copies to settle');
    assert.deepEqual(rows.map((row) => row.status).sort(), ['sent', 'skipped'], 'one copy is sent, the other skipped');
    await sleep(800);
    assert.equal((await mailsTo(extra)).length, before + 1, 'exactly one message reaches the shared mailbox');
  });

  /**
   * One stored notification with both copies queued and held back (real notification and email rows, pg-boss jobs held for an
   * hour). Quiet hours store the notification and queue nothing (C-31), so the test queues the copies itself, then ends them.
   */
  async function heldCopies(lead: Person, space: string, someone: Person, displayName: string, name: string) {
    await prefs(someone, { quietHours: quietNow() });
    const room = (await project(lead, space, name, 'workspace')).id;
    const thread = await conversation(lead, room, `@${displayName} the ${name.toLowerCase()} numbers are in`);
    const notificationId = (await waitForItem(someone, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'the in-app record')).id;
    await generatorCaughtUp();
    assert.equal((await emailRows(someone.id)).filter((row) => row.notification_id === notificationId).length, 0, 'quiet hours queue no email');
    await prefs(someone, { quietHours: { enabled: false } });
    await queueEmailRow(someone.id, notificationId, 'account');
    await queueEmailRow(someone.id, notificationId, 'extra');
    const rows = (await emailRows(someone.id)).filter((row) => row.notification_id === notificationId);
    assert.deepEqual(rows.map((row) => [row.address_kind, row.status, row.address]).sort(), [['account', 'queued', null], ['extra', 'queued', null]]);
    const jobs = await pool.query(`SELECT data->>'emailId' AS id, start_after FROM pgboss.job WHERE name = $1 AND data->>'emailId' = ANY($2)`, [NOTIFICATION_EMAIL_JOB, rows.map((row) => row.id)]);
    assert.equal(jobs.rows.length, 2, 'both copies were actually enqueued');
    for (const job of jobs.rows) assert.ok(new Date(job.start_after).getTime() > Date.now() + 60_000, 'and are held back');
    const byKind = Object.fromEntries(rows.map((row) => [row.address_kind, row])) as Record<'account' | 'extra', (typeof rows)[number]>;
    return { notificationId, account: byKind.account, extra: byKind.extra };
  }

  /** Messages Mailpit accepted for this mailbox, whatever the letter case of the recipient. */
  async function mailboxCount(address: string) {
    const ids = new Set<string>();
    for (const variant of [address.toLowerCase(), address.toUpperCase()]) {
      for (const mail of await mailsTo(variant)) if (mail.To.some((to) => to.Address.toLowerCase() === address.toLowerCase())) ids.add(mail.ID);
    }
    return ids.size;
  }

  /** Real SMTP: Mailpit accepts; each acceptance is counted by recipient. */
  function countingSmtp() {
    const accepted: string[] = [];
    const mailer: NotificationMailer = { async send(mail) { const result = await smtp.send(mail); if (result.kind === 'accepted') accepted.push(mail.to.toLowerCase()); return result; } };
    return { accepted, mailer };
  }

  /** A real SMTP refusal: this catcher requires STARTTLS and the transport will not use it. */
  function refusingSmtp() {
    const config = loadNotificationMailConfig({ FLUX_SMTP_URL: 'smtp://mailpit-starttls:1025?ignoreTLS=true', FLUX_MAIL_FROM: 'Flux <flux@example.test>', FLUX_PUBLIC_ORIGIN: origin });
    return smtpNotificationMailer(config as Extract<typeof config, { status: 'available' }>);
  }

  test('addresses that become one mailbox after enqueue: a failed send is retried and racing copies send exactly once (#113)', async () => {
    const lead = await person('Vera Holm');
    const someone = await named('Nils Wren', `nils.${randomUUID().slice(0, 8)}@nebula.homes`);
    const space = (await workspace(lead, 'Enqueue then merge')).id;
    await addMember(lead, space, someone, 'member');
    const extra = `nils.private-${randomUUID()}@gmail.test`;
    await verifyExtra(someone, extra);
    const copies = await heldCopies(lead, space, someone, 'Nils Wren', 'Meter');
    // After both copies were queued, the identity provider reports the private address as the
    // sign-in email: the two copies now go to one mailbox.
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [extra.toUpperCase(), someone.id]);
    await prefs(someone, { quietHours: { enabled: false } });
    const before = await mailboxCount(extra);
    const options = { available: true, origin, uow: emailUnitOfWork(db, queue) };
    const { accepted, mailer } = countingSmtp();
    const refusing = refusingSmtp();
    try {
      // The SMTP server refuses the account copy: it goes back to queued for its retry.
      await assert.rejects(deliverNotificationEmail({ ...options, mailer: refusing }, { emailId: copies.account.id }), /SMTP did not accept/);
      assert.deepEqual((await emailRows(someone.id)).filter((row) => row.notification_id === copies.notificationId).map((row) => row.status), ['queued', 'queued']);
    } finally { refusing.close(); }
    // Its retry and the extra copy run at the same time: they serialize on the notification's
    // rows, one is sent and the other is skipped as the same mailbox.
    const results = await Promise.all([copies.account, copies.extra].map((row) => deliverNotificationEmail({ ...options, mailer }, { emailId: row.id })));
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['sent', 'skipped']);
    assert.deepEqual(results.find((result) => result.outcome === 'skipped'), { outcome: 'skipped', reason: 'this mailbox already gets this notification' });
    // Later retries of either copy (pg-boss redelivery) change nothing.
    for (const row of [copies.account, copies.extra]) {
      const again = await deliverNotificationEmail({ ...options, mailer }, { emailId: row.id });
      assert.equal(again.outcome, 'skipped');
      assert.match((again as { reason: string }).reason, /^already (sent|skipped)$/);
    }
    assert.deepEqual(accepted, [extra.toLowerCase()], 'exactly one SMTP acceptance for the mailbox');
    await waitFor(async () => (await mailboxCount(extra)) === before + 1, 'the one message');
    await sleep(800);
    assert.equal(await mailboxCount(extra), before + 1, 'Mailpit holds exactly one message for the mailbox');
  });

  test('a composed and a decomposed letter are one mailbox when the copies of a notification are matched (#1070)', async () => {
    const lead = await person('Pia Voll');
    const someone = await named('Rolf Ness', `rolf.${randomUUID().slice(0, 8)}@nebula.homes`);
    const space = (await workspace(lead, 'Forms of a mailbox')).id;
    await addMember(lead, space, someone, 'member');
    const composed = `jos\u00e9-${randomUUID().slice(0, 8)}@gmail.test`;
    const decomposed = composed.replace('\u00e9', 'e\u0301');
    assert.notEqual(composed, decomposed);
    // The extra address is confirmed in its one form; the identity provider reports the sign-in address in the other.
    await pool.query('INSERT INTO notification_addresses (id, user_id, email, verified_at) VALUES ($1, $2, $3, now())', [randomUUID(), someone.id, composed]);
    const copies = await heldCopies(lead, space, someone, 'Rolf Ness', 'Pump');
    await pool.query("UPDATE notification_emails SET status = 'sent', address = $2 WHERE id = $1", [copies.account.id, decomposed]);
    const rows = notificationEmailRows(db);
    assert.equal(await rows.mailboxClaimed(copies.notificationId, copies.extra.id, composed), true, 'the other form is claimed');
    assert.equal(await rows.mailboxClaimed(copies.notificationId, copies.extra.id, composed.toUpperCase()), true, 'in any letter case');
    assert.equal(await rows.mailboxClaimed(copies.notificationId, copies.extra.id, `other-${randomUUID().slice(0, 8)}@gmail.test`), false, 'another mailbox is not');
    assert.equal(await rows.mailboxClaimed(copies.notificationId, copies.account.id, decomposed), false, 'a copy does not claim its own mailbox');
  });

  test('one mailbox, copies in flight: a sibling skips while a send is pending, a failed one retries, an uncertain one is never repeated (#113)', async () => {
    const lead = await person('Ines Kahl');
    const someone = await named('Otto Brin', `otto.${randomUUID().slice(0, 8)}@nebula.homes`);
    const space = (await workspace(lead, 'Copies in flight')).id;
    await addMember(lead, space, someone, 'member');
    const extra = `otto.private-${randomUUID()}@gmail.test`;
    await verifyExtra(someone, extra);
    const options = { available: true, origin, uow: emailUnitOfWork(db, queue) };

    // 1. The account copy is at the SMTP server when the extra copy is claimed; the server then refuses.
    const pending = await heldCopies(lead, space, someone, 'Otto Brin', 'Boiler');
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [extra.toUpperCase(), someone.id]);
    await prefs(someone, { quietHours: { enabled: false } });
    const before = await mailboxCount(extra);
    const { accepted, mailer } = countingSmtp();
    const refusing = refusingSmtp();
    let release!: () => void;
    const siblingDone = new Promise<void>((resolve) => { release = resolve; });
    const slowRefusal: NotificationMailer = { async send(mail) { await Promise.race([siblingDone, sleep(10_000)]); return refusing.send(mail); } };
    try {
      const first = deliverNotificationEmail({ ...options, mailer: slowRefusal }, { emailId: pending.account.id });
      await waitFor(async () => (await emailRows(someone.id)).find((row) => row.id === pending.account.id)?.status === 'sending', 'the account copy to be sending');
      const sibling = await deliverNotificationEmail({ ...options, mailer }, { emailId: pending.extra.id });
      release();
      assert.deepEqual(sibling, { outcome: 'skipped', reason: 'this mailbox already gets this notification' });
      await assert.rejects(first, /SMTP did not accept/);
    } finally { release(); refusing.close(); }
    assert.equal((await emailRows(someone.id)).find((row) => row.id === pending.account.id)?.status, 'queued', 'the refused copy waits for its retry');
    // Its retry delivers the one message for the mailbox.
    assert.deepEqual(await deliverNotificationEmail({ ...options, mailer }, { emailId: pending.account.id }), { outcome: 'sent', addressKind: 'account' });
    assert.deepEqual(accepted, [extra.toLowerCase()]);
    await waitFor(async () => (await mailboxCount(extra)) === before + 1, 'the retried message');

    // 2. Uncertain: SMTP accepted the extra copy, then the worker died before recording it.
    const uncertain = await heldCopies(lead, space, someone, 'Otto Brin', 'Gutter');
    await prefs(someone, { quietHours: { enabled: false } });
    const crashing: NotificationMailer = { async send(mail) { await mailer.send(mail); throw new Error('worker died after SMTP accepted'); } };
    await assert.rejects(deliverNotificationEmail({ ...options, mailer: crashing }, { emailId: uncertain.extra.id }), /worker died/);
    assert.equal((await emailRows(someone.id)).find((row) => row.id === uncertain.extra.id)?.status, 'sending', 'left uncertain');
    // Neither the sibling nor a retry of the uncertain copy sends again.
    assert.deepEqual(await deliverNotificationEmail({ ...options, mailer }, { emailId: uncertain.account.id }), { outcome: 'skipped', reason: 'this mailbox already gets this notification' });
    assert.deepEqual(await deliverNotificationEmail({ ...options, mailer }, { emailId: uncertain.extra.id }), { outcome: 'skipped', reason: 'already sending' });
    assert.deepEqual(accepted, [extra.toLowerCase(), extra.toLowerCase()], 'one acceptance per notification');
    await waitFor(async () => (await mailboxCount(extra)) === before + 2, 'the uncertain message');
    await sleep(800);
    assert.equal(await mailboxCount(extra), before + 2, 'one message per notification for the mailbox');
  });

  /** A copy whose SMTP attempt is held open until `release`, then fails as the server refused it. */
  function heldFailure(onRelease?: () => Promise<void>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const mailer: NotificationMailer = { async send() { await Promise.race([released, sleep(10_000)]); await onRelease?.(); return { kind: 'failed', message: '550 5.1.1 mailbox unavailable' }; } };
    return { mailer, release };
  }

  /** One mailbox for both copies: the account copy is sending when the extra copy is skipped. */
  async function sharedMailboxCopies(lead: Person, someone: Person, displayName: string, name: string) {
    const space = (await workspace(lead, `${name} lane`)).id;
    await addMember(lead, space, someone, 'member');
    const extra = `${displayName.split(' ')[0]!.toLowerCase()}.private-${randomUUID()}@gmail.test`;
    await verifyExtra(someone, extra);
    const copies = await heldCopies(lead, space, someone, displayName, name);
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [extra.toUpperCase(), someone.id]);
    await prefs(someone, { quietHours: { enabled: false } });
    return { space, extra, copies };
  }

  const rowOf = async (userId: string, id: string) => (await emailRows(userId)).find((row) => row.id === id)!;
  const jobsFor = async (id: string) => (await pool.query(`SELECT singleton_key FROM pgboss.job WHERE name = $1 AND data->>'emailId' = $2 ORDER BY created_on`, [NOTIFICATION_EMAIL_JOB, id])).rows.map((row) => row.singleton_key as string);

  test('a shared mailbox whose sent copy fails permanently gets the skipped copy instead, exactly once (#329)', async () => {
    const lead = await person('Rhea Lind');
    const someone = await named('Tomas Ek', `tomas.${randomUUID().slice(0, 8)}@nebula.homes`);
    const { extra, copies } = await sharedMailboxCopies(lead, someone, 'Tomas Ek', 'Furnace');
    const before = await mailboxCount(extra);
    const options = { available: true, origin, uow: emailUnitOfWork(db, queue) };
    const refusing: NotificationMailer = { send: async () => ({ kind: 'failed', message: '421 4.7.0 try again later' }) };
    // Attempts 1–5 (pg-boss retries 5 times): each failure puts the account copy back to queued.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(deliverNotificationEmail({ ...options, mailer: refusing }, { emailId: copies.account.id }), /SMTP did not accept/);
      assert.equal((await rowOf(someone.id, copies.account.id)).status, 'queued', `attempt ${attempt} is retried`);
    }
    // Attempt 6 is at the server when the extra copy is claimed: same mailbox, so it is skipped.
    const last = heldFailure();
    const sixth = deliverNotificationEmail({ ...options, mailer: last.mailer }, { emailId: copies.account.id });
    try {
      await waitFor(async () => (await rowOf(someone.id, copies.account.id)).status === 'sending', 'the last attempt to be sending');
      assert.deepEqual(await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: copies.extra.id }), { outcome: 'skipped', reason: 'this mailbox already gets this notification' });
    } finally { last.release(); }
    // The last attempt fails: the account copy ends, and the skipped copy is promoted and queued once.
    assert.deepEqual(await sixth, { outcome: 'failed', reason: 'delivery failed permanently', promoted: copies.extra.id });
    const account = await rowOf(someone.id, copies.account.id);
    assert.deepEqual([account.status, account.skip_reason], ['skipped', 'delivery failed permanently']);
    assert.deepEqual(await jobsFor(copies.extra.id), [copies.extra.id, `${copies.extra.id}:promoted`], 'one promoted job besides the original held one');
    // The running worker sends it; Mailpit receives exactly one message for the mailbox.
    await waitFor(async () => (await rowOf(someone.id, copies.extra.id)).status === 'sent', 'the worker to send the promoted copy');
    await waitFor(async () => (await mailboxCount(extra)) === before + 1, 'the promoted message');
    // Redelivery of either copy (pg-boss retries, the held jobs) sends nothing more.
    for (const row of [copies.account, copies.extra]) {
      const again = await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: row.id });
      assert.match((again as { reason: string }).reason, /^already (sent|skipped)$/);
    }
    assert.deepEqual(await jobsFor(copies.extra.id), [copies.extra.id, `${copies.extra.id}:promoted`], 'still one promotion');
    await sleep(800);
    assert.equal(await mailboxCount(extra), before + 1, 'exactly one message reaches the mailbox');
  });

  test('a temporary failure that later succeeds promotes nothing (#329)', async () => {
    const lead = await person('Ada Voss');
    const someone = await named('Bruno Hale', `bruno.${randomUUID().slice(0, 8)}@nebula.homes`);
    const { extra, copies } = await sharedMailboxCopies(lead, someone, 'Bruno Hale', 'Chimney');
    const before = await mailboxCount(extra);
    const options = { available: true, origin, uow: emailUnitOfWork(db, queue) };
    const first = heldFailure();
    const attempt = deliverNotificationEmail({ ...options, mailer: first.mailer }, { emailId: copies.account.id });
    try {
      await waitFor(async () => (await rowOf(someone.id, copies.account.id)).status === 'sending', 'the account copy to be sending');
      assert.deepEqual(await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: copies.extra.id }), { outcome: 'skipped', reason: 'this mailbox already gets this notification' });
    } finally { first.release(); }
    await assert.rejects(attempt, /SMTP did not accept/);
    assert.deepEqual(await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: copies.account.id }), { outcome: 'sent', addressKind: 'account' });
    const skipped = await rowOf(someone.id, copies.extra.id);
    assert.deepEqual([skipped.status, skipped.skip_reason], ['skipped', 'this mailbox already gets this notification'], 'the skipped copy stays skipped');
    assert.deepEqual(await jobsFor(copies.extra.id), [copies.extra.id], 'no promoted job');
    await waitFor(async () => (await mailboxCount(extra)) === before + 1, 'the retried message');
    await sleep(800);
    assert.equal(await mailboxCount(extra), before + 1, 'exactly one message reaches the mailbox');
  });

  test('a promoted copy rechecks access when sent: a recipient removed meanwhile gets nothing (#329)', async () => {
    const lead = await person('Elin Moss');
    const someone = await named('Ivo Stark', `ivo.${randomUUID().slice(0, 8)}@nebula.homes`);
    const { space, extra, copies } = await sharedMailboxCopies(lead, someone, 'Ivo Stark', 'Cellar');
    const before = await mailboxCount(extra);
    const options = { available: true, origin, uow: emailUnitOfWork(db, queue), maxAttempts: 1 };
    // The person is removed from the workspace while the last attempt is at the SMTP server.
    const last = heldFailure(() => removeMember(lead, space, someone));
    const attempt = deliverNotificationEmail({ ...options, mailer: last.mailer }, { emailId: copies.account.id });
    try {
      await waitFor(async () => (await rowOf(someone.id, copies.account.id)).status === 'sending', 'the account copy to be sending');
      assert.deepEqual(await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: copies.extra.id }), { outcome: 'skipped', reason: 'this mailbox already gets this notification' });
    } finally { last.release(); }
    assert.deepEqual(await attempt, { outcome: 'failed', reason: 'delivery failed permanently', promoted: copies.extra.id });
    // The worker claims the promoted copy, rechecks access and skips it.
    await waitFor(async () => (await rowOf(someone.id, copies.extra.id)).skip_reason === 'recipient can no longer read the source', 'the worker to recheck the promoted copy');
    assert.equal((await rowOf(someone.id, copies.extra.id)).status, 'skipped');
    assert.deepEqual(await jobsFor(copies.extra.id), [copies.extra.id, `${copies.extra.id}:promoted`], 'one promotion');
    await sleep(800);
    assert.equal(await mailboxCount(extra), before, 'nothing reaches the mailbox');
  });

  for (const [label, url, api] of [
    ['STARTTLS (required)', 'smtp://flux:secret@mailpit-starttls:1025?requireTLS=true', process.env.FLUX_MAILPIT_STARTTLS_URL],
    ['implicit TLS (smtps)', 'smtps://flux:secret@mailpit-smtps:1025', process.env.FLUX_MAILPIT_SMTPS_URL],
  ] as const) {
    test(`the operator TLS path works: ${label}, with the certificate verified`, async () => {
      assert.ok(api, 'the TLS mail catchers are part of the test stack');
      const config = loadNotificationMailConfig({ FLUX_SMTP_URL: url, FLUX_MAIL_FROM: 'Flux <flux@example.test>', FLUX_PUBLIC_ORIGIN: origin });
      assert.equal(config.status, 'available');
      const mailer = smtpNotificationMailer(config as Extract<typeof config, { status: 'available' }>);
      const to = `tls-${randomUUID()}@example.test`;
      const result = await mailer.send(buildNotificationEmail({ origin, to, emailId: randomUUID(), notificationId: randomUUID(), token: 'x' }));
      mailer.close();
      assert.deepEqual(result, { kind: 'accepted' });
      const search = await (await fetch(`${api}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json() as { messages: unknown[] };
      assert.equal(search.messages.length, 1);
    });
  }

  test('a server that requires TLS refuses a plain-text send, and the failure is reported, not dropped', async () => {
    const config = loadNotificationMailConfig({ FLUX_SMTP_URL: 'smtp://mailpit-starttls:1025?ignoreTLS=true', FLUX_MAIL_FROM: 'Flux <flux@example.test>', FLUX_PUBLIC_ORIGIN: origin });
    const mailer = smtpNotificationMailer(config as Extract<typeof config, { status: 'available' }>);
    const result = await mailer.send(buildNotificationEmail({ origin, to: 'plain@example.test', emailId: randomUUID(), notificationId: randomUUID(), token: 'x' }));
    mailer.close();
    assert.equal(result.kind, 'failed');
  });

  test('a failed send stays queued for retry and settings say email delivery failed', async () => {
    const lead = await person('Pia Lund');
    const target = await person('Sam Ruiz');
    const space = (await workspace(lead, 'Retry lane')).id;
    await addMember(lead, space, target, 'member');
    await prefs(target, { quietHours: quietNow() });
    const room = (await project(lead, space, 'Boiler', 'workspace')).id;
    const thread = await conversation(lead, room, '@Sam Ruiz boiler service is booked');
    const stored = await waitForItem(target, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'the in-app record');
    await prefs(target, { quietHours: { enabled: false } });
    const email = { id: await queueEmailRow(target.id, stored.id) };
    const failing: NotificationMailer = { send: async () => ({ kind: 'failed', message: 'connect ECONNREFUSED' }) };
    await assert.rejects(deliverNotificationEmail({ available: true, origin, uow: emailUnitOfWork(db, queue), mailer: failing }, { emailId: email.id }));
    const view = expectStatus(await target.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(view.email.available, true);
    assert.ok(view.email.lastFailureAt, 'the person can see that email delivery failed');
    assert.equal((await inbox(target)).items.filter((item) => item.url?.endsWith(thread.messages[0]!.id)).length, 1, 'the inbox keeps it');
    assert.equal((await emailRows(target.id))[0]!.status, 'queued');
  });
});

async function verifyExtra(someone: Person, address: string) {
  expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: address } }), 200);
  const [mail] = await waitForMails(address, 1, 'the verification email');
  const token = new URL(/(http\S+verify\?token=\S+)/.exec((await mailText(mail!.ID)).Text)![1]!).searchParams.get('token')!;
  expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses/verify', { body: { token } }), 200);
}

/** Lets the next verification send pass the 60 s cooldown (the hourly window still counts). */
async function skipCooldown(someone: Person) {
  await pool.query("UPDATE notification_verification_sends SET last_sent_at = now() - interval '2 minutes' WHERE user_id = $1", [someone.id]);
}

function unsubscribeUrl(headers: Record<string, string[]>) {
  const url = /^<(.+)>$/.exec(headers['List-Unsubscribe']?.[0] ?? '')?.[1];
  assert.ok(url, 'the email has a one-click unsubscribe link');
  const target = new URL(url);
  return new URL(`${target.pathname}${target.search}`, process.env.FLUX_API_URL ?? 'http://api:8080');
}

async function oneClick(url: URL) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(response.status, 200);
  return await response.json() as { result: string; stopped: string };
}

describe('review fixes: exact unsubscribe, bounded verification, quiet hours at delivery', () => {
  test('two concurrent partial preference changes both persist (row-locked merge)', async () => {
    const someone = await person('Zed Arlo');
    await prefs(someone, { quietHours: { enabled: true, timeZone: 'Europe/Warsaw' } });
    // Barrier: hold the row lock so both PATCH requests are in flight and waiting together.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM notification_preferences WHERE user_id = $1 FOR UPDATE', [someone.id]);
      const start = someone.browser.request('PATCH', '/api/v1/notification-preferences', { body: { quietHours: { start: '21:30' } } });
      const end = someone.browser.request('PATCH', '/api/v1/notification-preferences', { body: { quietHours: { end: '07:15' } } });
      await waitFor(async () => Number((await pool.query(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%notification_preferences%'")).rows[0].n) >= 2,
      'both updates to wait on the row lock');
      await holder.query('COMMIT');
      for (const response of await Promise.all([start, end])) assert.equal(response.status, 200, response.text);
    } finally {
      holder.release();
    }
    const stored = expectStatus(await someone.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.deepEqual(stored.quietHours, { enabled: true, start: '21:30', end: '07:15', timeZone: 'Europe/Warsaw' });
    // The same field changed twice: the later request wins.
    await prefs(someone, { quietHours: { start: '20:00' } });
    await prefs(someone, { quietHours: { start: '20:45' } });
    assert.equal((expectStatus(await someone.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences).quietHours.start, '20:45');
  });

  test('an unsubscribe link for a removed address or a changed sign-in address changes nothing', async () => {
    const lead = await person('Uma Kerr');
    const reader = await person('Vic Lamb');
    const space = (await workspace(lead, 'Link lane')).id;
    await addMember(lead, space, reader, 'member');
    const first = `vic.a-${randomUUID()}@example.test`;
    const second = `vic.b-${randomUUID()}@example.test`;
    await verifyExtra(reader, first);
    const mention = async (name: string) => {
      const room = (await project(lead, space, name, 'workspace')).id;
      const thread = await conversation(lead, room, `@Vic Lamb ${name} is ready`);
      await waitForItem(reader, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, name);
    };
    await mention('Rota A');
    const [toFirst] = await waitForMails(first, 2, 'the email to address A');
    const staleLink = unsubscribeUrl((await mailText(toFirst!.ID)).headers);

    // Remove A and add a verified B: A's old link finds no such address and changes nothing.
    const withFirst = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    expectStatus(await reader.browser.request('DELETE', `/api/v1/notification-addresses/${withFirst.email.addresses[0]!.id}`), 200);
    await skipCooldown(reader);
    await verifyExtra(reader, second);
    assert.deepEqual(await oneClick(staleLink), { result: 'stale', stopped: 'extra' });
    const settings = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(settings.emailMe, true);
    assert.deepEqual(settings.email.addresses.map((item) => [item.email, item.enabled]), [[second, true]], 'B is still switched on');
    await mention('Rota B');
    const [toSecond] = await waitForMails(second, 2, 'B still receives email');
    assert.equal((await mailText(toSecond!.ID)).Subject, 'New activity in Flux');

    // A sign-in address that changed since the email: its old link changes nothing either.
    await mention('Rota C');
    const [toAccount] = await waitForMails(reader.email, 1, 'the email to the sign-in address');
    const accountLink = unsubscribeUrl((await mailText(toAccount!.ID)).headers);
    const renamed = `vic.new-${randomUUID()}@example.test`;
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [renamed, reader.id]);
    assert.deepEqual(await oneClick(accountLink), { result: 'stale', stopped: 'account' });
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [reader.email, reader.id]);
    assert.equal((expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences).email.accountEnabled, true);
    // The current link still works, and switches off the sign-in address alone.
    assert.deepEqual(await oneClick(accountLink), { result: 'stopped', stopped: 'account' });
    const after = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.deepEqual([after.email.accountEnabled, after.emailMe, after.email.addresses.map((item) => item.enabled)], [false, true, [true]]);
  });

  test('the unsubscribe link of an extra address switches off that address and nothing else; replaying it changes nothing, and every footer says what its link does', async () => {
    const lead = await person('Wilf Crane');
    const reader = await person('Xan Pike');
    const space = (await workspace(lead, 'Extra link lane')).id;
    await addMember(lead, space, reader, 'member');
    const extra = `xan.extra-${randomUUID()}@example.test`;
    await verifyExtra(reader, extra);
    const mention = async (name: string) => {
      const room = (await project(lead, space, name, 'workspace')).id;
      const thread = await conversation(lead, room, `@Xan Pike ${name} is ready`);
      await waitForItem(reader, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, name);
    };
    await mention('Rota X');
    const [toExtra] = await waitForMails(extra, 2, 'the email to the extra address');
    const [toAccount] = await waitForMails(reader.email, 1, 'the email to the sign-in address');
    // Each footer's link stops the address that email came to (C-49).
    assert.match((await mailText(toAccount!.ID)).Text, /Stop notification email to this address:/);
    assert.match((await mailText(toExtra!.ID)).Text, /Stop notification email to this address:/);
    const link = unsubscribeUrl((await mailText(toExtra!.ID)).headers);
    assert.deepEqual(await oneClick(link), { result: 'stopped', stopped: 'extra' });
    const settings = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.deepEqual(settings.email.addresses.map((item) => [item.email, item.enabled, item.verified]), [[extra, false, true]], 'the address stays listed, switched off');
    assert.equal(settings.emailMe, true, 'Email me too is untouched');
    assert.equal(settings.email.accountEnabled, true, 'and so is the sign-in address, which still gets mail');
    assert.deepEqual(await oneClick(link), { result: 'stopped', stopped: 'extra' }, 'a replay changes nothing');
    const before = (await mailsTo(reader.email)).length;
    await mention('Rota Y');
    await waitForMails(reader.email, before + 1, 'the next email to the sign-in address');
    await sleep(800);
    assert.equal((await mailsTo(extra)).length, 2, 'the switched-off address got nothing more (its confirmation and one notification)');
    // Switching it back on is the person\'s own choice, in settings.
    expectStatus(await reader.browser.request('PATCH', `/api/v1/notification-addresses/${settings.email.addresses[0]!.id}`, { body: { enabled: true } }), 200);
  });

  test('verification sends are bounded across add and resend, for all of a person\'s addresses, also when requests race', async () => {
    const someone = await person('Wes Moor');
    const target = `wes.target-${randomUUID()}@example.test`;
    const added = expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: target } }), 200) as NotificationPreferences;
    const targetId = added.email.addresses[0]!.id;
    const again = await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: `wes.other-${randomUUID()}@example.test` } });
    assert.equal(again.status, 429, 'a second address does not get around the cooldown');
    assert.ok(Number(again.headers.get('retry-after')) >= 1);
    assert.equal((await someone.browser.request('POST', `/api/v1/notification-addresses/${targetId}/resend`)).status, 429);

    // Concurrent additions after the cooldown: exactly one sends.
    await skipCooldown(someone);
    const racers = [1, 2, 3, 4].map((n) => `wes.race${n}-${randomUUID()}@example.test`);
    const racing = await Promise.all(racers.map((email) => someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email } })));
    assert.deepEqual(racing.map((response) => response.status).sort(), [200, 429, 429, 429]);
    const winner = (racing.find((response) => response.status === 200)!.json as NotificationPreferences).email.addresses.find((item) => racers.includes(item.email))!;

    // Even with the cooldown out of the way, at most 5 per hour: two sends before plus three here make five (each address is asked for twice or less).
    const statuses: number[] = [];
    for (const id of [targetId, winner.id, targetId, winner.id, targetId, winner.id]) {
      await skipCooldown(someone);
      const response = await someone.browser.request('POST', `/api/v1/notification-addresses/${id}/resend`);
      statuses.push(response.status);
      if (response.status === 429) assert.ok(Number(response.headers.get('retry-after')) > 60, 'the hourly limit says when it resets');
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
    await sleep(1000);
    assert.equal((await mailsTo(target)).length, 3, 'the address added first: its link and two more');
    assert.equal((await mailsTo(winner.email)).length, 2, 'the address added by the race: its link and one more');
  });

  test('one address gets at most three confirmation links an hour, whichever accounts ask for it (#1056)', async () => {
    const stranger = `target-${randomUUID()}@example.test`;
    const asking = [await person('Ann Rowe'), await person('Bo Lind'), await person('Cy Park'), await person('Di Voss')];
    const statuses: number[] = [];
    for (const someone of asking) {
      const response = await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: stranger } });
      statuses.push(response.status);
      if (response.status === 429) assert.ok(Number(response.headers.get('retry-after')) > 60, 'it says when the hour is over');
    }
    assert.deepEqual(statuses, [200, 200, 200, 429], 'three people could each send the address a link; a fourth could not');
    await sleep(800);
    assert.equal((await mailsTo(stranger)).length, 3);
    // The refused one left nothing behind: no address was added to that account.
    const refused = expectStatus(await asking[3]!.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.deepEqual(refused.email.addresses, []);
    // The same address in another letter case is the same address, so it counts against the same limit.
    await skipCooldown(asking[3]!);
    assert.equal((await asking[3]!.browser.request('POST', '/api/v1/notification-addresses', { body: { email: stranger.replace('@example.test', '@EXAMPLE.test') } })).status, 429);
  });

  test('a +tag alias counts as the same address for the limit, which has its own message and spends nobody\'s cooldown (#1070)', async () => {
    const base = `target-${randomUUID().slice(0, 8)}`;
    const aliases = [`${base}+a@example.test`, `${base}+b@example.test`, `${base}@example.test`];
    const asking = [await person('Gus Ahl'), await person('Hal Brun'), await person('Ida Cole'), await person('Jon Dahl')];
    for (const [index, alias] of aliases.entries()) {
      const added = expectStatus(await asking[index]!.browser.request('POST', '/api/v1/notification-addresses', { body: { email: alias } }), 200) as NotificationPreferences;
      assert.equal(added.email.addresses[0]!.email, alias, 'the stored address keeps its tag');
    }
    // A fourth alias of the same mailbox, in other letters, is the fourth link to it.
    const refused = await asking[3]!.browser.request('POST', '/api/v1/notification-addresses', { body: { email: `${base}+C@EXAMPLE.test` } });
    assert.equal(refused.status, 429, refused.text);
    const body = refused.json as { code: string; error: string };
    assert.equal(body.code, 'ADDRESS_CONFIRMATION_LIMIT');
    assert.match(body.error, /confirmation link/);
    assert.doesNotMatch(body.error, /verification|this hour|minute/i, 'it names the address, not the person or a cooldown');
    assert.ok(Number(refused.headers.get('retry-after')) > 60);
    // The refusal spent nothing of Jon's own cooldown: another address goes out at once.
    const other = `jon.other-${randomUUID()}@example.test`;
    expectStatus(await asking[3]!.browser.request('POST', '/api/v1/notification-addresses', { body: { email: other } }), 200);
    await sleep(800);
    assert.equal((await mailsTo(other)).length, 1, 'and its link was sent');

    // The reverse: a refusal by the person's own cooldown gives the address's slot back, so it still gets three links from others.
    const slotted = `slot-${randomUUID()}@example.test`;
    const tooSoon = await asking[3]!.browser.request('POST', '/api/v1/notification-addresses', { body: { email: slotted } });
    assert.equal(tooSoon.status, 429);
    assert.equal((tooSoon.json as { code: string }).code, 'VERIFICATION_RECENTLY_SENT');
    assert.match((tooSoon.json as { error: string }).error, /less than a minute ago/);
    const others = [await person('Kim Eld'), await person('Lou Fry'), await person('Max Gil')];
    for (const someone of others) expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: slotted } }), 200);
    const rejected = await asking[3]!.browser.request('POST', '/api/v1/notification-addresses', { body: { email: slotted } });
    assert.equal(rejected.status, 429);
    assert.equal((rejected.json as { code: string }).code, 'ADDRESS_CONFIRMATION_LIMIT', 'three links from others used the address up');
  });

  test('a malformed address id is a missing address, not a server error (#1056)', async () => {
    const someone = await person('Eve Lund');
    for (const [method, path, body] of [
      ['PATCH', '/api/v1/notification-addresses/not-a-uuid', { enabled: true }],
      ['PATCH', '/api/v1/notification-addresses/verify', { enabled: true }],
      ['DELETE', '/api/v1/notification-addresses/not-a-uuid', undefined],
      ['POST', '/api/v1/notification-addresses/not-a-uuid/resend', undefined],
      ['DELETE', `/api/v1/notification-addresses/${'x'.repeat(90)}`, undefined],
    ] as const) {
      const response = await someone.browser.request(method, path, body ? { body } : undefined);
      assert.equal(response.status, 404, `${method} ${path.slice(0, 60)}: ${response.text}`);
    }
  });

  test('the same address typed with a composed and a decomposed letter is one address (#1056)', async () => {
    const someone = await person('Fay Nord');
    const local = `jos\u00e9.${randomUUID().slice(0, 8)}`;
    const composed = `${local}@example.test`;
    const decomposed = `${local.replace('\u00e9', 'e\u0301')}@example.test`;
    assert.notEqual(composed, decomposed);
    const added = expectStatus(await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: composed } }), 200) as NotificationPreferences;
    assert.equal(added.email.addresses[0]!.email, composed);
    await skipCooldown(someone);
    const again = await someone.browser.request('POST', '/api/v1/notification-addresses', { body: { email: decomposed } });
    assert.equal(again.status, 409, again.text);
    assert.match(again.text, /ADDRESS_EXISTS/);
    // Stored in the one form, whichever way it was typed.
    assert.deepEqual((await pool.query('SELECT email FROM notification_addresses WHERE user_id = $1', [someone.id])).rows.map((row) => row.email), [composed]);
    assert.equal(normalizeEmail(decomposed), composed);
  });

  test('quiet hours switched on after a job was queued drop its email and push, and nothing catches up when they end (C-31)', async () => {
    const lead = await person('Xia Holt');
    const reader = await person('Yan Frost');
    const space = (await workspace(lead, 'Quiet lane')).id;
    await addMember(lead, space, reader, 'member');
    const room = (await project(lead, space, 'Night shift', 'workspace')).id;
    const { subscription, id: subscriptionId } = await subscribe(reader.browser);
    // A notification and its email queued while quiet hours were off (no job runs them yet).
    const notificationId = randomUUID();
    const emailId = randomUUID();
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, ai_origin)
      VALUES ($1, $2, $3, 'project', $4, 'Xia Holt mentioned you in Night shift', 'hello', $5, 'mention', false)`, [notificationId, reader.id, space, room, `/projects/${room}`]);
    await pool.query(`INSERT INTO notification_emails (id, notification_id, user_id, address_kind) VALUES ($1, $2, $3, 'account')`, [emailId, notificationId, reader.id]);

    // Then the person turns quiet hours on, covering now, in their own (DST-observing) zone.
    await prefs(reader, { quietHours: quietNow('Europe/Warsaw') });
    const options = { available: true, origin, uow: emailUnitOfWork(db, queue), mailer: smtp };
    assert.deepEqual(await deliverNotificationEmail(options, { emailId }), { outcome: 'skipped', reason: 'quiet hours' });
    const push = await deliverPush({ db, vapid, config: loadPushSenderConfig() }, { notificationId, subscriptionId, userId: reader.id });
    assert.deepEqual(push, { outcome: 'skipped', reason: 'quiet hours' });
    const [skipped] = await emailRows(reader.id);
    assert.deepEqual([skipped!.status, skipped!.skip_reason], ['skipped', 'quiet hours']);
    const requeued = await pool.query(`SELECT 1 FROM pgboss.job WHERE name = $1 AND data->>'emailId' = $2`, [NOTIFICATION_EMAIL_JOB, emailId]);
    assert.equal(requeued.rowCount, 0, 'no job is queued for the end of quiet hours');
    assert.equal((await mailsTo(reader.email)).length, 0);
    assert.equal((await recordedPushes(subscription.mockId)).length, 0);

    // When quiet hours end, the dropped email stays dropped: there is no catch-up.
    await prefs(reader, { quietHours: { enabled: false } });
    assert.deepEqual(await deliverNotificationEmail(options, { emailId }), { outcome: 'skipped', reason: 'already skipped' });
    await sleep(500);
    assert.equal((await mailsTo(reader.email)).length, 0);
    assert.equal((await inbox(reader)).items.length, 1, 'the inbox kept the notification');
  });
});

describe('levels (#350, S22)', () => {
  let ana: Person;
  let teo: Person;
  let workspaceId: string;

  before(async () => {
    ana = await person('Ana Brisk');
    teo = await person('Teo Marr');
    workspaceId = (await workspace(ana, 'Morning bakery')).id;
    await addMember(ana, workspaceId, teo, 'member');
  });

  test('a new person is at Only what needs me with Email me too; Nothing keeps the inbox and stops push and email', async () => {
    const start = expectStatus(await teo.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(start.level, 'needsYou');
    assert.equal(start.emailMe, true);
    assert.equal('channels' in start, false, 'there are no per-reason rows to show');
    const nothing = await prefs(teo, { level: 'nothing' });
    assert.equal(nothing.level, 'nothing');
    assert.equal(nothing.emailMe, true, 'the switch is kept for when something is sent again');
    const bad = await teo.browser.request('PATCH', '/api/v1/notification-preferences', { body: { level: 'loud' } });
    assert.equal(bad.status, 400);
    const badSwitch = await teo.browser.request('PATCH', '/api/v1/notification-preferences', { body: { emailMe: 'yes' } });
    assert.equal(badSwitch.status, 400);
    assert.equal((await prefs(teo, { level: 'needsYou' })).level, 'needsYou');
    assert.equal((await prefs(teo, { emailMe: false })).emailMe, false);
    assert.equal((await prefs(teo, { emailMe: true })).level, 'needsYou', 'changing the switch leaves the level');
  });
});
