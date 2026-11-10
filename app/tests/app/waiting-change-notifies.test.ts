import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';
import { assistantChangeActionPath, assistantRunChangesActionPath, NEEDS_YOU_PATH, NOTIFICATION_EMAIL_SUBJECT, type InboxItem, type InboxResponse, type NeedsYouResponse } from '@flux/contracts';
import { localMinutes } from '@flux/core';
import { pool } from './support/db.js';
import { mailpitUrl } from './support/http.js';
import { expectStatus, type Person } from './support/people.js';
import { recordedPushes, subscribe, waitFor } from './support/push.js';
import { assistantScene, changesOf, text, type AssistantScene } from './support/assistant-scene.js';

// F-036 item 10 (#1186): "Only what needs me" includes an agent waiting for you. When a run (or a local client) starts waiting for its
// owner's OK, the owner alone is told once, by push and email, with a link that opens the waiting card. Quiet hours and a muted space
// hold it back as for every other reason; once nothing of the run waits any more, the notification is read. The run's changes go through
// the real `/mcp` route with the run's own token; the real worker writes the notifications and sends them to the push mock and Mailpit.

let scene: AssistantScene;
const inbox = async (someone: Person) => (expectStatus(await someone.browser.request('GET', '/api/v1/inbox?limit=100'), 200) as InboxResponse).items;
const approvals = async (someone: Person, runId?: string) => (await inbox(someone))
  .filter((item: InboxItem) => item.reason === 'approval' && (!runId || item.url === `/inbox?item=assistant:${runId}`));
const prefs = async (someone: Person, change: object) => expectStatus(await someone.browser.request('PATCH', '/api/v1/notification-preferences', { body: change }), 200);
const decide = async (id: string, action: 'apply' | 'skip') => expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(id, action), { body: {} }), 200);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every event written so far has been through the notification generator. */
async function generatorCaughtUp() {
  const target = Number((await pool.query('SELECT max(seq) AS seq FROM events')).rows[0].seq);
  await waitFor(async () => Number((await pool.query("SELECT seq FROM notification_cursor WHERE id = 'generator'")).rows[0].seq) >= target, 'the generator to catch up');
}
/** Quiet hours that cover the current minute, so push and email are not sent while the Inbox fills (C-31). */
function quietNow(timeZone = 'UTC') {
  const start = (localMinutes(new Date(), timeZone) + 1440 - 30) % 1440;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { enabled: true, start: clock(start), end: clock((start + 120) % 1440), timeZone };
}
/** The notification emails to this address (content-free, C-32: a fixed subject and a link to the notification). */
async function notificationMails(address: string) {
  const response = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  const found = (await response.json() as { messages: { ID: string; Subject: string }[] }).messages.filter((mail) => mail.Subject === NOTIFICATION_EMAIL_SUBJECT);
  return Promise.all(found.map(async (mail) => (await (await fetch(`${mailpitUrl}/api/v1/message/${mail.ID}`)).json() as { Text: string }).Text));
}
/** A run of the owner's agent that prepares these tasks; under Ask me first each one waits for the owner's OK. */
async function runWaiting(titles: readonly string[]) {
  const live = await scene.liveRun();
  for (const title of titles) assert.match(text((await live.call('flux_create_task', { task: { title } })).message), /^Waiting for /);
  return live;
}

describe('an agent waiting for your OK notifies its owner (F-036 item 10, #1186)', () => {
  before(async () => { scene = await assistantScene('wn'); });
  beforeEach(async () => {
    await scene.reset();
    await prefs(scene.owner, { level: 'needsYou', quietHours: { enabled: false } });
    await pool.query(`UPDATE assistant_changes SET state = 'skipped', wait_reason = NULL, version = version + 1 WHERE owner_user_id = $1 AND state = 'waiting'`, [scene.owner.id]);
  });

  test('a run with five changes waiting is one notification, by push and email, to the owner alone, opening its card', async () => {
    const { subscription } = await subscribe(scene.owner.browser);
    await scene.setMayDo('ask');
    const live = await runWaiting(['Order six probes', 'Label the cables', 'Charge the batteries', 'Seal the junction box', 'Mount the gateway']);
    const [note] = await waitFor(async () => { const list = await approvals(scene.owner, live.runId); return list.length ? list : null; }, 'the owner is told');
    await waitFor(async () => (await recordedPushes(subscription.mockId)).length >= 1, 'the push');
    await waitFor(async () => (await notificationMails(scene.owner.email)).some((mail) => mail.includes(`/inbox/${note!.id}`)), 'the email');
    await generatorCaughtUp();
    await sleep(1500);
    assert.equal((await approvals(scene.owner, live.runId)).length, 1, 'one notification for the run, not one per change');
    assert.equal((await recordedPushes(subscription.mockId)).length, 1, 'one push for the run');
    assert.equal((await notificationMails(scene.owner.email)).length, 1, 'one email for the run, linking to its notification');
    assert.equal(note!.title, 'Ada assistant is waiting for your OK');
    assert.equal(note!.body, 'Add “Order six probes” · Lamp sensor');
    assert.equal(note!.url, `/inbox?item=assistant:${live.runId}`, 'it opens the waiting card');
    assert.equal(note!.readAt, null);
    const queue = expectStatus(await scene.owner.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
    assert.ok(queue.items.some((item) => item.key === `assistant:${live.runId}`), 'the card the link opens is in the Inbox');
    // The owner decides; nobody else in the space, the company's owner included, is told anything about it.
    for (const someone of [scene.peer, scene.lead, scene.outsider, scene.admin]) {
      assert.deepEqual((await inbox(someone)).filter((item) => item.reason === 'approval' || item.url?.includes(live.runId)), [], 'only the owner is told');
    }
  });

  test('a change to someone else\'s task waits under Do it and tell me, and tells its owner, never the person it is about (#1092)', async () => {
    const theirs = await scene.task(scene.peer, 'Jonas checks the gateway');
    const live = await scene.liveRun();
    assert.match(text((await live.call('flux_update_task', { workId: theirs.id, expectedVersion: theirs.version, changes: { title: 'Jonas checks both gateways' } })).message), /^Waiting for /);
    const [note] = await waitFor(async () => { const list = await approvals(scene.owner, live.runId); return list.length ? list : null; }, 'the owner is told');
    assert.equal(note!.body, `Rename “#${theirs.number} Jonas checks the gateway” · Lamp sensor`);
    await generatorCaughtUp();
    assert.deepEqual((await inbox(scene.peer)).filter((item) => item.reason === 'approval' || item.url?.includes(live.runId)), [], 'Jonas hears nothing until the owner decides');
  });

  test('quiet hours keep it in the Inbox with no push, and a muted space tells nothing', async () => {
    const { subscription } = await subscribe(scene.owner.browser);
    await scene.setMayDo('ask');
    await prefs(scene.owner, { quietHours: quietNow() });
    const quiet = await runWaiting(['Quiet hours task']);
    await waitFor(async () => (await approvals(scene.owner, quiet.runId)).length === 1, 'the notification in the Inbox');
    await generatorCaughtUp();
    await sleep(1500);
    assert.equal((await recordedPushes(subscription.mockId)).length, 0, 'no push during quiet hours');
    await scene.complete(quiet.runId);

    await prefs(scene.owner, { quietHours: { enabled: false } });
    expectStatus(await scene.owner.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: scene.place.id, muted: true } }), 200);
    try {
      const muted = await runWaiting(['Muted space task']);
      await generatorCaughtUp();
      await sleep(1000);
      assert.equal((await approvals(scene.owner, muted.runId)).length, 0, 'a muted space tells nothing');
      assert.equal((await recordedPushes(subscription.mockId)).length, 0);
    } finally {
      expectStatus(await scene.owner.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: scene.place.id, muted: false } }), 200);
    }
  });

  test('it is read once nothing of the run waits: after a skip and an approve, and after Approve all', async () => {
    await scene.setMayDo('ask');
    const live = await runWaiting(['Buy cable ties', 'Buy heat shrink']);
    await waitFor(async () => (await approvals(scene.owner, live.runId)).length === 1, 'the owner is told');
    const [first, second] = await changesOf(live.runId);
    await decide(first!.id, 'skip');
    assert.equal((await approvals(scene.owner, live.runId))[0]!.readAt, null, 'something of the run still waits');
    await decide(second!.id, 'apply');
    assert.ok((await approvals(scene.owner, live.runId))[0]!.readAt, 'nothing waits any more: it is read');

    // A change that waits later in the same run tells the owner again; Approve all reads that one too.
    assert.match(text((await live.call('flux_create_task', { task: { title: 'Buy solder' } })).message), /^Waiting for /);
    await waitFor(async () => (await approvals(scene.owner, live.runId)).filter((item) => !item.readAt).length === 1, 'the owner is told again');
    expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(live.runId, 'apply'), { body: {} }), 200);
    assert.deepEqual((await approvals(scene.owner, live.runId)).map((item) => !!item.readAt), [true, true]);
  });
});
