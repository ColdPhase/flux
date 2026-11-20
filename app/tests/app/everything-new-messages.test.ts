import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { NOTIFICATION_PREFERENCES_PATH, NOTIFICATION_MUTES_PATH, type InboxResponse, type NeedsYouResponse, NEEDS_YOU_PATH } from '@flux/contracts';
import {
  DEFAULT_PREFERENCES, candidatesFor, generateNotifications, hiddenNotificationTitle, preferenceRepository,
  type GeneratedNotification, type GeneratorEvent, type GeneratorPorts, type NotificationFacts, type ProjectMessageFacts, type StoredPreferences,
} from '@flux/core';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';
import { recordedPushes, subscribe, waitFor } from './support/push.js';

// At Everything, every new message in a space you are in notifies you (C-65, #1550): reason `message`, push and the open tab's notice, never an
// Inbox item and never an email. The founder had Everything on and heard nothing when someone wrote in a space he is in: a new top-level
// message starts its own conversation, which nobody follows yet, and only a name or a followed thread made a candidate.

const workspaceId = randomUUID();
const projectId = randomUUID();
const conversationId = randomUUID();
const names = new Map([['ada', 'Ada Quill'], ['kai', 'Kai Berg'], ['lee', 'Lee Moreno'], ['max', 'Max Rowe']]);

function message(over: Partial<ProjectMessageFacts> = {}): ProjectMessageFacts {
  return {
    id: randomUUID(), workspaceId, projectId, projectName: 'Tool library', conversationId, opening: 'Who has the planer?',
    conversationCreatedBy: { kind: 'human', id: 'ada' }, author: { kind: 'human', id: 'ada' }, authorName: null, body: 'The new rack is up',
    sequence: 1, earlierAuthors: [], ...over,
  };
}

function facts(read: ProjectMessageFacts, audience: string[], everything?: string[]): NotificationFacts {
  return {
    audience: async () => audience, projectMessage: async () => read, dmMessage: async () => null, work: async () => null, decision: async () => null,
    liveInvitation: async () => null, liveSession: async () => null, waitingChange: async () => null,
    names: async (ids) => new Map(ids.flatMap((id) => (names.has(id) ? [[id, names.get(id)!] as const] : []))),
    ...(everything ? { everythingLevel: async (ids: string[]) => new Set(ids.filter((id) => everything.includes(id))) } : {}),
  };
}

const event = (kind: 'project.conversation_created.v1' | 'project.message_sent.v1', read: ProjectMessageFacts): GeneratorEvent =>
  ({ id: randomUUID(), seq: 1, kind, workspaceId, objectId: projectId, actorId: 'human:ada', data: { messageId: read.id } });

describe('who a new message in a space is for (C-65)', () => {
  test('everyone the space\'s message reached but its author gets a `message`; a name keeps its own, more specific reason, so nobody is told twice', async () => {
    const read = message({ body: '@Lee Moreno the rack is up' });
    const found = await candidatesFor(event('project.conversation_created.v1', read), facts(read, ['ada', 'kai', 'lee', 'max']));
    const reasons = Object.fromEntries(found.map((one) => [one.userId, one.reason]));
    // Lee is named (a mention); Kai and Max are no more involved than anyone: a message. Never Ada, the author.
    assert.deepEqual(reasons, { kai: 'message', lee: 'mention', max: 'message' });
    assert.equal(found.length, 3, 'one notification per person');
  });

  test('a new top-level message starts a conversation nobody follows: it notifies the others as a message, in the words "Ada wrote in Tool library"', async () => {
    const read = message();
    const found = await candidatesFor(event('project.conversation_created.v1', read), facts(read, ['ada', 'kai', 'lee']));
    assert.deepEqual(found.map((one) => [one.userId, one.reason]).sort(), [['kai', 'message'], ['lee', 'message']]);
    const one = found[0]!;
    assert.equal(one.title, 'Ada Quill wrote in Tool library');
    assert.equal(one.body, 'The new rack is up');
    assert.equal(one.url, `/projects/${projectId}/conversations/${conversationId}#message-${read.id}`);
    assert.equal(one.where, 'Tool library');
    assert.equal(one.thread, undefined, 'a message does not make a person follow its thread');
    // "Hide previews" and an encrypted space's notice say it in the same fixed words, with no text of the message.
    assert.equal(hiddenNotificationTitle('message', 'Ada Quill', 'Tool library'), 'Ada Quill wrote in Tool library');
    assert.equal(hiddenNotificationTitle('message', 'Ada Quill', ''), 'Ada Quill wrote');
  });

  test('a reply is its thread\'s: those who follow it hear a reply as before, and nobody else is told, at any level', async () => {
    const read = message({ sequence: 3, body: 'It is on the second shelf', earlierAuthors: ['max'] });
    const found = await candidatesFor(event('project.message_sent.v1', read), facts(read, ['ada', 'kai', 'lee', 'max'], ['kai', 'lee', 'max']));
    assert.deepEqual(found.map((one) => [one.userId, one.reason, one.title]), [['max', 'reply', 'Ada Quill replied in “Who has the planer?”']]);
  });

  test('the discussion of a decision or of a task is on its card, not a message of the space\'s stream', async () => {
    const decision = message({ decision: { title: 'Use a ToF sensor', askee: 'ada' } });
    assert.deepEqual(await candidatesFor(event('project.conversation_created.v1', decision), facts(decision, ['ada', 'kai'])), []);
    const task = message({ inTask: true });
    assert.deepEqual(await candidatesFor(event('project.conversation_created.v1', task), facts(task, ['ada', 'kai'])), []);
  });

  test('only people at Everything are candidates when the store says who they are (one read for the whole audience); without it every person is, and the level decides later', async () => {
    const read = message();
    const audience = ['ada', 'kai', 'lee', 'max'];
    assert.deepEqual((await candidatesFor(event('project.conversation_created.v1', read), facts(read, audience, ['lee']))).map((one) => one.userId), ['lee']);
    assert.deepEqual((await candidatesFor(event('project.conversation_created.v1', read), facts(read, audience, []))).map((one) => one.userId), []);
    assert.equal((await candidatesFor(event('project.conversation_created.v1', read), facts(read, audience))).length, 3);
    // A person asked or named is never dropped by their level: those reasons are Only what needs me's.
    const asked = message({ body: '@Kai Berg where is the planer?' });
    assert.deepEqual((await candidatesFor(event('project.conversation_created.v1', asked), facts(asked, audience, []))).map((one) => [one.userId, one.reason]), [['kai', 'question']]);
  });

  test('a server agent\'s line that is for its owner alone notifies nobody else, and an agent question card asks exactly one person', async () => {
    const line = message({ onlyNotifies: 'kai', author: { kind: 'agent', id: randomUUID() }, authorName: 'Planner' });
    assert.deepEqual((await candidatesFor(event('project.conversation_created.v1', line), facts(line, ['ada', 'kai', 'lee']))).map((one) => one.userId), ['kai']);
    const card = message({ asked: { userId: 'lee', question: 'Which shelf?' }, author: { kind: 'agent', id: randomUUID() }, authorName: 'Planner' });
    assert.deepEqual((await candidatesFor(event('project.conversation_created.v1', card), facts(card, ['ada', 'kai', 'lee']))).map((one) => [one.userId, one.reason]), [['lee', 'question']]);
  });
});

describe('what a message does at each level (core, in memory)', () => {
  /** Runs the generator on one top-level message to Kai with his preferences; returns what was stored, pushed and mailed. */
  async function run(preferences: StoredPreferences, options: { muted?: boolean; now?: Date } = {}) {
    const read = message();
    const stored: GeneratedNotification[] = [];
    const counts = { pushes: 0, emails: 0, notices: 0 };
    const ports: GeneratorPorts = {
      lockCursor: async () => 0, advanceCursor: async () => undefined,
      eventsAfter: async (seq) => (seq ? [] : [event('project.conversation_created.v1', read)]),
      facts: facts(read, ['ada', 'kai']),
      preferences: preferenceRepository({ find: async () => preferences, save: async () => undefined, isMuted: async () => options.muted === true, mutes: async () => [], setMuted: async () => undefined }),
      authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId }) },
      insertNotification: async (note) => { stored.push(note); return true; },
      deliverableSubscriptions: async () => ['phone'], emailedRecently: async () => false, insertEmails: async () => [randomUUID()],
      enqueuePush: async () => { counts.pushes++; return null; }, enqueueEmail: async () => { counts.emails++; return null; },
      announceNotices: async (notices) => { counts.notices += notices.length; },
      recordFailure: async () => 1, deadLetter: async () => undefined, isolate: (work) => work(),
    };
    await generateNotifications({ run: (work) => work(ports) }, { emailAvailable: true, now: () => options.now ?? new Date('2026-11-19T12:00:00Z') });
    return { stored, counts };
  }
  const everything = { ...DEFAULT_PREFERENCES, level: 'everything' as const };

  test('at Everything: a push and a notice, kept out of the Inbox and never emailed, even with Email me too on', async () => {
    const { stored, counts } = await run(everything);
    assert.deepEqual(stored.map((note) => [note.userId, note.reason, note.inInbox]), [['kai', 'message', false]]);
    assert.deepEqual(counts, { pushes: 1, emails: 0, notices: 1 });
  });

  test('at Only what needs me and at Nothing a message makes nothing: no row, no push', async () => {
    for (const level of ['needsYou', 'nothing'] as const) {
      const { stored, counts } = await run({ ...DEFAULT_PREFERENCES, level });
      assert.deepEqual([stored.length, counts], [0, { pushes: 0, emails: 0, notices: 0 }], level);
    }
  });

  test('a muted space is quiet for it, and quiet hours hold the push and the notice (a message is no needs-you reason, so nothing reaches a muted place)', async () => {
    assert.deepEqual((await run(everything, { muted: true })).stored, []);
    const quiet = await run({ ...everything, quietEnabled: true, quietStart: 1, quietEnd: 0, timeZone: 'UTC' });
    assert.deepEqual(quiet.counts, { pushes: 0, emails: 0, notices: 0 }, 'quiet hours: no push, no notice');
  });

  test('"Hide previews" keeps its fixed words for a push (the stored title is the full one)', async () => {
    const { stored } = await run({ ...everything, hidePreviews: true });
    assert.equal(stored[0]!.title, 'Ada Quill wrote in Tool library');
  });
});

describe('a new message at Everything, through the running application (#1550)', () => {
  let ada: Person;
  let bea: Person;
  let cy: Person;
  let space: string;

  async function write(who: Person, body: string, into = space) {
    return expectStatus(await who.browser.request('POST', `/api/v1/projects/${into}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string; messages: { id: string }[] };
  }
  const level = async (who: Person, value: 'needsYou' | 'everything' | 'nothing') =>
    expectStatus(await who.browser.request('PATCH', NOTIFICATION_PREFERENCES_PATH, { body: { level: value } }), 200);
  const notes = async (who: Person) => (await pool.query(`SELECT id, reason, title, url, in_inbox FROM notifications WHERE user_id = $1 ORDER BY created_at`, [who.id])).rows as
    { id: string; reason: string; title: string; url: string; in_inbox: boolean }[];
  const noteFor = async (who: Person, messageId: string) => (await notes(who)).find((row) => row.url.endsWith(messageId));
  /** Waits until the generator has passed every event committed so far, so "nothing arrived" is a fact and not a race. */
  async function caughtUp() {
    const { rows } = await pool.query('SELECT max(seq) AS seq FROM events');
    const target = Number(rows[0].seq);
    await waitFor(async () => Number((await pool.query("SELECT seq FROM notification_cursor WHERE id = 'generator'")).rows[0].seq) >= target || null, 'the generator to catch up');
  }

  before(async () => {
    ada = await person('Ada Everything');
    bea = await person('Bea Everything');
    cy = await person('Cyra Everything');
    const company = await workspace(ada, 'Everything workshop');
    await addMember(ada, company.id, bea, 'member');
    await addMember(ada, company.id, cy, 'member');
    space = (await project(ada, company.id, 'Tool library', 'workspace')).id;
  });

  test('Bea at Everything is pushed Ada\'s new message in the space; it is no Inbox item, no email and not on Home; Cyra at the default is told nothing', async () => {
    await level(bea, 'everything');
    const { subscription } = await subscribe(bea.browser);
    const pushes = async () => (await recordedPushes(subscription.mockId)).length;
    const made = await write(ada, 'The new rack is up in the workshop');
    const note = await waitFor(async () => (await noteFor(bea, made.messages[0]!.id)) ?? null, 'Bea\'s notification of the message');
    assert.deepEqual({ reason: note.reason, title: note.title, in_inbox: note.in_inbox }, { reason: 'message', title: 'Ada Everything wrote in Tool library', in_inbox: false });
    await waitFor(async () => (await pushes()) === 1 || null, 'the push of the message');
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM notification_emails WHERE notification_id = $1', [note.id])).rows[0].n), 0, 'a message is never emailed');
    const inbox = expectStatus(await bea.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse;
    assert.equal(inbox.items.some((item) => item.url?.endsWith(made.messages[0]!.id)), false, 'nothing in the Inbox');
    const needs = expectStatus(await bea.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
    assert.equal(needs.items.some((item) => item.url?.endsWith(made.messages[0]!.id)), false, 'nor in what waits for her');
    assert.equal(needs.notifying, 0, 'and the tab does not count it');
    await caughtUp();
    assert.equal(await noteFor(cy, made.messages[0]!.id), undefined, 'at Only what needs me nothing is made');
    assert.equal(await noteFor(ada, made.messages[0]!.id), undefined, 'the author is not told of their own message');
  });

  test('a message that names her is a mention, once; a reply in a thread she does not follow is not told; muting the space silences a plain message', async () => {
    const named = await write(ada, '@Bea Everything come and look at the rack');
    const mention = await waitFor(async () => (await noteFor(bea, named.messages[0]!.id)) ?? null, 'the mention');
    assert.equal(mention.reason, 'mention');
    assert.equal((await notes(bea)).filter((row) => row.url.endsWith(named.messages[0]!.id)).length, 1, 'one notification for the message');

    // The thread's first message is a new message in the space for her; a reply in it is its followers' (Ada's), never hers.
    const thread = await write(ada, 'A thread Bea has not joined');
    assert.equal((await waitFor(async () => (await noteFor(bea, thread.messages[0]!.id)) ?? null, 'the thread\'s first message')).reason, 'message');
    const more = expectStatus(await ada.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: { body: 'More about the rack', clientMessageId: randomUUID() } }), 201) as { id: string };
    await caughtUp();
    assert.equal(await noteFor(bea, more.id), undefined, 'a reply in a thread she does not follow tells her nothing');

    expectStatus(await bea.browser.request('PUT', NOTIFICATION_MUTES_PATH, { body: { type: 'project', id: space, muted: true } }), 200);
    const quiet = await write(ada, 'Another plain message while she has muted the space');
    await caughtUp();
    assert.equal(await noteFor(bea, quiet.messages[0]!.id), undefined, 'a muted space is quiet for a plain message');
    expectStatus(await bea.browser.request('PUT', NOTIFICATION_MUTES_PATH, { body: { type: 'project', id: space, muted: false } }), 200);
    const back = await write(ada, 'And now it is unmuted');
    assert.equal((await waitFor(async () => (await noteFor(bea, back.messages[0]!.id)) ?? null, 'the message after unmuting')).reason, 'message');
  });

  test('Bea leaves Everything: the next message makes nothing for her', async () => {
    await level(bea, 'needsYou');
    const after = await write(ada, 'Said while Bea is at Only what needs me');
    await caughtUp();
    assert.equal(await noteFor(bea, after.messages[0]!.id), undefined);
  });
});
