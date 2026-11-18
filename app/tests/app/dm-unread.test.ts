import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { READ_ALL_PATH, READ_ALL_UNDO_PATH, type Dm, type DmMessage, type DmSummary, type Page, type ReadAllResult, type Workspace } from '@flux/contracts';
import type { Browser } from './support/http.js';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, secondSession, workspace, type Person } from './support/people.js';

// Direct messages have an unread state (founder decision, Hubert, 2026-11-14, #1424 decision 10). A DM is unread for a participant while a
// root message by someone else comes after where they left off: the newest root they observed ("Seen by"), their own newest root, and their
// "Mark all as read" mark (`dm_reads`, migration 0084). The list answers how many (`unread`, at most 99). It is the server's, so every
// session of the person agrees; a thread reply and the person's own words never make it unread.

describe('a direct message is unread until it is read, on every device (#1424 decision 10)', () => {
  let marta: Person;
  let piotr: Person;
  let jonas: Person;
  let ws: Workspace;
  let phone: Browser;

  const open = async (from: Person, to: Person[]) => {
    const created = await from.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: to.map((someone) => someone.id) } });
    assert.ok(created.status === 200 || created.status === 201, created.text);
    return created.json as Dm;
  };
  const say = async (from: Person, dmId: string, body: string) =>
    expectStatus(await from.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as DmMessage;
  const reply = async (from: Person, dmId: string, rootId: string, body: string) =>
    expectStatus(await from.browser.request('POST', `/api/v1/dms/${dmId}/threads/${rootId}/replies`, { body: { body, clientMessageId: randomUUID() } }), 201) as DmMessage;
  const observe = async (browser: Browser, dmId: string, ids: string[]) =>
    expectStatus(await browser.request('POST', `/api/v1/dms/${dmId}/observations`, { body: { messageIds: ids } }), 200);
  /** What one session's Messages list says of a DM. */
  const unread = async (browser: Browser, dmId: string) => {
    const page = expectStatus(await browser.request('GET', `/api/v1/workspaces/${ws.id}/dms?limit=100`), 200) as Page<DmSummary>;
    const found = page.items.find((item) => item.id === dmId);
    assert.ok(found, 'the DM is listed');
    return found.unread;
  };
  const readAll = async (browser: Browser) => (expectStatus(await browser.request('POST', READ_ALL_PATH, { body: {} }), 200) as ReadAllResult).undo;

  before(async () => {
    [marta, piotr, jonas] = await Promise.all(['Unread Marta', 'Unread Piotr', 'Unread Jonas'].map(person));
    ws = await workspace(piotr, 'Corner shop');
    await addMember(piotr, ws.id, marta, 'member');
    await addMember(piotr, ws.id, jonas, 'member');
    phone = (await secondSession(marta)).browser;
  });

  test('a message from someone else is unread for the reader and never for its author, and reading it on one device reads it on the other', async () => {
    const dm = await open(piotr, [marta]);
    // A conversation nobody has written in is not listed for her at all (persona round 6), so it has nothing to be read.
    const listed = expectStatus(await marta.browser.request('GET', `/api/v1/workspaces/${ws.id}/dms?limit=100`), 200) as Page<DmSummary>;
    assert.ok(!listed.items.some((item) => item.id === dm.id), 'a conversation with nothing in it is not in her list');
    const first = await say(piotr, dm.id, 'The new shelf came today');
    const second = await say(piotr, dm.id, 'It is in the back room');
    assert.equal(await unread(marta.browser, dm.id), 2, 'two messages she has not seen');
    assert.equal(await unread(phone, dm.id), 2, 'the same on her phone');
    assert.equal(await unread(piotr.browser, dm.id), 0, 'his own words are read for him');

    // She sees the first on the computer: one is left, on both devices.
    await observe(marta.browser, dm.id, [first.id]);
    assert.equal(await unread(phone, dm.id), 1);
    // Seeing the newest reads everything before it.
    await observe(phone, dm.id, [second.id]);
    assert.equal(await unread(marta.browser, dm.id), 0, 'read on the phone is read on the computer');
    assert.equal(await unread(phone, dm.id), 0);

    // A reply in a thread is read in its thread: the conversation's list stays read.
    await reply(piotr, dm.id, second.id, 'Next to the freezer');
    assert.equal(await unread(marta.browser, dm.id), 0, 'a thread reply leaves the conversation read');

    // A new message is unread again; her own answer after it reads it (she was there to write it).
    await say(piotr, dm.id, 'Can you put the prices on it?');
    assert.equal(await unread(phone, dm.id), 1);
    await say(marta, dm.id, 'Yes, tomorrow morning');
    assert.equal(await unread(phone, dm.id), 0, 'writing in the conversation reads it');
  });

  test('Mark all as read reads every direct message on every device, the New divider agrees, and Undo puts back only what was not read since', async () => {
    const pair = await open(jonas, [marta]);
    const group = await open(piotr, [marta, jonas]);
    await say(jonas, pair.id, 'Did the delivery come?');
    const groupLine = await say(piotr, group.id, 'Stock count on Friday');
    assert.equal(await unread(phone, pair.id), 1);
    assert.equal(await unread(phone, group.id), 1);
    assert.equal(await unread(jonas.browser, group.id), 1, 'Jonas has not read it either');

    const undo = await readAll(marta.browser);
    assert.deepEqual(new Set((undo.dms ?? []).map((dm) => dm.dmId)), new Set([pair.id, group.id]), 'both conversations were read');
    assert.equal(await unread(phone, pair.id), 0, 'read on the computer is read on the phone');
    assert.equal(await unread(phone, group.id), 0);
    assert.equal(await unread(jonas.browser, group.id), 1, 'another person\'s read is their own');
    const mark = (await pool.query('SELECT read_through FROM dm_reads WHERE dm_id = $1 AND user_id = $2', [group.id, marta.id])).rows[0]?.read_through as number;
    assert.equal(mark, groupLine.sequence, 'read through its newest message');
    const detail = expectStatus(await phone.request('GET', `/api/v1/dms/${pair.id}`), 200) as Dm;
    assert.equal(detail.unreadFrom ?? null, null, 'the conversation opens with no New divider');

    // She reads the group herself before she undoes: Undo leaves it read and brings back only the pair.
    await observe(phone, group.id, [groupLine.id]);
    expectStatus(await marta.browser.request('POST', READ_ALL_UNDO_PATH, { body: undo }), 204);
    assert.equal(await unread(phone, pair.id), 1, 'Undo brings back what she had not read');
    assert.equal(await unread(phone, group.id), 0, 'what she read since stays read');

    // An Undo of someone else's mark changes nothing of hers.
    const again = await readAll(marta.browser);
    assert.equal(await unread(marta.browser, pair.id), 0);
    expectStatus(await jonas.browser.request('POST', READ_ALL_UNDO_PATH, { body: { mark: null, spaces: [], chats: [], dms: again.dms } }), 204);
    assert.equal(await unread(marta.browser, pair.id), 0, 'Jonas cannot make her conversation unread');
    // A malformed one is refused.
    expectStatus(await marta.browser.request('POST', READ_ALL_UNDO_PATH, { body: { mark: null, spaces: [], chats: [], dms: [{ dmId: 'nope', before: null, now: 1 }] } }), 400);
  });

  test('a person who left a conversation has no read state in it', async () => {
    const dm = await open(piotr, [marta, jonas]);
    await say(piotr, dm.id, 'Who takes Saturday?');
    expectStatus(await jonas.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 204);
    const page = expectStatus(await jonas.browser.request('GET', `/api/v1/workspaces/${ws.id}/dms?limit=100`), 200) as Page<DmSummary>;
    assert.equal(page.items.find((item) => item.id === dm.id), undefined, 'not listed for him');
    const undo = await readAll(jonas.browser);
    assert.equal((undo.dms ?? []).some((item) => item.dmId === dm.id), false, 'Mark all as read does not read it for him');
  });
});
