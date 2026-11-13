import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { Conversation, Dm, SearchResponse, SearchResult } from '@flux/contracts';
import { accessPorts, searchRows, type SearchPlanRows } from '@flux/db';
import { createAgent, type Principal } from '@flux/core';
import { policySearchAccess } from '../../apps/server/src/search/adapters.js';
import { inBatches } from './support/batches.js';
import { db } from './support/db.js';
import { type ClientResponse } from './support/http.js';
import { addMember, expectStatus, person, project as createProject, workspace, type Person } from './support/people.js';

// F-042: the order of what a person (or an agent) may read does not depend on what they may not. pg_search matches; it does not rank, because
// its score counts how rare a word is over the whole index, restricted spaces, other people's direct messages and other workspaces included.
// The order is computed in the statement from the hits the caller may see, so writes in places the caller cannot read, however many, move
// nothing. (Review probe of #1326: two visible messages, each with one of two words, swapped places once 40 hidden messages held one of the words.)

const post = (someone: Person, path: string, body: unknown) => someone.browser.request('POST', path, { body });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const search = async (someone: Person, q: string) => json<SearchResponse>(await someone.browser.request('GET', `/api/v1/search?${new URLSearchParams({ q })}`), 200, 'search');
const text = (value: SearchResult['title'] | null) => (value ?? []).map((part) => part.text).join('');
const titles = (answer: SearchResponse) => answer.items.map((item) => text(item.title));
async function conversation(someone: Person, projectId: string, body: string) {
  return json<Conversation>(await post(someone, `/api/v1/projects/${projectId}/conversations`, { body, clientMessageId: randomUUID() }), 201, 'conversation');
}
async function say(someone: Person, conversationId: string, body: string) {
  return json<{ id: string }>(await post(someone, `/api/v1/conversations/${conversationId}/messages`, { body, clientMessageId: randomUUID() }), 201, 'message');
}
const word = (tag: string) => `${tag}${randomUUID().replaceAll('-', '').replace(/\d/g, '').slice(0, 10)}`;
const human = (someone: Person): Principal => ({ id: someone.id, kind: 'human' });

/** What a reader's words find, best first, through the people's search API and through the statement an agent's `flux_search` runs. */
async function orders(reader: Person, words: string) {
  const plan: SearchPlanRows = { text: words, prefix: null, fuzzy: false, number: null, words, kinds: null, place: null, author: null, after: null, limit: 20, reader: reader.id };
  const hits = await searchRows(db).ranked(await policySearchAccess(db).audiences(human(reader)), plan);
  const part = (parts: { text: string }[] | null) => (parts ?? []).map((item) => item.text).join('');
  return { people: titles(await search(reader, `${words}.`)), statement: hits.map((hit) => part(hit.title) || part(hit.snippet)) };
}

describe('search: what the reader may not read does not move the order of what they may (F-042)', () => {
  for (const where of ['a restricted space of the same workspace', 'another workspace the reader is not in', 'a direct message of other people']) {
    test(`forty hidden writes in ${where} change nothing`, async () => {
      const [owner, reader, stranger] = await Promise.all(['Rank Owner', 'Rank Reader', 'Rank Stranger'].map(person));
      const ws = await workspace(owner, 'Rank workspace');
      await addMember(owner, ws.id, reader, 'member');
      await addMember(owner, ws.id, stranger, 'member');
      const open = await createProject(owner, ws.id, 'Rank open', 'workspace');
      const known = word('kontrol');
      const target = word('sekret');
      const thread = await conversation(reader, open.id, 'Opener of the thread.');
      await say(reader, thread.id, `Note ${known} here.`);
      await say(reader, thread.id, `Note ${target} here.`);
      // The two visible messages are alike in everything but the word: their order is the same whatever happens elsewhere.
      const q = `${known} ${target}`;
      const before = await orders(reader, q);
      assert.equal(before.people.length, 2);
      assert.equal(before.statement.length, 2);
      let write: (index: number) => Promise<unknown>;
      if (where.startsWith('a restricted')) {
        const hidden = await createProject(owner, ws.id, 'Rank hidden', 'restricted');
        const hiddenThread = await conversation(owner, hidden.id, 'Hidden opener.');
        write = (index) => say(owner, hiddenThread.id, `Hidden ${target} number ${index}.`);
      } else if (where.startsWith('another')) {
        const other = await workspace(stranger, 'Rank other company');
        const secret = await createProject(stranger, other.id, 'Rank secret', 'workspace');
        const hiddenThread = await conversation(stranger, secret.id, 'Other opener.');
        write = (index) => say(stranger, hiddenThread.id, `Hidden ${target} number ${index}.`);
      } else {
        const opened = await post(owner, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [stranger.id] });
        assert.ok(opened.status === 201 || opened.status === 200, opened.text);
        const dm = opened.json as Dm;
        write = (index) => post(owner, `/api/v1/dms/${dm.id}/messages`, { body: `Hidden ${target} number ${index}.`, clientMessageId: randomUUID() });
      }
      await inBatches(40, write);
      assert.deepEqual(await orders(reader, q), before, 'the order of the reader\'s own results does not depend on what is hidden from them');
    });
  }

  test('an agent of the owner is held to the same: its search ranks by what its owner may read', async () => {
    const [owner, stranger] = await Promise.all(['Agent Owner', 'Agent Stranger'].map(person));
    const ws = await workspace(owner, 'Agent rank workspace');
    const open = await createProject(owner, ws.id, 'Agent open', 'workspace');
    const agent = await createAgent(human(owner), ws.id, { name: 'Rankbot' }, db, accessPorts);
    const bot: Principal = { id: agent.id, kind: 'agent' };
    const known = word('kontrol');
    const target = word('sekret');
    const thread = await conversation(owner, open.id, 'Agent opener.');
    await say(owner, thread.id, `Note ${known} here.`);
    await say(owner, thread.id, `Note ${target} here.`);
    const plan = (): SearchPlanRows => ({ text: `${known} ${target}`, prefix: null, fuzzy: false, number: null, words: `${known} ${target}`, kinds: null, place: null, author: null, after: null,
      limit: 20, reader: owner.id });
    const run = async () => (await searchRows(db).ranked(await policySearchAccess(db).audiences(bot), plan())).map((hit) => hit.snippet?.map((part) => part.text).join('') ?? '');
    const before = await run();
    assert.equal(before.length, 2);
    // Another company's space: nothing of it is readable by the owner or by their agent.
    const other = await workspace(stranger, 'Agent rank other company');
    const secret = await createProject(stranger, other.id, 'Agent secret', 'workspace');
    const hiddenThread = await conversation(stranger, secret.id, 'Hidden agent opener.');
    await inBatches(40, (index) => say(stranger, hiddenThread.id, `Hidden ${target} number ${index}.`));
    assert.deepEqual(await run(), before);
  });
});
