import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  DEFAULT_PREFERENCES,
  NOTIFICATION_EMAIL_JOB,
  applyPreferenceChange,
  buildNotificationEmail,
  deliverNotificationEmail,
  deliverableAt,
  localMinutes,
  loadNotificationMailConfig,
  withoutAddress,
  type NotificationMailer,
  type PushSendJob,
} from '@flux/core';
import type { InboxItem, InboxResponse, NotificationPreferences, NotificationReason } from '@flux/contracts';
import { emailUnitOfWork, handleEmailJob, smtpNotificationMailer } from '../../apps/worker/src/notifications/index.js';
import { PgBoss } from 'pg-boss';
import { deliverPush } from '../../apps/worker/src/push/index.js';
import { loadPushSenderConfig } from '@flux/core';
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

/** Waits until the generator has passed every event committed so far. */
async function generatorCaughtUp() {
  const { rows } = await pool.query('SELECT max(seq) AS seq FROM events');
  const target = Number(rows[0].seq);
  await waitFor(async () => Number((await pool.query("SELECT seq FROM notification_cursor WHERE id = 'generator'")).rows[0].seq) >= target, 'the generator to catch up');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quiet hours that cover the current UTC minute, so push and email wait while the inbox fills. */
function quietNow(timeZone = 'UTC') {
  const start = (localMinutes(new Date(), timeZone) + 1440 - 30) % 1440;
  const end = (start + 120) % 1440;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { enabled: true, start: clock(start), end: clock(end), timeZone };
}

describe('preference rules', () => {
  test('quiet hours hold push and email until they end, in the person\'s own time zone', () => {
    const base = { ...DEFAULT_PREFERENCES, quietEnabled: true, quietStart: 22 * 60, quietEnd: 7 * 60, timeZone: 'Europe/Warsaw' };
    // 23:30 in Warsaw (CEST, UTC+2) is 21:30 UTC: inside, released at 07:00 local = 05:00 UTC.
    const late = new Date('2026-09-28T21:30:00Z');
    assert.equal(deliverableAt(base, late).toISOString(), '2026-09-29T05:00:00.000Z');
    // 12:00 local is outside.
    const noon = new Date('2026-09-28T10:00:00Z');
    assert.equal(deliverableAt(base, noon).getTime(), noon.getTime());
    // A same-day window and the exact end minute.
    const day = { ...base, quietStart: 9 * 60, quietEnd: 17 * 60, timeZone: 'UTC' };
    assert.equal(deliverableAt(day, new Date('2026-09-28T16:59:30Z')).toISOString(), '2026-09-28T17:00:00.000Z');
    assert.equal(deliverableAt(day, new Date('2026-09-28T17:00:00Z')).toISOString(), '2026-09-28T17:00:00.000Z');
    assert.equal(deliverableAt({ ...day, quietEnabled: false }, new Date('2026-09-28T12:00:00Z')).toISOString(), '2026-09-28T12:00:00.000Z');
  });

  test('changes are validated and one unsubscribe keeps the other address of "both"', () => {
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { channels: { everything: { email: true } } } as never), /Unknown notification reason/);
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { quietHours: { start: '25:00' } }), /time/);
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { quietHours: { timeZone: 'Mars/Olympus' } }), /time zone/);
    assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { emailDestination: 'everyone' as never }), /emailDestination/);
    const next = applyPreferenceChange(DEFAULT_PREFERENCES, { channels: { reply: { email: true } }, emailDestination: 'both', quietHours: { enabled: true, start: '21:30', end: '06:45', timeZone: 'Asia/Tokyo' } });
    assert.deepEqual(next.channels.reply, { email: true });
    assert.equal(next.quietStart, 21 * 60 + 30);
    assert.equal(withoutAddress('both', 'account'), 'extra');
    assert.equal(withoutAddress('extra', 'extra'), 'none');
    assert.equal(withoutAddress('account', 'extra'), 'account');
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
    const result = expectStatus(await cy.browser.request('POST', `/api/v1/projects/${projectId}/results`, { body: { title: 'Recycled stock shows the grid lines', finding: 'positive', work: [work.id] } }), 201) as { id: string };
    const review = await waitForItem(ben, (item) => item.url?.endsWith(`decision:${decision.id}`) === true, 'Ben\'s decision review');
    assert.equal(review.reason, 'review');
    assert.equal(review.title, 'Decision to review: Print on recycled paper');
    const resultItem = await waitForItem(ben, (item) => item.url?.endsWith(`result:${result.id}`) === true, 'Ben\'s result review');
    assert.equal(resultItem.reason, 'review');
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

  test('a reason turned off for the inbox stays out of it; turned off everywhere, nothing is stored', async () => {
    await prefs(cy, { channels: { reply: { inApp: false, push: false, email: false } } });
    const thread = await conversation(cy, projectId, 'Cyra opens a thread about fonts');
    const answered = await reply(ada, thread.id, 'Serif for the headings');
    await generatorCaughtUp();
    assert.equal((await inbox(cy)).items.filter((item) => item.url?.endsWith(answered.id)).length, 0);
    assert.equal((await notificationRows(cy.id)).filter((row) => row.reason === 'reply').length, 0);
    await prefs(cy, { channels: { reply: { inApp: false, push: true } } });
    const second = await reply(ada, thread.id, 'And sans for the tables');
    await waitFor(async () => (await pool.query('SELECT in_inbox FROM notifications WHERE user_id = $1 AND url LIKE $2', [cy.id, `%${second.id}`])).rows[0], 'the push-only row');
    assert.equal((await inbox(cy)).items.filter((item) => item.url?.endsWith(second.id)).length, 0, 'push only: not listed in the inbox');
    await prefs(cy, { channels: { reply: { inApp: true, push: true } } });
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
    assert.deepEqual(await oneClick.json(), { result: 'stopped', stopped: 'account', destination: 'none' });
    const settings = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(settings.email.destination, 'none');
    // Unsubscribing changes nothing about sign-in.
    assert.equal((await signIn(reader.email, password)).response.status, 200);

    const count = (await mailsTo(reader.email)).length;
    const next = await conversation(owner, projectId, '@Raf Okoye another list');
    await waitForItem(reader, (entry) => entry.url?.endsWith(next.messages[0]!.id) === true, 'the next mention');
    await generatorCaughtUp();
    await sleep(1500);
    assert.equal((await mailsTo(reader.email)).length, count, 'no email after unsubscribing');
    await prefs(reader, { emailDestination: 'account' });
  });

  test('access is rechecked before email and push: someone removed meanwhile receives nothing', async () => {
    const leaver = await person('Lena Vos');
    await addMember(owner, workspaceId, leaver, 'member');
    await prefs(leaver, { quietHours: quietNow() });
    const { subscription, id: subscriptionId } = await subscribe(leaver.browser);
    const thread = await conversation(owner, projectId, '@Lena Vos the donor spreadsheet with phone numbers');
    const item = await waitForItem(leaver, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'Lena\'s mention');
    const [email] = await waitFor(async () => { const rows = await emailRows(leaver.id); return rows.length ? rows : null; }, 'the queued email');
    assert.equal(email!.status, 'queued', 'quiet hours hold the email');
    const held = await pool.query(`SELECT start_after FROM pgboss.job WHERE name = $1 AND data->>'emailId' = $2`, [NOTIFICATION_EMAIL_JOB, email!.id]);
    assert.ok(new Date(held.rows[0].start_after).getTime() > Date.now() + 60_000, 'the email job waits for the end of quiet hours');

    await removeMember(owner, workspaceId, leaver);
    const outcome = await deliverNotificationEmail({ available: true, origin, uow: emailUnitOfWork(db), mailer: smtp }, { emailId: email!.id });
    assert.deepEqual(outcome, { outcome: 'skipped', reason: 'recipient can no longer read the source' });
    const push = await deliverPush({ db, config: loadPushSenderConfig() }, { notificationId: item.id, subscriptionId, userId: leaver.id } satisfies PushSendJob);
    assert.equal(push.outcome, 'skipped');
    assert.equal((await mailsTo(leaver.email)).length, 0);
    assert.equal((await recordedPushes(subscription.mockId)).length, 0);
    assert.equal((await inbox(leaver)).items.length, 0, 'the inbox hides what the person can no longer read');
  });

  test('push follows the same preferences: turned off for a reason, the device gets nothing', async () => {
    const { subscription } = await subscribe(reader.browser);
    const dmId = await dm(owner, workspaceId, reader);
    const first = await dmMessage(owner, dmId, 'Seedlings are ready');
    await waitFor(async () => (await recordedPushes(subscription.mockId)).length === 1, 'the first push');
    await waitForItem(reader, (entry) => entry.url?.endsWith(first.id) === true, 'the first DM');
    await prefs(reader, { channels: { dm: { push: false } } });
    const second = await dmMessage(owner, dmId, 'Pick them up by Sunday');
    await waitForItem(reader, (entry) => entry.url?.endsWith(second.id) === true, 'the second DM');
    await sleep(1500);
    assert.equal((await recordedPushes(subscription.mockId)).length, 1);
    await prefs(reader, { channels: { dm: { push: true } } });
  });

  test('retries never send an email twice', async () => {
    const quiet = await person('Quinn Hale');
    await addMember(owner, workspaceId, quiet, 'member');
    await prefs(quiet, { quietHours: quietNow() });
    const thread = await conversation(owner, projectId, '@Quinn Hale please water the trays');
    await waitForItem(quiet, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'Quinn\'s mention');
    const [email] = await waitFor(async () => { const rows = await emailRows(quiet.id); return rows.length ? rows : null; }, 'the queued email');
    // Quiet hours held the job; end them so the in-process deliveries below may send.
    await prefs(quiet, { quietHours: { enabled: false } });
    const options = { available: true, origin, uow: emailUnitOfWork(db) };

    // SMTP refuses: the row goes back to queued and the job is retried.
    const failing: NotificationMailer = { send: async () => ({ kind: 'failed', message: '421 try later' }) };
    await assert.rejects(deliverNotificationEmail({ ...options, mailer: failing }, { emailId: email!.id }), /SMTP did not accept/);
    assert.equal((await emailRows(quiet.id))[0]!.status, 'queued');
    // Two deliveries race (a retry overlapping a slow first attempt): one email.
    const results = await Promise.all([1, 2].map(() => deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: email!.id })));
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['sent', 'skipped']);
    assert.equal((await emailRows(quiet.id))[0]!.status, 'sent');
    const again = await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: email!.id });
    assert.deepEqual(again, { outcome: 'skipped', reason: 'already sent' });
    // A send that may have reached SMTP before a crash (left "sending") is not repeated.
    await pool.query("UPDATE notification_emails SET status = 'sending' WHERE id = $1", [email!.id]);
    assert.deepEqual(await deliverNotificationEmail({ ...options, mailer: smtp }, { emailId: email!.id }), { outcome: 'skipped', reason: 'already sending' });
    await waitForMails(quiet.email, 1, 'the one email');
    await sleep(500);
    assert.equal((await mailsTo(quiet.email)).length, 1);
  });

  test('an extra address is verified by a single-use link, receives email as chosen and can never sign in', async () => {
    const extra = `raf.home-${randomUUID()}@example.test`;
    const added = expectStatus(await reader.browser.request('POST', '/api/v1/notification-address', { body: { email: extra } }), 200) as NotificationPreferences;
    assert.deepEqual({ ...added.email.extra, sentAt: null }, { email: extra, verified: false, verifiedAt: null, sentAt: null });
    expectStatus(await reader.browser.request('POST', '/api/v1/notification-address', { body: { email: reader.email.toUpperCase() } }), 409);
    expectStatus(await reader.browser.request('POST', '/api/v1/notification-address/resend'), 429);
    const [verification] = await waitForMails(extra, 1, 'the verification email');
    const text = (await mailText(verification!.ID)).Text;
    assert.match(text, /can never be used to sign in/);
    const token = new URL(/(http\S+verify\?token=\S+)/.exec(text)![1]!).searchParams.get('token')!;

    // Only the account that added it can verify it.
    expectStatus(await owner.browser.request('POST', '/api/v1/notification-address/verify', { body: { token } }), 400);
    const verified = expectStatus(await reader.browser.request('POST', '/api/v1/notification-address/verify', { body: { token } }), 200) as NotificationPreferences;
    assert.equal(verified.email.extra?.verified, true);
    expectStatus(await reader.browser.request('POST', '/api/v1/notification-address/verify', { body: { token } }), 400, 'single use');

    // An expired link is refused.
    const other = await person('Tess Marlow');
    const pending = `tess.other-${randomUUID()}@example.test`;
    expectStatus(await other.browser.request('POST', '/api/v1/notification-address', { body: { email: pending } }), 200);
    const [otherMail] = await waitForMails(pending, 1, 'Tess\'s verification email');
    const otherToken = new URL(/(http\S+verify\?token=\S+)/.exec((await mailText(otherMail!.ID)).Text)![1]!).searchParams.get('token')!;
    await pool.query('UPDATE notification_address_tokens SET expires_at = now() - interval \'1 minute\' WHERE address_id = (SELECT id FROM notification_addresses WHERE user_id = $1)', [other.id]);
    expectStatus(await other.browser.request('POST', '/api/v1/notification-address/verify', { body: { token: otherToken } }), 400);

    // Extra address only: the mention goes there and not to the sign-in address.
    await prefs(reader, { emailDestination: 'extra' });
    const accountBefore = (await mailsTo(reader.email)).length;
    const room = (await project(owner, workspaceId, 'Compost rota', 'workspace')).id;
    const thread = await conversation(owner, room, '@Raf Okoye the rota for October');
    await waitForItem(reader, (entry) => entry.url?.endsWith(thread.messages[0]!.id) === true, 'the mention');
    const [delivered] = await waitForMails(extra, 2, 'the email to the extra address');
    assert.equal((await mailText(delivered!.ID)).Subject, 'New activity in Flux');
    await sleep(1000);
    assert.equal((await mailsTo(reader.email)).length, accountBefore);

    // The delivery address is never a login identity: no sign-in, no password reset mail.
    const login = await signIn(extra, password);
    assert.notEqual(login.response.status, 200);
    const extraMails = (await mailsTo(extra)).length;
    const reset = await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email: extra, redirectTo: `${publicOrigin}/reset-password` } });
    assert.equal(reset.status, 200);
    await sleep(1500);
    assert.equal((await mailsTo(extra)).length, extraMails);
    assert.equal((await signIn(reader.email, password)).response.status, 200, 'the sign-in address still works');

    // Removing the extra address never starts email to the sign-in address by itself.
    const removed = expectStatus(await reader.browser.request('DELETE', '/api/v1/notification-address'), 200) as NotificationPreferences;
    assert.equal(removed.email.extra, null);
    assert.equal(removed.email.destination, 'none');
    await prefs(reader, { emailDestination: 'account' });
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
  test('two SSO-style people get exactly the mailboxes they chose: sign-in only, extra only, both, in-app only', async () => {
    const lead = await person('Olek Brand');
    const iga = await named('Iga Nowak', `iga.${randomUUID().slice(0, 8)}@nebula.homes`);
    const jon = await named('Jon Petit', `jon.${randomUUID().slice(0, 8)}@nebula.homes`);
    const space = (await workspace(lead, 'Nebula homes')).id;
    await addMember(lead, space, iga, 'member');
    await addMember(lead, space, jon, 'member');
    const extras = new Map<Person, string>([[iga, `iga.private-${randomUUID()}@gmail.test`], [jon, `jon.private-${randomUUID()}@gmail.test`]]);
    for (const [someone, address] of extras) {
      expectStatus(await someone.browser.request('POST', '/api/v1/notification-address', { body: { email: address } }), 200);
      const [mail] = await waitForMails(address, 1, 'the verification email');
      const token = new URL(/(http\S+verify\?token=\S+)/.exec((await mailText(mail!.ID)).Text)![1]!).searchParams.get('token')!;
      expectStatus(await someone.browser.request('POST', '/api/v1/notification-address/verify', { body: { token } }), 200);
    }
    const counts = async () => Object.fromEntries(await Promise.all([iga, jon].flatMap((someone) => [
      mailsTo(someone.email).then((mails) => [`${someone.id}:account`, mails.length] as const),
      mailsTo(extras.get(someone)!).then((mails) => [`${someone.id}:extra`, mails.length - 1] as const),
    ]))) as Record<string, number>;
    const phases: [string, string][] = [['account', 'extra'], ['extra', 'both'], ['both', 'none'], ['none', 'account']];
    for (const [igaChoice, jonChoice] of phases) {
      await prefs(iga, { emailDestination: igaChoice });
      await prefs(jon, { emailDestination: jonChoice });
      const before = await counts();
      // A new project per phase: the calm window allows one email per person and place.
      const room = (await project(lead, space, `Unit ${igaChoice}-${jonChoice}`, 'workspace')).id;
      const thread = await conversation(lead, room, '@Iga Nowak and @Jon Petit, the lift inspection report is in');
      for (const someone of [iga, jon]) await waitForItem(someone, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'the in-app record');
      const expected = (someone: Person, choice: string) => ({
        [`${someone.id}:account`]: before[`${someone.id}:account`]! + (choice === 'account' || choice === 'both' ? 1 : 0),
        [`${someone.id}:extra`]: before[`${someone.id}:extra`]! + (choice === 'extra' || choice === 'both' ? 1 : 0),
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
    await waitForItem(target, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'the in-app record');
    const [email] = await waitFor(async () => { const rows = await emailRows(target.id); return rows.length ? rows : null; }, 'the queued email');
    await prefs(target, { quietHours: { enabled: false } });
    const failing: NotificationMailer = { send: async () => ({ kind: 'failed', message: 'connect ECONNREFUSED' }) };
    await assert.rejects(deliverNotificationEmail({ available: true, origin, uow: emailUnitOfWork(db), mailer: failing }, { emailId: email!.id }));
    const view = expectStatus(await target.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(view.email.available, true);
    assert.ok(view.email.lastFailureAt, 'the person can see that email delivery failed');
    assert.equal((await inbox(target)).items.filter((item) => item.url?.endsWith(thread.messages[0]!.id)).length, 1, 'the inbox keeps it');
    assert.equal((await emailRows(target.id))[0]!.status, 'queued');
  });
});

async function verifyExtra(someone: Person, address: string) {
  expectStatus(await someone.browser.request('POST', '/api/v1/notification-address', { body: { email: address } }), 200);
  const [mail] = await waitForMails(address, 1, 'the verification email');
  const token = new URL(/(http\S+verify\?token=\S+)/.exec((await mailText(mail!.ID)).Text)![1]!).searchParams.get('token')!;
  expectStatus(await someone.browser.request('POST', '/api/v1/notification-address/verify', { body: { token } }), 200);
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
  return await response.json() as { result: string; stopped: string; destination: string };
}

describe('review fixes: exact unsubscribe, bounded verification, quiet hours at delivery', () => {
  const boss = new PgBoss({ connectionString, migrate: false });
  before(() => boss.start());
  after(() => boss.stop());

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

  test('an old unsubscribe link cannot stop a newer address, or a changed sign-in address', async () => {
    const lead = await person('Uma Kerr');
    const reader = await person('Vic Lamb');
    const space = (await workspace(lead, 'Link lane')).id;
    await addMember(lead, space, reader, 'member');
    const first = `vic.a-${randomUUID()}@example.test`;
    const second = `vic.b-${randomUUID()}@example.test`;
    await verifyExtra(reader, first);
    await prefs(reader, { emailDestination: 'extra' });
    const mention = async (name: string) => {
      const room = (await project(lead, space, name, 'workspace')).id;
      const thread = await conversation(lead, room, `@Vic Lamb ${name} is ready`);
      await waitForItem(reader, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, name);
    };
    await mention('Rota A');
    const [toFirst] = await waitForMails(first, 2, 'the email to address A');
    const staleLink = unsubscribeUrl((await mailText(toFirst!.ID)).headers);

    // Replace A with a verified B; B is the extra address now.
    await skipCooldown(reader);
    await verifyExtra(reader, second);
    assert.deepEqual(await oneClick(staleLink), { result: 'stale', stopped: 'extra', destination: 'extra' });
    const settings = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(settings.email.destination, 'extra');
    await mention('Rota B');
    const [toSecond] = await waitForMails(second, 2, 'B still receives email');
    assert.equal((await mailText(toSecond!.ID)).Subject, 'New activity in Flux');

    // A sign-in address that changed since the email: its old link changes nothing either.
    await prefs(reader, { emailDestination: 'account' });
    await mention('Rota C');
    const [toAccount] = await waitForMails(reader.email, 1, 'the email to the sign-in address');
    const accountLink = unsubscribeUrl((await mailText(toAccount!.ID)).headers);
    const renamed = `vic.new-${randomUUID()}@example.test`;
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [renamed, reader.id]);
    assert.deepEqual(await oneClick(accountLink), { result: 'stale', stopped: 'account', destination: 'account' });
    await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [reader.email, reader.id]);
    // The current link still works.
    assert.deepEqual(await oneClick(accountLink), { result: 'stopped', stopped: 'account', destination: 'none' });
  });

  test('verification sends are bounded across add, replace and resend, also when requests race', async () => {
    const someone = await person('Wes Moor');
    const target = `wes.target-${randomUUID()}@example.test`;
    expectStatus(await someone.browser.request('POST', '/api/v1/notification-address', { body: { email: target } }), 200);
    const again = await someone.browser.request('POST', '/api/v1/notification-address', { body: { email: target } });
    assert.equal(again.status, 429, 'replacing does not reset the cooldown');
    assert.ok(Number(again.headers.get('retry-after')) >= 1);
    assert.equal((await someone.browser.request('POST', '/api/v1/notification-address/resend')).status, 429);

    // Concurrent replacements after the cooldown: exactly one sends.
    await skipCooldown(someone);
    const racing = await Promise.all([1, 2, 3, 4].map(() => someone.browser.request('POST', '/api/v1/notification-address', { body: { email: target } })));
    assert.deepEqual(racing.map((response) => response.status).sort(), [200, 429, 429, 429]);

    // Even with the cooldown out of the way, at most 5 per hour.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await skipCooldown(someone);
      const response = await someone.browser.request('POST', '/api/v1/notification-address', { body: { email: target } });
      statuses.push(response.status);
      if (response.status === 429) assert.ok(Number(response.headers.get('retry-after')) > 60, 'the hourly limit says when it resets');
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429], 'two sends before plus three here make five');
    await sleep(1000);
    assert.equal((await mailsTo(target)).length, 5, 'five verification emails, no more');
  });

  test('quiet hours switched on after a job was queued hold its email and push until they end', async () => {
    const lead = await person('Xia Holt');
    const reader = await person('Yan Frost');
    const space = (await workspace(lead, 'Quiet lane')).id;
    await addMember(lead, space, reader, 'member');
    const room = (await project(lead, space, 'Night shift', 'workspace')).id;
    const { subscription, id: subscriptionId } = await subscribe(reader.browser);
    // A notification and its email queued while quiet hours were off (no job runs them yet).
    const notificationId = randomUUID();
    const emailId = randomUUID();
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason)
      VALUES ($1, $2, $3, 'project', $4, 'Xia Holt mentioned you in Night shift', 'hello', $5, 'mention')`, [notificationId, reader.id, space, room, `/projects/${room}`]);
    await pool.query(`INSERT INTO notification_emails (id, notification_id, user_id, address_kind) VALUES ($1, $2, $3, 'account')`, [emailId, notificationId, reader.id]);

    // Then the person turns quiet hours on, covering now, in their own (DST-observing) zone.
    const window = quietNow('Europe/Warsaw');
    await prefs(reader, { quietHours: window });
    const options = { available: true, origin, uow: emailUnitOfWork(db), mailer: smtp };
    const deferred = await handleEmailJob(boss, options, { emailId });
    assert.equal(deferred.outcome, 'deferred');
    const until = (deferred as { until: Date }).until;
    assert.ok(until.getTime() > Date.now() + 60_000);
    const endMinutes = Number(window.end.slice(0, 2)) * 60 + Number(window.end.slice(3));
    assert.equal(localMinutes(until, 'Europe/Warsaw'), endMinutes, 'released at the chosen local end time in Warsaw');
    const requeued = await pool.query(`SELECT start_after FROM pgboss.job WHERE name = $1 AND data->>'emailId' = $2`, [NOTIFICATION_EMAIL_JOB, emailId]);
    assert.equal(requeued.rowCount, 1, 'the email job is queued again for the end of quiet hours');
    assert.equal(new Date(requeued.rows[0].start_after).getTime(), until.getTime());
    const push = await deliverPush({ db, config: loadPushSenderConfig() }, { notificationId, subscriptionId, userId: reader.id });
    assert.equal(push.outcome, 'deferred');
    assert.equal((await emailRows(reader.id))[0]!.status, 'queued');
    assert.equal((await mailsTo(reader.email)).length, 0);
    assert.equal((await recordedPushes(subscription.mockId)).length, 0);

    // When quiet hours end (here: turned off), the same row and subscription send once.
    await prefs(reader, { quietHours: { enabled: false } });
    assert.deepEqual(await deliverNotificationEmail(options, { emailId }), { outcome: 'sent', addressKind: 'account' });
    assert.equal((await deliverPush({ db, config: loadPushSenderConfig() }, { notificationId, subscriptionId, userId: reader.id })).outcome, 'sent');
    await waitForMails(reader.email, 1, 'the released email');
    assert.equal((await recordedPushes(subscription.mockId)).length, 1);
  });
});
