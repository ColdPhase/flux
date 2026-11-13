import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { Conversation, Dm, SearchResponse, SearchResult } from '@flux/contracts';
import { accessPorts, searchRows, type SearchPlanRows } from '@flux/db';
import { createAgent, type Principal } from '@flux/core';
import { policySearchAccess } from '../../apps/server/src/search/adapters.js';
import { inBatches } from './support/batches.js';
import { db, pool } from './support/db.js';
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

  test('a filter (an author, a space, a conversation) lets no rarity of the index into the order', async () => {
    // pg_search scores a filter on one value by BM25, with that value's rarity over the whole index: a person who wrote few of an
    // instance's documents, a small space or a short conversation. The statement applies the caller's filters after its scan, so a
    // filtered search ranks its hits exactly as the same search without the filter, however large the hidden rest of the index grows.
    const [owner, reader] = await Promise.all(['Filter Owner', 'Filter Reader'].map(person));
    const ws = await workspace(owner, 'Filter workspace');
    await addMember(owner, ws.id, reader, 'member');
    const open = await createProject(owner, ws.id, 'Filter open', 'workspace');
    const known = word('kontrol');
    const target = word('sekret');
    const thread = await conversation(reader, open.id, 'Filter opener.');
    await say(reader, thread.id, `Note ${known} here.`);
    await say(reader, thread.id, `Note ${target} here.`);
    const audiences = await policySearchAccess(db).audiences(human(reader));
    const run = async (narrow: Partial<SearchPlanRows>) => (await searchRows(db).ranked(audiences, {
      text: `${known} ${target}`, prefix: null, fuzzy: false, number: null, words: `${known} ${target}`, kinds: null, place: null, author: null, after: null,
      limit: 20, reader: reader.id, ...narrow,
    })).map((hit) => `${hit.position.score} ${hit.snippet?.map((part) => part.text).join('') ?? ''}`);
    // Forty thousand rows nobody may read, by other authors, outside this space and conversation: each filtered value becomes rare.
    const hiddenAudience = `project:${randomUUID()}`;
    await pool.query(`INSERT INTO search_documents (doc_key, kind, workspace_id, audience_key, object_id, title, body, author_kind, author_id, at)
      SELECT 'message:' || gen_random_uuid(), 'message', $1, $2, gen_random_uuid()::text, '', 'Hidden filler ' || g, 'human', 'hidden-' || (g % 997), now()
      FROM generate_series(1, 40000) g`, [ws.id, hiddenAudience]);
    try {
      const plain = await run({});
      assert.equal(plain.length, 2);
      for (const narrow of [
        { author: { kind: 'human' as const, id: reader.id } },
        { authorId: reader.id },
        { place: { type: 'project' as const, id: open.id } },
        { conversationId: thread.id },
        { kinds: ['message' as const] },
      ]) assert.deepEqual(await run(narrow), plain, `the filter ${JSON.stringify(narrow)} ranks as the search without it`);
    } finally {
      await pool.query('DELETE FROM search_documents WHERE audience_key = $1', [hiddenAudience]);
    }
  });

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
