import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { accessPorts, searchRows, type SearchPlanRows } from '@flux/db';
import { createAgent, type Principal } from '@flux/core';
import type { Conversation, Project, Workspace } from '@flux/contracts';
import { policySearchAccess } from '../../apps/server/src/search/adapters.js';
import { db, pool } from './support/db.js';
import { type ClientResponse } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, workspace, type Person } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';

// The BM25 index of migration 0065 (F-041, #1296): any word, Polish and English stems, accents folded, ranked by word rarity, and
// filtered in the same statement by the audiences the access policy gives the caller now. Nothing about access is stored in the
// index, so a lost grant, a space whose AI was turned off, a removed, deleted or edited message shows in the very next query.

const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const human = (someone: Person): Principal => ({ id: someone.id, kind: 'human' });
const rows = searchRows(db);
const access = policySearchAccess(db);

function plan(words: string, reader: string): SearchPlanRows {
  return { text: words, prefix: null, fuzzy: false, number: null, words, kinds: null, place: null, author: null, after: null, limit: 10, reader };
}

/** The bodies a principal finds for these words, best first. */
async function found(principal: Principal, words: string): Promise<string[]> {
  const audiences = await access.audiences(principal);
  const hits = await rows.ranked(audiences, plan(words, principal.id));
  const text = (parts: { text: string }[] | null) => (parts ?? []).map((part) => part.text).join('');
  // A message has no title: its words are the snippet, as people's search shows it.
  return hits.map((hit) => text(hit.title) || text(hit.snippet));
}

describe('BM25 search: any word, Polish and English stems, accents folded, only what the caller may read now', () => {
  let ari: Person; // company owner, in both spaces
  let nia: Person; // member with a grant on the restricted space
  let olek: Person; // member without it
  let gus: Person; // guest, added to the open space only
  let ws: Workspace;
  let lamp: Project; // restricted
  let open: Project; // workspace-visible
  let lampThread: Conversation;
  let openThread: Conversation;

  const say = async (someone: Person, conversationId: string, body: string) =>
    json<{ id: string }>(await someone.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201, 'message');
  const conversation = async (someone: Person, projectId: string, body: string) =>
    json<Conversation>(await someone.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201, 'conversation');

  before(async () => {
    [ari, nia, olek, gus] = await Promise.all(['Ari Nowak', 'Nia Berg', 'Olek Marsh', 'Gus Field'].map(person));
    ws = await workspace(ari, 'Zielony Dach');
    await addMember(ari, ws.id, nia, 'member');
    await addMember(ari, ws.id, olek, 'member');
    await addMember(ari, ws.id, gus, 'guest');
    lamp = await createProject(ari, ws.id, 'Stacje pogodowe', 'restricted');
    await grant(ari, lamp.id, nia, 'contributor');
    open = await createProject(ari, ws.id, 'Open notes', 'workspace');
    await grant(ari, open.id, gus, 'contributor');
    lampThread = await conversation(nia, lamp.id, 'Kalibracja czujników temperatury SHT45 jest zaplanowana na piątek.');
    openThread = await conversation(olek, open.id, 'The humidity sensors were calibrated yesterday.');
  });

  test('the index is built by migration 0065 over search_documents and leaves sealed rows out', async () => {
    const index = (await pool.query(`SELECT pg_get_indexdef('search_documents_bm25_idx'::regclass) AS def`)).rows[0] as { def: string };
    assert.match(index.def, /USING bm25/);
    assert.match(index.def, /stemmer=polish/);
    assert.match(index.def, /stemmer=english/);
    assert.match(index.def, /WHERE \(NOT sealed\)$/);
  });

  test('an inflected Polish word, the word without its accents and an English stem all find their message', async () => {
    assert.deepEqual(await found(human(nia), 'czujnik'), ['Kalibracja czujników temperatury SHT45 jest zaplanowana na piątek.']);
    assert.deepEqual(await found(human(nia), 'czujnikow piatek'), ['Kalibracja czujników temperatury SHT45 jest zaplanowana na piątek.']);
    assert.deepEqual(await found(human(olek), 'sensor calibrate'), ['The humidity sensors were calibrated yesterday.']);
    // Any of the words: one that is nowhere does not hide the one that is.
    assert.deepEqual(await found(human(nia), 'SHT45 barometr'), ['Kalibracja czujników temperatury SHT45 jest zaplanowana na piątek.']);
    assert.deepEqual(await found(human(nia), 'zzzyx'), []);
  });

  test('only the spaces the caller may read: a member outside the restricted space and a guest find nothing there', async () => {
    assert.deepEqual(await found(human(olek), 'czujnik'), []);
    assert.deepEqual(await found(human(gus), 'czujnik'), []);
    assert.deepEqual(await found(human(gus), 'sensor'), ['The humidity sensors were calibrated yesterday.']);
  });

  test('a lost grant is reflected by the very next search', async () => {
    const lost = await person('Lena Lost');
    await addMember(ari, ws.id, lost, 'member');
    await grant(ari, lamp.id, lost, 'contributor');
    assert.equal((await found(human(lost), 'czujnik')).length, 1);
    await removeFromSpace(ari, lamp.id, lost);
    assert.deepEqual(await found(human(lost), 'czujnik'), []);
  });

  test("an agent finds only where its owner may read and the space's AI is on, from the next search on", async () => {
    const agent = await createAgent(human(ari), ws.id, { name: 'Fieldbot' }, db, accessPorts);
    const bot: Principal = { id: agent.id, kind: 'agent' };
    try {
      assert.deepEqual(await found(bot, 'czujnik'), ['Kalibracja czujników temperatury SHT45 jest zaplanowana na piątek.']);
      await setSpaceAi(lamp.id, 'blocked');
      assert.deepEqual(await found(bot, 'czujnik'), []);
      assert.equal((await found(human(ari), 'czujnik')).length, 1, 'people still find it');
      await setSpaceAi(lamp.id, 'allowed');
      assert.equal((await found(bot, 'czujnik')).length, 1);
    } finally {
      await ensureSpaceAiAllowed(lamp.id);
    }
  });

  test('an edit, a removal and a deletion are reflected at once', async () => {
    const message = await say(olek, openThread.id, 'Anemometr na dachu B wymaga wymiany łożyska.');
    assert.deepEqual(await found(human(olek), 'anemometr'), ['Anemometr na dachu B wymaga wymiany łożyska.']);
    json(await olek.browser.request('PATCH', `/api/v1/conversations/${openThread.id}/messages/${message.id}`, { body: { body: 'Wiatromierz na dachu B działa.' } }), 200, 'edit');
    assert.deepEqual(await found(human(olek), 'anemometr'), [], 'the removed words find nothing');
    assert.deepEqual(await found(human(olek), 'wiatromierz'), ['Wiatromierz na dachu B działa.']);
    const response = await olek.browser.request('DELETE', `/api/v1/conversations/${openThread.id}/messages/${message.id}`);
    assert.ok(response.status === 200 || response.status === 204, response.text);
    assert.deepEqual(await found(human(olek), 'wiatromierz'), [], 'a removed message is not found');

    const gone = await say(olek, openThread.id, 'Pluwiometr kalibrowany ręcznie.');
    assert.equal((await found(human(olek), 'pluwiometr')).length, 1);
    await pool.query('DELETE FROM project_messages WHERE id = $1', [gone.id]);
    assert.deepEqual(await found(human(olek), 'pluwiometr'), [], 'a deleted row is not found');
    void lampThread;
  });

  test('a sealed placeholder (an encrypted space) is never in the index', async () => {
    const audiences = await access.audiences(human(nia));
    const key = `project:${lamp.id}`;
    // Encrypted spaces keep only empty placeholders in search_documents; even one that carried words would not be indexed.
    await pool.query(`INSERT INTO search_documents (doc_key, kind, workspace_id, audience_key, project_id, object_id, title, body, at, sealed)
      VALUES ($1, 'message', $2, $3, $4, $5, '', '', now(), true)`, [`message:${randomUUID()}`, ws.id, key, lamp.id, randomUUID()]);
    const counted = await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE sealed AND audience_key = $1`, [key]);
    assert.equal((counted.rows[0] as { n: number }).n, 1);
    assert.deepEqual((await rows.ranked(audiences, plan('kalibracja', nia.id))).map((hit) => hit.kind), ['message']);
  });
});
