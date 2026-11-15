import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, Decision, InboxResponse, Material, NeedsYouItem, NeedsYouResponse, Project, SentConversationMessage, SentDmMessage, Workspace, WorkItem } from '@flux/contracts';
import type { ClientResponse } from './support/http.js';
import { register } from './support/http.js';
import { addMember, expectStatus, grant, password, person, project as createProject, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// The Inbox "Needs you" queue (#342): what asks something of a person is computed from current rows and
// the access policy; only what the person did with an item is stored. One person accepts a decision
// (O-009 DA-2), so the queue shows who can still accept; there is no un-accept, so Undo is the client's.

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const queue = async (someone: Person) => json<NeedsYouResponse>(await someone.browser.request('GET', '/api/v1/needs-you'), 200);
const resolve = (someone: Person, key: string, body: unknown) => post(someone, `/api/v1/needs-you/${encodeURIComponent(key)}`, body);
const restore = (someone: Person, key: string) => someone.browser.request('DELETE', `/api/v1/needs-you/${encodeURIComponent(key)}`);
const find = (response: NeedsYouResponse, key: string): NeedsYouItem | undefined => response.items.find((item) => item.key === key);
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function named(name: string): Promise<Person> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}@example.test`;
  const { browser } = await register(email, password, name);
  const me = json<{ user: { id: string } }>(await browser.request('GET', '/api/v1/me'), 200);
  return { id: me.user.id, email, browser };
}

describe('the Inbox needs-you queue', () => {
  let owner: Person;
  let partner: Person;
  let outsider: Person;
  let second: Person;
  let ws: Workspace;
  let lamp: Project;
  let conversation: Conversation;
  let material: Material;

  before(async () => {
    owner = await named('Needs Owner');
    [partner, outsider, second] = await Promise.all(['ny-partner', 'ny-outsider', 'ny-second'].map(person));
    ws = await workspace(owner, 'Garden space');
    for (const someone of [partner, outsider, second]) await addMember(owner, ws.id, someone, 'member');
    lamp = await createProject(owner, ws.id, 'Garden sensors', 'restricted');
    await grant(owner, lamp.id, partner, 'contributor');
    await grant(owner, lamp.id, second, 'contributor');
    conversation = json<Conversation>(await post(owner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: 'Measure soil moisture or frost first?', clientMessageId: randomUUID() }), 201);
    material = json<Material>(await post(owner, `/api/v1/projects/${lamp.id}/materials`,
      { clientMutationId: randomUUID(), title: 'Probe notes', body: 'Overwatering is the problem now' }), 201);
  });

  test('a proposed decision needs the people who can accept it, and only them', async () => {
    const probes = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Calibrate the probes' }), 201);
    const proposed = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, {
      title: 'Measure soil moisture first', rationale: 'Overwatering is the problem now; frost only matters in spring.',
      affects: [probes.id], sources: [{ type: 'message', id: conversation.messages[0]!.id }, { type: 'material', id: material.materialId, version: 1 }],
    }), 201);
    const key = `decision:${proposed.id}`;

    const mine = find(await queue(owner), key);
    assert.ok(mine, 'a manager can accept it');
    assert.equal(mine.kind, 'decision');
    assert.equal(mine.title, 'Measure soil moisture first');
    // The same place as Search, a notification and its card: over the space's conversation (contracts `decisionAppPath`).
    assert.equal(mine.url, `/projects/${lamp.id}?open=decision:${proposed.id}`);
    assert.deepEqual(mine.project, { id: lamp.id, name: 'Garden sensors' });
    assert.equal(mine.decision?.canAccept, true);
    assert.deepEqual(mine.decision?.proposedBy, { kind: 'human', id: partner.id, name: 'ny-partner' });
    assert.equal(mine.decision?.basedOn.length, 2, 'what it is based on');
    assert.deepEqual(mine.decision?.affects.map((task) => task.id), [probes.id]);
    assert.equal(mine.snoozeTask?.id, probes.id, '"when #N is done" waits for the task it affects');
    // One person accepts: the card names who still can, you first.
    const names = mine.decision!.accepters.map((person) => [person.name, person.you]);
    assert.deepEqual(names[0], ['Needs Owner', true]);
    assert.ok(names.some(([name]) => name === 'ny-partner'));

    // The contributor who proposed it can accept it too (DA-2), but is not asked to while someone else can (#763 FT-8);
    // a member without access and a stranger are never asked.
    assert.equal(find(await queue(partner), key), undefined, 'your own proposal waits for someone else');
    assert.equal(find(await queue(outsider), key), undefined);

    // Accepting leaves everyone's queue.
    json(await post(owner, `/api/v1/decisions/${proposed.id}/accept`, {}, { 'if-match': '"1"' }), 200);
    assert.equal(find(await queue(owner), key), undefined);
    assert.equal(find(await queue(partner), key), undefined);
  });

  test('Done, Not now and Decline are per person, and Undo brings the item back', async () => {
    const task = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Order six capacitive probes' }), 201);
    const proposed = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Buy probes in bulk', affects: [task.id] }), 201);
    const key = `decision:${proposed.id}`;

    json(await resolve(owner, key, { action: 'done' }), 200);
    assert.equal(find(await queue(owner), key), undefined, 'done leaves your queue');
    assert.ok(find(await queue(second), key), 'and nobody else\'s');
    assert.equal((await restore(owner, key)).status, 204);
    assert.ok(find(await queue(owner), key), 'Undo restores it');
    assert.equal((await restore(owner, key)).status, 204, 'undoing twice changes nothing');

    // Not now: at a time.
    const later = json<{ state: string; until: string }>(await resolve(owner, key, { action: 'snooze', until: inHours(20) }), 200);
    assert.equal(later.state, 'snoozed');
    const hidden = await queue(owner);
    assert.equal(find(hidden, key), undefined);
    assert.equal(hidden.later, 1, 'what is put off can be counted');
    assert.equal(hidden.count, hidden.items.length);
    await restore(owner, key);

    // Not now: until the task is done.
    assert.equal((await resolve(owner, key, { action: 'snooze', untilWorkId: randomUUID() })).status, 400, 'only the item\'s own task');
    json(await resolve(owner, key, { action: 'snooze', untilWorkId: task.id }), 200);
    assert.equal(find(await queue(owner), key), undefined);
    json(await patch(owner, `/api/v1/work/${task.id}`, { status: 'in_progress', expectedVersion: task.version }), 200);
    assert.equal(find(await queue(owner), key), undefined, 'still waiting while it is only in progress');
    const started = json<WorkItem>(await owner.browser.request('GET', `/api/v1/work/${task.id}`), 200);
    json(await patch(owner, `/api/v1/work/${task.id}`, { status: 'done', expectedVersion: started.version }), 200);
    assert.ok(find(await queue(owner), key), 'it returns when the task is done');

    // Out-of-range or malformed choices are refused and change nothing.
    for (const body of [{ action: 'snooze', until: inHours(-1) }, { action: 'snooze', until: inHours(24 * 90) }, { action: 'snooze' },
      { action: 'snooze', until: inHours(5), untilWorkId: task.id }, { action: 'done', until: inHours(5) }, { action: 'later' }]) {
      assert.equal((await resolve(owner, key, body)).status, 400, JSON.stringify(body));
    }
    assert.ok(find(await queue(owner), key));

    // Decline for good removes it for you only; the decision stays proposed.
    json(await resolve(owner, key, { action: 'decline' }), 200);
    assert.equal(find(await queue(owner), key), undefined);
    assert.ok(find(await queue(second), key));
    assert.equal(json<Decision>(await owner.browser.request('GET', `/api/v1/decisions/${proposed.id}`), 200).status, 'proposed');
  });

  test('items someone cannot read answer like items that do not exist', async () => {
    const proposed = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Private to the garden' }), 201);
    const key = `decision:${proposed.id}`;
    assert.equal((await resolve(outsider, key, { action: 'done' })).status, 404);
    assert.equal((await resolve(owner, 'decision:not-a-key', { action: 'done' })).status, 404);
    assert.equal((await resolve(owner, `decision:${randomUUID()}`, { action: 'done' })).status, 404);
    assert.equal((await restore(outsider, key)).status, 204, 'restoring touches only your own choice');
    assert.equal((await outsider.browser.request('GET', '/api/v1/needs-you', { headers: {} })).status, 200);
  });

  test('your blocked tasks need you until they are unblocked', async () => {
    const blocked = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, {
      title: 'Design the enclosure', owner: { kind: 'human', id: owner.id }, status: 'blocked', blocker: 'Waiting for the probe dimensions',
    }), 201);
    const key = `blocked:${blocked.id}`;
    const item = find(await queue(owner), key);
    assert.ok(item);
    assert.equal(item.kind, 'blocked');
    assert.equal(item.blocked?.number, blocked.number);
    assert.equal(item.blocked?.blocker, 'Waiting for the probe dimensions');
    assert.equal(item.blocked?.version, blocked.version);
    assert.equal(find(await queue(partner), key), undefined, 'a blocked task is the owner\'s need');

    json(await patch(owner, `/api/v1/work/${blocked.id}`, { status: 'in_progress', blocker: null, expectedVersion: blocked.version }), 200);
    assert.equal(find(await queue(owner), key), undefined);
  });

  test('a mention is a need until it is done, and Done is also read', async () => {
    const asker = partner;
    const question = json<Conversation>(await post(asker, `/api/v1/projects/${lamp.id}/conversations`,
      { body: '@Needs Owner can you check the shed roof?', clientMessageId: randomUUID() }), 201);
    const note = await waitFor(async () => (await queue(owner)).items.find((item) => item.url.includes(question.id)), 'the question reaches the queue');
    assert.equal(note.kind, 'question');
    assert.ok(note.key.startsWith('note:'));
    // Who and where, like every other kind, so the Inbox row is "Question · who · space" and then what was asked (#1424); the notification keeps its sentence.
    assert.deepEqual([note.from?.kind, note.from?.id, note.project, note.title, note.detail], ['human', asker.id, { id: lamp.id, name: 'Garden sensors' }, '@Needs Owner can you check the shed roof?', '']);
    assert.ok(note.from?.name && note.from.name !== 'Someone', 'it names the person');
    assert.ok(json<InboxResponse>(await owner.browser.request('GET', '/api/v1/inbox'), 200).items.find((item) => item.id === note.key.slice(5))?.title.endsWith(' asked you in Garden sensors'));

    json(await resolve(owner, note.key, { action: 'done' }), 200);
    assert.equal(find(await queue(owner), note.key), undefined);
    const inbox = json<InboxResponse>(await owner.browser.request('GET', '/api/v1/inbox'), 200);
    assert.ok(inbox.items.find((item) => item.id === note.key.slice(5))?.readAt, 'Done also reads the notification');
    await restore(owner, note.key);
    assert.ok(find(await queue(owner), note.key));
    assert.equal(json<InboxResponse>(await owner.browser.request('GET', '/api/v1/inbox'), 200).items.find((item) => item.id === note.key.slice(5))?.readAt, null);
  });

  test('a reply where someone asked or mentioned you answers it: it leaves the Inbox as Done takes it, and Undo brings it back (#1170)', async () => {
    const asked = json<Conversation>(await post(partner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: '@Needs Owner is the readings sheet shared already?', clientMessageId: randomUUID() }), 201);
    json(await post(partner, `/api/v1/conversations/${asked.id}/messages`, { body: '@Needs Owner the old sheet is in the shed folder.', clientMessageId: randomUUID() }), 201);
    const elsewhere = json<Conversation>(await post(partner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: '@Needs Owner can you water the far beds tomorrow?', clientMessageId: randomUUID() }), 201);
    const inThread = (response: NeedsYouResponse) => response.items.filter((item) => item.url.includes(asked.id));
    const waiting = await waitFor(async () => {
      const current = await queue(owner);
      const there = current.items.find((item) => item.url.includes(elsewhere.id));
      return inThread(current).length === 2 && there ? { here: inThread(current), there } : undefined;
    }, 'the question, the mention and the question elsewhere reach the queue');
    assert.deepEqual(waiting.here.map((item) => item.kind).sort(), ['mention', 'question']);
    // One list for every kind, newest first (README §7 Inbox, founder decision 2026-11-13, #1367): a decision never sits above a newer question.
    const all = (await queue(owner)).items;
    assert.ok(all.length >= 3 && new Set(all.map((item) => item.kind)).size >= 2, 'several kinds wait');
    assert.deepEqual(all.map((item) => item.at), [...all.map((item) => item.at)].sort().reverse(), 'newest first');
    const keys = waiting.here.map((item) => item.key).sort();
    const readAt = async (key: string) => json<InboxResponse>(await owner.browser.request('GET', '/api/v1/inbox'), 200).items.find((item) => item.id === key.slice(5))?.readAt;

    // Opening the thread answers nothing, and neither does someone else's reply in it.
    json(await owner.browser.request('GET', `/api/v1/conversations/${asked.id}`), 200);
    const other = json<SentConversationMessage>(await post(second, `/api/v1/conversations/${asked.id}/messages`, { body: 'I think it is.', clientMessageId: randomUUID() }), 201);
    assert.equal(other.answered, undefined, 'their reply answered nothing of theirs');
    assert.equal(inThread(await queue(owner)).length, 2, 'what was asked still waits for the owner');

    // The owner's reply in the thread answers both, and only what waits there.
    const command = { body: 'Yes, it is shared in the Wiki.', clientMessageId: randomUUID() };
    const sent = json<SentConversationMessage>(await post(owner, `/api/v1/conversations/${asked.id}/messages`, command), 201);
    assert.deepEqual([...(sent.answered ?? [])].sort(), keys, 'the reply names what it answered');
    const after = await queue(owner);
    assert.equal(inThread(after).length, 0, 'the answered question and mention left the Inbox');
    assert.equal(after.count, after.items.length);
    assert.ok(find(after, waiting.there.key), 'a question in another conversation still waits');
    for (const key of keys) assert.ok(await readAt(key), 'answering reads the notification, as Done does');
    // Sending the same reply again (a retry) answers nothing more.
    assert.equal(json<SentConversationMessage>(await post(owner, `/api/v1/conversations/${asked.id}/messages`, command), 201).answered, undefined);

    // Undo is Done's: each comes back, unread.
    for (const key of keys) assert.equal((await restore(owner, key)).status, 204);
    assert.deepEqual(inThread(await queue(owner)).map((item) => item.key).sort(), keys, 'Undo brings both back');
    for (const key of keys) assert.equal(await readAt(key), null);
    for (const key of [...keys, waiting.there.key]) json(await resolve(owner, key, { action: 'done' }), 200);
  });

  test('a reply in a direct message that names you answers it as in a space thread: it leaves the Inbox as Done takes it, and Undo brings it back (#1249)', async () => {
    const openDm = async (from: Person, to: Person) => {
      const created = await post(from, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [to.id] });
      assert.ok(created.status === 200 || created.status === 201, created.text);
      return (created.json as { id: string }).id;
    };
    const dm = await openDm(partner, owner);
    const elsewhere = await openDm(second, owner);
    const say = (from: Person, id: string, body: string) => post(from, `/api/v1/dms/${id}/messages`, { body, clientMessageId: randomUUID() });
    json(await say(partner, dm, 'Needs Owner, can you check the invoice for the probes?'), 201);
    json(await say(partner, dm, '@Needs Owner the totals are on the second page'), 201);
    json(await say(partner, dm, 'No rush on any of it'), 201);
    json(await say(second, elsewhere, '@Needs Owner can you bring the ladder tomorrow?'), 201);
    const inDm = (response: NeedsYouResponse, id = dm) => response.items.filter((item) => item.url.startsWith(`/dm/${id}`));
    const waiting = await waitFor(async () => {
      const current = await queue(owner);
      return inDm(current).length === 2 && inDm(current, elsewhere).length === 1 ? current : undefined;
    }, 'the question and the mention of the DM reach the queue, and the question of the other DM');
    assert.deepEqual(inDm(waiting).map((item) => item.kind).sort(), ['mention', 'question'], 'a plain message of the DM is no need');
    // A message between two people has a sender and no space: its row is "Question · who" and then what was asked (#1424).
    for (const item of inDm(waiting)) assert.deepEqual([item.from?.id, item.project, item.title.includes('asked you') || item.title.includes('mentioned you')], [partner.id, null, false], item.title);
    const keys = inDm(waiting).map((item) => item.key).sort();

    // Opening the conversation answers nothing.
    json(await owner.browser.request('GET', `/api/v1/dms/${dm}`), 200);
    assert.equal(inDm(await queue(owner)).length, 2, 'before the reply: 2 wait');

    const command = { body: 'The totals look right to me.', clientMessageId: randomUUID() };
    const sent = json<SentDmMessage>(await post(owner, `/api/v1/dms/${dm}/messages`, command), 201);
    assert.deepEqual([...(sent.answered ?? [])].sort(), keys, 'the reply names what it answered');
    const after = await queue(owner);
    assert.equal(inDm(after).length, 0, 'after the reply: 0 wait');
    assert.equal(after.count, after.items.length);
    assert.equal(inDm(after, elsewhere).length, 1, 'a question in another DM still waits');
    // A retry answers nothing more, and a message from the person who asked answers nothing of the owner's.
    assert.equal(json<SentDmMessage>(await post(owner, `/api/v1/dms/${dm}/messages`, command), 201).answered, undefined);
    assert.equal(json<SentDmMessage>(await say(second, elsewhere, 'Thanks, tomorrow is fine'), 201).answered, undefined);

    // Undo is Done's: each comes back, unread.
    for (const key of keys) assert.equal((await restore(owner, key)).status, 204);
    assert.deepEqual(inDm(await queue(owner)).map((item) => item.key).sort(), keys, 'Undo brings both back');
    for (const key of [...keys, ...inDm(await queue(owner), elsewhere).map((item) => item.key)]) json(await resolve(owner, key, { action: 'done' }), 200);
  });

  test('a message in a task\'s discussion answers what was asked there, with the same Undo (#1170)', async () => {
    const task = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Seal the junction boxes' }), 201);
    const asked = json<{ conversationId: string }>(await post(partner, `/api/v1/work/${task.id}/discussion`,
      { body: '@Needs Owner which sealant did we order?', clientMessageId: randomUUID(), kind: 'text' }), 201);
    const note = await waitFor(async () => (await queue(owner)).items.find((item) => item.url.includes(asked.conversationId)), 'the question in the task reaches the queue');
    assert.equal(note.kind, 'question');
    const sent = json<SentConversationMessage>(await post(owner, `/api/v1/work/${task.id}/discussion`,
      { body: 'The grey silicone one, two tubes.', clientMessageId: randomUUID(), kind: 'text' }), 201);
    assert.deepEqual(sent.answered, [note.key]);
    assert.equal(find(await queue(owner), note.key), undefined, 'answered in the task, it left the Inbox');
    assert.equal((await restore(owner, note.key)).status, 204);
    assert.ok(find(await queue(owner), note.key), 'Undo brings it back');
    json(await resolve(owner, note.key, { action: 'done' }), 200);
  });

  test('an answer to your question reaches you: the reply lands in the asker\'s Inbox as a Reply, once (#1424 decision 1)', async () => {
    const inbox = async (someone: Person) => json<InboxResponse>(await someone.browser.request('GET', '/api/v1/inbox'), 200).items;
    const asked = json<Conversation>(await post(partner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: '@Needs Owner can you send a photo of the new shelf?', clientMessageId: randomUUID() }), 201);
    await waitFor(async () => (await queue(owner)).items.find((item) => item.url.includes(asked.id)), 'the question reaches the person asked');
    // The answer, from the Inbox's Reply, is a reply in the question's thread.
    const answer = json<SentConversationMessage>(await post(owner, `/api/v1/conversations/${asked.id}/messages`,
      { body: 'Here it is, the left side is done.', clientMessageId: randomUUID() }), 201);
    const item = await waitFor(async () => (await queue(partner)).items.find((entry) => entry.url.endsWith(`#message-${answer.id}`)), 'the answer reaches the asker\'s Inbox');
    assert.deepEqual([item.kind, item.answer, item.title, item.detail, item.from?.id, item.project], ['mention', true, 'Here it is, the left side is done.', '', owner.id, { id: lamp.id, name: 'Garden sensors' }],
      'a mention named a Reply, titled by what was answered, who and where');
    assert.ok(item.key.startsWith('note:'));
    const note = (await inbox(partner)).find((entry) => entry.id === item.key.slice(5));
    assert.deepEqual([note?.reason, note?.title], ['mention', 'Needs Owner answered you in Garden sensors'], 'the notice says it is an answer, at the asker\'s level as a mention');

    // Only the first message after the question answers it; a second line, and someone else's reply, are ordinary replies.
    const more = json<SentConversationMessage>(await post(owner, `/api/v1/conversations/${asked.id}/messages`, { body: 'The right side tomorrow.', clientMessageId: randomUUID() }), 201);
    const other = json<SentConversationMessage>(await post(second, `/api/v1/conversations/${asked.id}/messages`, { body: 'Looks good to me.', clientMessageId: randomUUID() }), 201);
    const replies = await waitFor(async () => {
      const notes = (await inbox(partner)).filter((entry) => entry.url?.endsWith(`#message-${more.id}`) || entry.url?.endsWith(`#message-${other.id}`));
      return notes.length === 2 ? notes : undefined;
    }, 'both later lines reach the asker as replies');
    assert.deepEqual(replies.map((entry) => entry.reason), ['reply', 'reply']);
    assert.equal((await queue(partner)).items.filter((entry) => entry.url.includes(asked.id)).length, 1, 'one Reply waits, not three');

    // A mention that asks nothing is not a question, so a reply to it tells nobody more than a reply does.
    const told = json<Conversation>(await post(partner, `/api/v1/projects/${lamp.id}/conversations`, { body: '@Needs Owner the hose is fixed.', clientMessageId: randomUUID() }), 201);
    const thanks = json<SentConversationMessage>(await post(owner, `/api/v1/conversations/${told.id}/messages`, { body: 'Great, thank you.', clientMessageId: randomUUID() }), 201);
    const plain = await waitFor(async () => (await inbox(partner)).find((entry) => entry.url?.endsWith(`#message-${thanks.id}`)), 'the reply reaches its starter');
    assert.equal(plain.reason, 'reply');
    assert.equal((await queue(partner)).items.some((entry) => entry.url.includes(told.id)), false, 'no Inbox item for a reply to a mention');

    // The asker's own reply in the thread answers the Reply: it leaves their Inbox, as any reply takes what waits there.
    const back = json<SentConversationMessage>(await post(partner, `/api/v1/conversations/${asked.id}/messages`, { body: 'Thanks, perfect.', clientMessageId: randomUUID() }), 201);
    assert.ok(back.answered?.includes(item.key), 'the asker\'s reply takes the Reply out');

    // The same in a direct message: the answer names nobody, and it reaches the asker's Inbox with no space.
    const created = await post(partner, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [owner.id] });
    const dm = (created.json as { id: string }).id;
    json(await post(partner, `/api/v1/dms/${dm}/messages`, { body: 'Needs Owner, did you keep the receipt for the probes?', clientMessageId: randomUUID() }), 201);
    const said = json<SentDmMessage>(await post(owner, `/api/v1/dms/${dm}/messages`, { body: 'Yes, it is in the blue folder.', clientMessageId: randomUUID() }), 201);
    const inDm = await waitFor(async () => (await queue(partner)).items.find((entry) => entry.url === `/dm/${dm}#message-${said.id}`), 'the answer in the DM reaches the asker\'s Inbox');
    assert.deepEqual([inDm.kind, inDm.answer, inDm.title, inDm.project, inDm.from?.id], ['mention', true, 'Yes, it is in the blue folder.', null, owner.id]);
    for (const key of [inDm.key]) json(await resolve(partner, key, { action: 'done' }), 200);
  });

  test('an answer reaches whoever asked it, by the detection that put the question in the answerer\'s Inbox, with no name in it (#1424 decision 1, personas-26 P2 #1)', async () => {
    const inbox = async (someone: Person) => json<InboxResponse>(await someone.browser.request('GET', '/api/v1/inbox'), 200).items;
    // The owner asks the partner by name; the partner answers and asks back without naming anyone.
    const thread = json<Conversation>(await post(owner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: 'ny-partner, can you start at 6:00 on Monday?', clientMessageId: randomUUID() }), 201);
    await waitFor(async () => (await queue(partner)).items.find((item) => item.url.includes(thread.id)), 'the question reaches the partner');
    const ask = json<SentConversationMessage>(await post(partner, `/api/v1/conversations/${thread.id}/messages`,
      { body: 'Yes, I can be there at 6. Do I need a key?', clientMessageId: randomUUID() }), 201);
    const asked = await waitFor(async () => (await queue(owner)).items.find((item) => item.url.endsWith(`#message-${ask.id}`)), 'the answer that asks back reaches the owner\'s Inbox');
    assert.equal(asked.reason, 'question', 'it reached the owner as a question to them');
    // The owner answers it (Inbox › Reply is a reply in the thread): the partner asked, so the answer reaches the partner's Inbox.
    const said = json<SentConversationMessage>(await post(owner, `/api/v1/conversations/${thread.id}/messages`,
      { body: 'No, the back door code is 4512.', clientMessageId: randomUUID() }), 201);
    const item = await waitFor(async () => (await queue(partner)).items.find((entry) => entry.url.endsWith(`#message-${said.id}`)), 'the answer reaches the asker\'s Inbox');
    assert.deepEqual([item.kind, item.answer, item.title, item.from?.id], ['mention', true, 'No, the back door code is 4512.', owner.id]);
    const note = (await inbox(partner)).find((entry) => entry.id === item.key.slice(5));
    assert.deepEqual([note?.reason, note?.title], ['mention', 'Needs Owner answered you in Garden sensors']);

    // The same in a direct message between two people.
    const created = await post(owner, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [second.id] });
    const dm = (created.json as { id: string }).id;
    json(await post(owner, `/api/v1/dms/${dm}/messages`, { body: 'ny-second, can you close on Friday?', clientMessageId: randomUUID() }), 201);
    const back = json<SentDmMessage>(await post(second, `/api/v1/dms/${dm}/messages`, { body: 'Sure. Who has the alarm code?', clientMessageId: randomUUID() }), 201);
    await waitFor(async () => (await queue(owner)).items.find((entry) => entry.url === `/dm/${dm}#message-${back.id}` && entry.reason === 'question'), 'the DM answer that asks back reaches the owner as a question');
    const reply = json<SentDmMessage>(await post(owner, `/api/v1/dms/${dm}/messages`, { body: 'I do, I will text it to you.', clientMessageId: randomUUID() }), 201);
    const inDm = await waitFor(async () => (await queue(second)).items.find((entry) => entry.url === `/dm/${dm}#message-${reply.id}`), 'the DM answer reaches the asker\'s Inbox');
    assert.deepEqual([inDm.kind, inDm.answer], ['mention', true]);
  });
});
