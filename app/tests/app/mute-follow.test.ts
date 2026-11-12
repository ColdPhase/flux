import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { REACHES_MUTED_PLACE, preferenceRepository } from '@flux/core';
import {
  DM_NOTIFICATIONS_CHANGED_EVENT,
  NOTIFICATION_FOLLOWS_PATH,
  NOTIFICATION_MUTES_PATH,
  NOTIFICATION_PREFERENCES_PATH,
  NOTIFICATION_REASONS,
  PROJECT_NOTIFICATIONS_CHANGED_EVENT,
  notificationFollowPath,
  type InboxItem,
  type InboxResponse,
  type MutedPlacesResponse,
  type NotificationPreferences,
  type NotificationReason,
  type ThreadFollow,
} from '@flux/contracts';
import { pushPreferenceCheck } from '../../apps/worker/src/notifications/adapters.js';
import { db, pool } from './support/db.js';
import { signIn } from './support/http.js';
import { addMember, expectStatus, password, person, project, secondSession, workspace, type Person } from './support/people.js';
import { recordedPushes, subscribe, waitFor } from './support/push.js';
import { StreamClient } from './support/stream.js';

// Mute a place and follow a thread from where they are (#1249). A muted place keeps ordinary notices quiet on every channel (inbox, push,
// email) while a mention of the person and a question to them still arrive; an unfollowed thread sends no reply notices; both persist and
// reach the person's other open tabs through the stream. The one rule is `PreferenceRepository.quiet`, which the generator, the push job
// and the email job all ask.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function inbox(someone: Person) {
  return expectStatus(await someone.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse;
}
const waitForItem = (someone: Person, match: (item: InboxItem) => boolean, what: string) =>
  waitFor(async () => (await inbox(someone)).items.find(match), what);

/** Waits until the generator has passed every event committed so far, so "nothing arrived" is a fact and not a race. */
async function generatorCaughtUp() {
  const { rows } = await pool.query('SELECT max(seq) AS seq FROM events');
  const target = Number(rows[0].seq);
  await waitFor(async () => Number((await pool.query("SELECT seq FROM notification_cursor WHERE id = 'generator'")).rows[0].seq) >= target, 'the generator to catch up');
}

async function rowsFor(someone: Person) {
  return (await pool.query('SELECT id, reason, url, source_type, source_id FROM notifications WHERE user_id = $1 ORDER BY created_at', [someone.id])).rows as
    { id: string; reason: NotificationReason; url: string; source_type: string; source_id: string }[];
}
const arrived = async (someone: Person, messageId: string) => (await rowsFor(someone)).find((row) => row.url.endsWith(messageId));

async function conversation(someone: Person, projectId: string, body: string) {
  return expectStatus(await someone.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string; messages: { id: string }[] };
}
async function reply(someone: Person, conversationId: string, body: string) {
  return expectStatus(await someone.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
}
async function openDm(from: Person, workspaceId: string, to: Person) {
  const created = await from.browser.request('POST', `/api/v1/workspaces/${workspaceId}/dms`, { body: { participantIds: [to.id] } });
  assert.ok(created.status === 201 || created.status === 200, created.text);
  return (created.json as { id: string }).id;
}
async function dmMessage(from: Person, dmId: string, body: string) {
  return expectStatus(await from.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
}
async function setMute(someone: Person, type: 'project' | 'dm', id: string, muted: boolean) {
  return expectStatus(await someone.browser.request('PUT', NOTIFICATION_MUTES_PATH, { body: { type, id, muted } }), 200) as NotificationPreferences;
}
async function follows(someone: Person, conversationId: string) {
  return (expectStatus(await someone.browser.request('GET', notificationFollowPath(conversationId)), 200) as ThreadFollow).following;
}
async function setFollow(someone: Person, conversationId: string, following: boolean) {
  return expectStatus(await someone.browser.request('PUT', NOTIFICATION_FOLLOWS_PATH, { body: { conversationId, following } }), 200) as ThreadFollow;
}
async function level(someone: Person, value: 'needsYou' | 'everything' | 'nothing') {
  expectStatus(await someone.browser.request('PATCH', NOTIFICATION_PREFERENCES_PATH, { body: { level: value } }), 200);
}

describe('the one rule for a muted place (#1249)', () => {
  const store = (muted: boolean) => preferenceRepository({
    find: async () => null, save: async () => undefined, isMuted: async () => muted, mutes: async () => [], setMuted: async () => undefined,
  });
  const source = { type: 'project', id: randomUUID() };

  test('only a mention and a question reach a muted place; every other reason is quiet; an unmuted place is quiet for none', async () => {
    assert.deepEqual([...REACHES_MUTED_PLACE].sort(), ['mention', 'question']);
    for (const reason of NOTIFICATION_REASONS) {
      assert.equal(await store(true).quiet('u', source, reason), reason !== 'mention' && reason !== 'question', `muted, ${reason}`);
      assert.equal(await store(false).quiet('u', source, reason), false, `not muted, ${reason}`);
    }
    // A notice with no stored reason (written directly) is as quiet as an ordinary one.
    assert.equal(await store(true).quiet('u', source, null), true);
  });
});

describe('mute and follow from where they are (#1249)', () => {
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
    projectId = (await project(ada, workspaceId, 'Harbour log', 'workspace')).id;
  });

  test('a muted space sends no notice, push or email for an ordinary reply, but a mention and a question still arrive; unmuting brings replies back', async () => {
    // At Everything a reply would push and email, so a silent reply is the mute's doing and not the level's.
    await level(cy, 'everything');
    const { subscription } = await subscribe(cy.browser);
    const pushes = async () => (await recordedPushes(subscription.mockId)).length;
    const thread = await conversation(cy, projectId, 'Cyra opens the tide log');
    const control = await reply(ada, thread.id, 'The log is open for October');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(control.id) === true, 'the reply before muting')).reason, 'reply');
    await waitFor(async () => (await pushes()) === 1, 'the push for the reply before muting');
    const mailsBefore = Number((await pool.query('SELECT count(*) AS n FROM notification_emails WHERE user_id = $1', [cy.id])).rows[0].n);
    assert.equal(mailsBefore, 1, 'and its email');

    const muted = await setMute(cy, 'project', projectId, true);
    assert.deepEqual(muted.muted, [{ type: 'project', id: projectId, name: 'Harbour log' }]);
    const plain = await reply(ada, thread.id, 'Plain reply while muted');
    const mention = await reply(ada, thread.id, '@Cyra Lind the harbour master sent new times');
    const asked = await reply(ada, thread.id, '@Cyra Lind which tide table do you want?');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(mention.id) === true, 'the mention in the muted space')).reason, 'mention');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(asked.id) === true, 'the question in the muted space')).reason, 'question');
    await waitFor(async () => (await pushes()) === 3, 'the pushes for the mention and the question');
    await generatorCaughtUp();
    assert.equal(await arrived(cy, plain.id), undefined, 'no inbox item for the plain reply');
    assert.equal((await inbox(cy)).items.some((item) => item.url?.endsWith(plain.id)), false);
    await sleep(1000);
    assert.equal(await pushes(), 3, 'and no push for it');
    // Its email would have been the next row of this person's mail: the calm window holds the question's too, so no row can be the reply's.
    const rows = await rowsFor(cy);
    const mails = (await pool.query('SELECT notification_id FROM notification_emails WHERE user_id = $1', [cy.id])).rows as { notification_id: string }[];
    assert.ok(mails.every((mail) => rows.some((row) => row.id === mail.notification_id)), 'every email belongs to a notice that exists');
    assert.equal(mails.some((mail) => mail.notification_id === rows.find((row) => row.url.endsWith(plain.id))?.id), false, 'no email for the plain reply');

    const unmuted = await setMute(cy, 'project', projectId, false);
    assert.deepEqual(unmuted.muted, []);
    const again = await reply(ada, thread.id, 'Plain reply after unmuting');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(again.id) === true, 'the reply after unmuting')).reason, 'reply');
    await waitFor(async () => (await pushes()) === 4, 'the push after unmuting');
  });

  test('the push and the email jobs ask the same rule: a notice written before the mute, of an ordinary reason, is not sent; a mention is', async () => {
    const q = await person('Quinn Reed');
    await addMember(ada, workspaceId, q, 'member');
    await level(q, 'everything');
    const wanted = pushPreferenceCheck(db);
    const notice = (reason: NotificationReason | null) => ({
      id: randomUUID(), userId: q.id, source: { workspaceId, type: 'project' as const, id: projectId }, title: 't', body: 'b', url: null, createdAt: new Date(), readAt: null, reason,
    });
    assert.equal(await wanted(q.id, notice('reply')), true, 'not muted: a reply pushes at Everything');
    await setMute(q, 'project', projectId, true);
    assert.equal(await wanted(q.id, notice('reply')), false, 'muted: the reply is not pushed');
    assert.equal(await wanted(q.id, notice('dm')), false);
    assert.equal(await wanted(q.id, notice('mention')), true, 'a mention still is');
    assert.equal(await wanted(q.id, notice('question')), true, 'and a question');
    await setMute(q, 'project', projectId, false);
  });

  test('a muted direct message is quiet for ordinary messages; one that names you still arrives', async () => {
    await level(cy, 'everything');
    const dmId = await openDm(ada, workspaceId, cy);
    const control = await dmMessage(ada, dmId, 'Lunch at the harbour on Friday');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(control.id) === true, 'the DM before muting')).reason, 'dm');
    const muted = await setMute(cy, 'dm', dmId, true);
    assert.ok(muted.muted.some((place) => place.type === 'dm' && place.id === dmId), 'listed in Settings');
    const plain = await dmMessage(ada, dmId, 'Did you see the harbour photos');
    const mention = await dmMessage(ada, dmId, '@Cyra Lind lunch at noon');
    const question = await dmMessage(ada, dmId, '@Cyra Lind lunch at noon, can you?');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(mention.id) === true, 'the mention in the muted DM')).reason, 'mention');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(question.id) === true, 'the question in the muted DM')).reason, 'question');
    await generatorCaughtUp();
    assert.equal(await arrived(cy, plain.id), undefined, 'the plain message is quiet');
    await setMute(cy, 'dm', dmId, false);
    const after = await dmMessage(ada, dmId, 'Plain again');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(after.id) === true, 'the DM after unmuting')).reason, 'dm');
  });

  test('a thread is followed by default by whoever started it or wrote in it; unfollowing stops its replies, not a mention; Follow brings them back', async () => {
    const thread = await conversation(ada, projectId, 'Ada starts the ferry timetable thread');
    assert.equal(await follows(ada, thread.id), true, 'the starter follows it');
    assert.equal(await follows(ben, thread.id), false, 'someone who never wrote in it does not');
    await reply(ben, thread.id, 'Ben writes here');
    assert.equal(await follows(ben, thread.id), true, 'a writer follows it');

    assert.deepEqual(await setFollow(ada, thread.id, false), { conversationId: thread.id, following: false });
    assert.equal(await follows(ada, thread.id), false, 'the choice persists');
    const quiet = await reply(ben, thread.id, 'Ada will not hear this reply');
    const named = await reply(ben, thread.id, '@Ada Quill the ferry leaves at nine');
    assert.equal((await waitForItem(ada, (item) => item.url?.endsWith(named.id) === true, 'the mention in the unfollowed thread')).reason, 'mention');
    await generatorCaughtUp();
    assert.equal(await arrived(ada, quiet.id), undefined, 'an unfollowed thread sends no reply notice');
    assert.equal(await follows(ada, thread.id), false, 'a mention does not make her follow it again');

    await setFollow(ada, thread.id, true);
    const back = await reply(ben, thread.id, 'Now Ada hears it again');
    assert.equal((await waitForItem(ada, (item) => item.url?.endsWith(back.id) === true, 'the reply after following')).reason, 'reply');

    // Someone who never wrote in it chooses Follow and gets its replies.
    await setFollow(cy, thread.id, true);
    const forCy = await reply(ada, thread.id, 'Cyra follows this one');
    assert.equal((await waitForItem(cy, (item) => item.url?.endsWith(forCy.id) === true, 'the reply to a follower')).reason, 'reply');
    await setFollow(cy, thread.id, false);
    const notCy = await reply(ada, thread.id, 'Cyra stopped following');
    await generatorCaughtUp();
    assert.equal(await arrived(cy, notCy.id), undefined);
  });

  test('being mentioned in a thread follows it', async () => {
    const thread = await conversation(ada, projectId, '@Ben Oduya the survey boat is ready');
    await waitForItem(ben, (item) => item.url?.endsWith(thread.messages[0]!.id) === true, 'Ben\'s mention');
    assert.equal(await waitFor(async () => (await follows(ben, thread.id)) || null, 'Ben to follow the thread he was mentioned in'), true);
    const next = await reply(ada, thread.id, 'The boat leaves at ten');
    assert.equal((await waitForItem(ben, (item) => item.url?.endsWith(next.id) === true, 'a reply in the thread he follows')).reason, 'reply');
    // A person who chose before keeps their choice: a mention does not turn Unfollow back into Follow.
    await setFollow(ben, thread.id, false);
    const mention = await reply(ada, thread.id, '@Ben Oduya one more thing about the boat');
    await waitForItem(ben, (item) => item.url?.endsWith(mention.id) === true, 'the second mention');
    assert.equal(await follows(ben, thread.id), false);
  });

  test('a thread of a space someone cannot read, and a bad request, are refused without telling', async () => {
    const hidden = await project(ada, workspaceId, 'Private logbook', 'restricted');
    const thread = await conversation(ada, hidden.id, 'Only Ada reads this');
    for (const request of [() => ben.browser.request('GET', notificationFollowPath(thread.id)), () => ben.browser.request('PUT', NOTIFICATION_FOLLOWS_PATH, { body: { conversationId: thread.id, following: true } })]) {
      assert.equal((await request()).status, 404);
    }
    assert.equal((await ben.browser.request('PUT', NOTIFICATION_MUTES_PATH, { body: { type: 'project', id: hidden.id, muted: true } })).status, 404, 'nor can it be muted');
    assert.equal((await ada.browser.request('GET', notificationFollowPath(randomUUID()))).status, 404, 'a thread that does not exist');
    assert.equal((await ada.browser.request('PUT', NOTIFICATION_FOLLOWS_PATH, { body: { conversationId: 'nope', following: true } })).status, 400);
    assert.equal((await ada.browser.request('PUT', NOTIFICATION_FOLLOWS_PATH, { body: { conversationId: thread.id, following: 'yes' } })).status, 400);
    assert.equal((await ada.browser.request('GET', notificationFollowPath(thread.id))).status, 200);
  });

  test('a mute and a follow persist, and reach the person\'s other open tabs through the stream, and nobody else\'s', async () => {
    const tab = await secondSession(cy);
    const mine = await StreamClient.connect(tab.browser);
    const theirs = await StreamClient.connect(ben.browser);
    try {
      await mine.ready();
      await theirs.ready();
      const thread = await conversation(cy, projectId, 'Cyra\'s thread for the live tabs');
      await setMute(cy, 'project', projectId, true);
      const muteEvent = await mine.event(projectId, PROJECT_NOTIFICATIONS_CHANGED_EVENT);
      assert.equal(muteEvent.objectType, 'project');
      // The other tab reads what changed through the API; nothing in the event is content.
      assert.deepEqual(Object.keys(muteEvent).sort(), ['createdAt', 'cursor', 'id', 'kind', 'objectId', 'objectType', 'type', 'workspaceId']);
      assert.deepEqual(((expectStatus(await tab.browser.request('GET', NOTIFICATION_MUTES_PATH), 200)) as MutedPlacesResponse).muted, [{ type: 'project', id: projectId }]);

      const before = mine.events.filter((event) => event.kind === PROJECT_NOTIFICATIONS_CHANGED_EVENT).length;
      await setFollow(cy, thread.id, false);
      await mine.until(() => mine.events.filter((event) => event.kind === PROJECT_NOTIFICATIONS_CHANGED_EVENT).length > before, 8000, 'the follow event');
      assert.equal(await follows({ ...cy, browser: tab.browser }, thread.id), false, 'the other tab reads the follow');

      const dmId = await openDm(ada, workspaceId, cy);
      await setMute(cy, 'dm', dmId, true);
      assert.equal((await mine.event(dmId, DM_NOTIFICATIONS_CHANGED_EVENT)).objectType, 'dm');

      // Persisted: a brand new session of the same person sees both.
      const fresh = await signIn(cy.email, password);
      const freshCy = { ...cy, browser: fresh.browser };
      const list = (expectStatus(await fresh.browser.request('GET', NOTIFICATION_MUTES_PATH), 200) as MutedPlacesResponse).muted;
      assert.ok(list.some((place) => place.type === 'project' && place.id === projectId) && list.some((place) => place.type === 'dm' && place.id === dmId));
      assert.equal(await follows(freshCy, thread.id), false);

      await sleep(500);
      assert.equal(theirs.events.some((event) => event.kind === PROJECT_NOTIFICATIONS_CHANGED_EVENT || event.kind === DM_NOTIFICATIONS_CHANGED_EVENT), false, 'nobody else\'s stream carries it');
      await setMute(cy, 'project', projectId, false);
      await setMute(cy, 'dm', dmId, false);
    } finally {
      await mine.close();
      await theirs.close();
    }
  });
});
