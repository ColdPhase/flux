import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { InboxItem, InboxResponse, NotificationPreferences, PushPayload } from '@flux/contracts';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { db } from './support/db.js';
import { Browser, register, uniqueEmail } from './support/http.js';
import { addMember, expectStatus, password, project, workspace, type Person } from './support/people.js';
import { decryptPush, recordedPushes, subscribe, waitFor, type TestSubscription } from './support/push.js';

// "Hide previews" (founder decision, 2026-11-13, #1346) through the real API, worker and push service: the switch persists per person, and
// with it on the payload the push service receives (decrypted here, as the device would) carries only who and where, for a direct message,
// a mention, a task and a call; with it off the same notices show their text. In-app notices are the same either way. Every other kind is
// in notification-hide-previews-core.test.ts, which runs the real generator and delivery over in-memory ports.

const SECRET = 'SECRET-WORDS-ONLY-FOR-THE-INBOX';

async function named(name: string): Promise<Person> {
  const email = uniqueEmail(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const { browser } = await register(email, password, name);
  const me = expectStatus(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
  return { id: me.user.id, email, browser };
}

const prefs = async (someone: Person, change: object) =>
  expectStatus(await someone.browser.request('PATCH', '/api/v1/notification-preferences', { body: change }), 200) as NotificationPreferences;
const inbox = async (someone: Person) => expectStatus(await someone.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse;
const waitForItem = (someone: Person, match: (item: InboxItem) => boolean, what: string) => waitFor(async () => (await inbox(someone)).items.find(match), what);

/** The payloads the device received so far, decrypted, in the order sent. */
async function received(subscription: TestSubscription): Promise<PushPayload[]> {
  return (await recordedPushes(subscription.mockId)).filter((push) => push.status === 201)
    .map((push) => JSON.parse(decryptPush(Buffer.from(push.bodyBase64, 'base64'), subscription)) as PushPayload);
}
/** The next payload after `known` have arrived. */
async function nextPush(subscription: TestSubscription, known: number): Promise<PushPayload> {
  const all = await waitFor(async () => { const list = await received(subscription); return list.length > known ? list : null; }, 'the next push');
  return all[known]!;
}

describe('Hide previews (#1346)', () => {
  let ada: Person;
  let cyra: Person;
  let workspaceId: string;
  let spaceId: string;
  let dmId: string;
  let subscription: TestSubscription;

  before(async () => {
    ada = await named('Ada Hide');
    cyra = await named('Cyra Hide');
    workspaceId = (await workspace(ada, 'Hide previews checks')).id;
    await addMember(ada, workspaceId, cyra, 'member');
    spaceId = (await project(ada, workspaceId, 'Tool library', 'workspace')).id;
    const created = await ada.browser.request('POST', `/api/v1/workspaces/${workspaceId}/dms`, { body: { participantIds: [cyra.id] } });
    assert.ok(created.status === 201 || created.status === 200, created.text);
    dmId = (created.json as { id: string }).id;
    subscription = (await subscribe(cyra.browser)).subscription;
    // "Everything" pushes a call too; the other kinds need nothing more.
    await prefs(cyra, { level: 'everything' });
  });

  const sendDm = async (body: string) =>
    expectStatus(await ada.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
  const mention = async (body: string) =>
    expectStatus(await ada.browser.request('POST', `/api/v1/projects/${spaceId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string; messages: { id: string }[] };

  test('the switch is off by default, persists per person, and takes only true or false', async () => {
    const fresh = expectStatus(await cyra.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
    assert.equal(fresh.hidePreviews, false);
    const on = await prefs(cyra, { hidePreviews: true });
    assert.equal(on.hidePreviews, true);
    assert.equal(on.level, 'everything', 'the other choices stay as they were');
    assert.equal(((await cyra.browser.request('GET', '/api/v1/notification-preferences')).json as NotificationPreferences).hidePreviews, true, 'read again, it is still on');
    assert.equal(((await ada.browser.request('GET', '/api/v1/notification-preferences')).json as NotificationPreferences).hidePreviews, false, 'it is Cyra\'s, not everyone\'s');
    assert.equal((await prefs(cyra, { emailMe: false })).hidePreviews, true, 'another change leaves it on');
    // A value that is not true or false is refused (the route's schema, and the rules in notification-hide-previews-core.test.ts).
    for (const bad of ['yes', 7, { on: true }]) {
      const refused = await cyra.browser.request('PATCH', '/api/v1/notification-preferences', { body: { hidePreviews: bad } });
      assert.equal(refused.status, 400, `${JSON.stringify(bad)} is refused`);
    }
    assert.equal((await prefs(cyra, { hidePreviews: false })).hidePreviews, false);
    assert.equal((await new Browser().request('PATCH', '/api/v1/notification-preferences', { body: { hidePreviews: true } })).status, 401);
  });

  test('on, a direct message, a mention, a task and a call say only who and where; off, they show their text', async () => {
    let known = 0;
    const next = async () => { const payload = await nextPush(subscription, known); known += 1; return payload; };

    await prefs(cyra, { hidePreviews: true });
    const message = await sendDm(`Meet at the dock at nine ${SECRET}`);
    const hiddenDm = await next();
    assert.deepEqual(hiddenDm, { preview: 'hidden', notificationId: hiddenDm.notificationId, title: 'Ada Hide sent you a message' });

    const thread = await mention(`@Cyra please look at the plan ${SECRET}`);
    const hiddenMention = await next();
    assert.deepEqual(hiddenMention, { preview: 'hidden', notificationId: hiddenMention.notificationId, title: 'Ada Hide mentioned you in Tool library' });

    expectStatus(await ada.browser.request('POST', `/api/v1/projects/${spaceId}/work`, { body: { title: `Proofread ${SECRET}`, owner: { kind: 'human', id: cyra.id } } }), 201);
    const hiddenTask = await next();
    assert.deepEqual(hiddenTask, { preview: 'hidden', notificationId: hiddenTask.notificationId, title: 'Ada Hide assigned you a task in Tool library' });

    await liveSessionStore(db).createOrGet({ kind: 'human', id: ada.id }, spaceId, { type: 'space', id: spaceId }, randomUUID(), async () => {});
    const hiddenCall = await next();
    assert.deepEqual(hiddenCall, { preview: 'hidden', notificationId: hiddenCall.notificationId, title: 'Ada Hide started a call in Tool library' });
    for (const payload of [hiddenDm, hiddenMention, hiddenTask, hiddenCall]) {
      assert.deepEqual(Object.keys(payload).sort(), ['notificationId', 'preview', 'title'], 'no body and no link');
      assert.doesNotMatch(JSON.stringify(payload), new RegExp(SECRET), 'no content in the payload itself');
    }

    // In the app nothing changed: the Inbox still holds the words, and the notice reads the same item.
    const dmItem = await waitForItem(cyra, (item) => item.url?.endsWith(message.id) === true, 'the direct message in the Inbox');
    assert.match(dmItem.body, new RegExp(SECRET));
    const mentionItem = await waitForItem(cyra, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'the mention in the Inbox');
    assert.match(mentionItem.body, new RegExp(SECRET));
    const taskItem = await waitForItem(cyra, (item) => item.reason === 'assigned', 'the task in the Inbox');
    assert.match(taskItem.title, new RegExp(SECRET));

    // Off, the same kinds show their text again.
    await prefs(cyra, { hidePreviews: false });
    await sendDm(`And again ${SECRET}`);
    const shownDm = await next();
    assert.equal(shownDm.preview, 'full');
    assert.match(JSON.stringify(shownDm), new RegExp(SECRET));
    await mention(`@Cyra and once more ${SECRET}`);
    const shownMention = await next();
    assert.equal(shownMention.preview, 'full');
    assert.match(JSON.stringify(shownMention), new RegExp(SECRET));
  });
});
