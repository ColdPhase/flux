import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { SPACE_PREVIEWS_PATH, type Conversation, type ConversationMessage, type Project, type SpacePreviewsResponse } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// The Spaces list's second line and time (v0.2.2, #1563; round 15 look-2 P3-11): the newest message of each space the caller can read, in one
// read. A task's discussion is not the space's conversation; a space the caller cannot read is not told of; a space with no message has no item.

describe('space previews: the newest message of each readable space', () => {
  let ada: Person; let ben: Person; let cleo: Person; let dan: Person;
  let open: Project; let empty: Project; let closed: Project;
  const names = new Map<string, string>();
  const start = async (who: Person, projectId: string, body: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
  const reply = async (who: Person, conversationId: string, body: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  const read = async (who: Person, ids: string[]) =>
    (expectStatus(await who.browser.request('GET', `${SPACE_PREVIEWS_PATH}?projectIds=${ids.join(',')}`), 200) as SpacePreviewsResponse).items;

  before(async () => {
    [ada, ben, cleo, dan] = await Promise.all(['Ada Preview', 'Ben Preview', 'Cleo Preview', 'Dan Preview'].map(person));
    names.set(ada.id, 'Ada Preview'); names.set(ben.id, 'Ben Preview');
    const ws = await workspace(ada, 'Preview club');
    for (const member of [ben, cleo]) await addMember(ada, ws.id, member, 'member');
    await addMember(ada, ws.id, dan, 'guest');
    open = await project(ada, ws.id, 'Open lamp', 'workspace');
    empty = await project(ada, ws.id, 'Quiet shelf', 'workspace');
    closed = await project(ada, ws.id, 'Closed desk', 'restricted');
    await grant(ada, closed.id, ben, 'contributor');
    await grant(ada, closed.id, dan, 'contributor');
  });

  test('the newest message of the space, a reply in a thread included, with who wrote it and the beginning of its words', async () => {
    const first = await start(ada, open.id, 'Which sensor for the lamp?');
    await reply(ben, first.id, '**The ToF one**, it works in the dark.');
    const items = await read(ada, [open.id, empty.id]);
    assert.deepEqual(items.map((item) => item.projectId), [open.id], 'a space with no message has no item');
    const [latest] = items;
    assert.deepEqual([latest!.author, latest!.body, latest!.files], [{ kind: 'human', id: ben.id, name: 'Ben Preview' }, 'The ToF one, it works in the dark.', 0], 'the reply, as plain words');
    assert.ok(Math.abs(Date.now() - Date.parse(latest!.at)) < 60_000);
    const second = await start(ada, open.id, 'Another topic');
    assert.deepEqual((await read(ben, [open.id]))[0]!.body, 'Another topic', 'a newer conversation is the newest');
    assert.equal(second.id.length, 36);
  });

  test('a task\'s discussion is not the space\'s conversation', async () => {
    const task = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${open.id}/work`, { body: { title: 'Order the sensor' } }), 201) as { id: string };
    expectStatus(await ada.browser.request('POST', `/api/v1/work/${task.id}/discussion`, { body: { body: 'Ordered today.', clientMessageId: randomUUID() } }), 201);
    assert.notEqual((await read(ada, [open.id]))[0]!.body, 'Ordered today.');
  });

  test('a space the caller cannot read is left out as if it did not exist, and a message taken back is not the newest', async () => {
    const talk = await start(ada, closed.id, 'Desk plans for the closed group');
    assert.deepEqual((await read(cleo, [closed.id, open.id])).map((item) => item.projectId), [open.id], 'Cleo has no grant on the closed space');
    assert.deepEqual((await read(ben, [closed.id])).map((item) => item.body), ['Desk plans for the closed group']);
    // A guest reads only the spaces they were added to, not the ones everyone of the company is in (F-037).
    assert.deepEqual((await read(dan, [open.id, closed.id])).map((item) => item.projectId), [closed.id], 'a guest is told only of their own spaces');
    const later = await reply(ada, talk.id, 'Wrong place, ignore this.');
    expectStatus(await ada.browser.request('DELETE', `/api/v1/conversations/${talk.id}/messages/${later.id}`), 200);
    assert.deepEqual((await read(ben, [closed.id])).map((item) => item.body), ['Desk plans for the closed group'], 'the message its author took back is not shown');
  });

  test('at most 100 spaces are asked about at a time, and an id that is none is refused', async () => {
    const response = await ada.browser.request('GET', `${SPACE_PREVIEWS_PATH}?projectIds=${Array.from({ length: 101 }, () => randomUUID()).join(',')}`);
    assert.equal(response.status, 400, response.text);
    assert.equal((await ada.browser.request('GET', `${SPACE_PREVIEWS_PATH}?projectIds=not-an-id`)).status, 400);
    assert.deepEqual(await read(ada, []), [], 'no space asked about, none told');
  });
});
