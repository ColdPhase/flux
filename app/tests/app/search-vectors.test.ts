import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { accessPorts, searchRows, searchVectorRows, type QueryVectors, type SearchPlanRows } from '@flux/db';
import { createAgent, createEmbedder, createQueryVectors, EMBED_TEXT_LIMIT, type Principal } from '@flux/core';
import type { Conversation, Project, Workspace } from '@flux/contracts';
import { startSearchVectors } from '../../apps/worker/src/search-vectors/index.js';
import { policySearchAccess } from '../../apps/server/src/search/adapters.js';
import { connectionString, db, pool } from './support/db.js';
import { startEmbeddingsMock, type EmbeddingsMock } from './support/embeddings-mock.js';
import { type ClientResponse } from './support/http.js';
import { createSealed, passphrase } from './support/encryption.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, workspace, type Person } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';
import { recordingDatabase } from './support/statements.js';
import { waitFor } from './support/wait.js';

// Optional local embeddings (F-042, #1294, migration 0068). Off: nothing is written, queued or sent. On: a vector per eligible row,
// written by a worker that wakes on NOTIFY and polls nothing; an edit, a removal, a turned-off AI and a lost grant show in the very
// next search; encrypted spaces are never embedded; ranked search fuses the BM25 list and the nearest-vector list by reciprocal rank
// (k = 60). The container is a stand-in (support/embeddings-mock.ts): words of one concept are near each other.

const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const human = (someone: Person): Principal => ({ id: someone.id, kind: 'human' });
const vectorRows = searchVectorRows(db);
const access = policySearchAccess(db);
const url = (mock: EmbeddingsMock) => ({ FLUX_EMBEDDINGS_URL: mock.url });

function plan(words: string, reader: string): SearchPlanRows {
  return { text: words, prefix: null, fuzzy: false, number: null, words, kinds: null, place: null, author: null, after: null, limit: 20, reader };
}

const text = (parts: { text: string }[] | null) => (parts ?? []).map((part) => part.text).join('');

describe('optional embeddings: off by default, hybrid ranking when on', () => {
  let mock: EmbeddingsMock;
  let ari: Person; // company owner
  let nia: Person; // member with a grant on the restricted space
  let olek: Person; // member without it
  let gus: Person; // guest, added to the open space only
  let ws: Workspace;
  let lamp: Project; // restricted
  let open: Project; // workspace-visible
  let lampThread: Conversation;
  let openThread: Conversation;
  let worker: Awaited<ReturnType<typeof startSearchVectors>> | null = null;

  const say = async (someone: Person, conversationId: string, body: string) =>
    json<{ id: string }>(await someone.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201, 'message');
  const conversation = async (someone: Person, projectId: string, body: string) =>
    json<Conversation>(await someone.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201, 'conversation');
  const withVectors = () => createQueryVectors(createEmbedder(mock.url), { log: () => undefined });
  /** The bodies a principal finds with ranked search (hybrid when `vectors` is given), best first. */
  async function found(principal: Principal, words: string, vectors: QueryVectors | null = withVectors()): Promise<string[]> {
    const hits = await searchRows(db, vectors ?? undefined).ranked(await access.audiences(principal), plan(words, principal.id));
    return hits.map((hit) => text(hit.title) || text(hit.snippet));
  }
  const counts = () => vectorRows.counts();
  const documentOf = async (messageId: string) =>
    Number((await pool.query<{ id: string }>(`SELECT id FROM search_documents WHERE doc_key = $1`, [`message:${messageId}`])).rows[0]!.id);
  const hasVector = async (messageId: string) =>
    (await pool.query(`SELECT 1 FROM search_vectors v JOIN search_documents d ON d.id = v.document_id WHERE d.doc_key = $1`, [`message:${messageId}`])).rowCount === 1;
  const isQueued = async (messageId: string) =>
    (await pool.query(`SELECT 1 FROM search_vector_queue q JOIN search_documents d ON d.id = q.document_id WHERE d.doc_key = $1`, [`message:${messageId}`])).rowCount === 1;
  /** Starts the worker against the stand-in container and waits until its queue is empty. */
  async function start() {
    worker = await startSearchVectors({ db, connectionString, env: url(mock), log: () => undefined });
    await settled();
  }
  async function settled() {
    await waitFor(async () => { const c = await counts(); return c.queued === 0 && c.vectors > 0; }, 'the embedding queue to empty', 30_000);
  }

  before(async () => {
    mock = await startEmbeddingsMock();
    await vectorRows.turnOff();
    [ari, nia, olek, gus] = await Promise.all(['Ari Nowak', 'Nia Berg', 'Olek Marsh', 'Gus Field'].map(person));
    ws = await workspace(ari, 'Zielony Dach');
    await addMember(ari, ws.id, nia, 'member');
    await addMember(ari, ws.id, olek, 'member');
    await addMember(ari, ws.id, gus, 'guest');
    lamp = await createProject(ari, ws.id, 'Stacje pogodowe', 'restricted');
    await grant(ari, lamp.id, nia, 'contributor');
    open = await createProject(ari, ws.id, 'Open notes', 'workspace');
    await grant(ari, open.id, gus, 'contributor');
  });

  after(async () => {
    await worker?.stop();
    await vectorRows.turnOff();
    await mock.stop();
  });

  test('off by default: writes, edits, deletes and an AI switch store, queue and send nothing', async () => {
    assert.deepEqual(await counts(), { queued: 0, vectors: 0, model: null });
    const listener = await pool.connect();
    const wakes: string[] = [];
    listener.on('notification', (message) => wakes.push(message.channel));
    await listener.query('LISTEN flux_search_vectors');
    try {
      openThread = await conversation(olek, open.id, 'The kitten sleeps on the warm windowsill.');
      lampThread = await conversation(nia, lamp.id, 'Kot śpi na ciepłym parapecie w stacji.');
      const message = await say(olek, openThread.id, 'Invoice approval needs two signatures.');
      json(await olek.browser.request('PATCH', `/api/v1/conversations/${openThread.id}/messages/${message.id}`, { body: { body: 'Invoice approval needs three signatures.' } }), 200, 'edit');
      await setSpaceAi(lamp.id, 'blocked');
      await setSpaceAi(lamp.id, 'allowed');
      await pool.query('DELETE FROM project_messages WHERE id = $1', [message.id]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      listener.release();
    }
    assert.deepEqual(wakes, [], 'no NOTIFY is sent');
    assert.deepEqual(await counts(), { queued: 0, vectors: 0, model: null }, 'no row in any of the three tables');
    assert.equal(mock.requests.length, 0, 'the container was never asked');
    // Ranked search without the hook is BM25 as it was.
    assert.deepEqual(await found(human(olek), 'cat', null), []);
    assert.deepEqual(await found(human(olek), 'windowsill', null), ['The kitten sleeps on the warm windowsill.']);
  });

  test('a worker started without FLUX_EMBEDDINGS_URL sends one transaction and then nothing', async () => {
    const recorded = recordingDatabase();
    const { result: idle, sent } = await recorded.statements(() => startSearchVectors({ db: recorded.db, connectionString, env: {}, log: () => undefined }));
    assert.ok(sent.length <= 3 && sent.some((statement) => statement.text === 'DELETE FROM search_vector_state'), `one transaction: ${sent.map((statement) => statement.text).join(' | ')}`);
    const later = await recorded.statements(() => new Promise((resolve) => setTimeout(resolve, 600)));
    await idle.stop();
    assert.deepEqual(later.sent, []);
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(await counts(), { queued: 0, vectors: 0, model: null });
  });

  test('turning on queues every eligible row and the worker embeds them: no person, no placeholder, no empty row', async () => {
    await start();
    const state = await counts();
    assert.equal(state.model, 'fake/bge-m3');
    const kinds = (await pool.query<{ kind: string; n: number }>(`SELECT d.kind, count(*)::int AS n FROM search_vectors v JOIN search_documents d ON d.id = v.document_id GROUP BY d.kind`)).rows;
    assert.ok(kinds.some((row) => row.kind === 'message'), 'messages have vectors');
    assert.ok(!kinds.some((row) => row.kind === 'person'), 'people have none');
    const wrong = await pool.query(`SELECT 1 FROM search_vectors v JOIN search_documents d ON d.id = v.document_id WHERE d.sealed OR (btrim(d.title) = '' AND btrim(d.body) = '')`);
    assert.equal(wrong.rowCount, 0);
    // Only the operator's container was asked, with the texts and nothing else: no key, no cookie, no account.
    assert.ok(mock.requests.length > 0);
    for (const request of mock.requests) {
      assert.ok(request.path === '/info' || request.path === '/embed');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      assert.ok(request.inputs.every((input) => input.length <= EMBED_TEXT_LIMIT + 400));
    }
    assert.ok(mock.requests.some((request) => request.inputs.includes('The kitten sleeps on the warm windowsill.')));
  });

  test('hybrid ranking: a row that is only near (kitten for "cat") is found, and a row in both lists ranks first with the fused score', async () => {
    const both = await say(olek, openThread.id, 'Cat food budget for April.');
    await settled();
    assert.deepEqual(await found(human(olek), 'cat', null), ['Cat food budget for April.'], 'BM25 alone knows only the word');
    const hybrid = await found(human(olek), 'cat');
    assert.equal(hybrid[0], 'Cat food budget for April.', 'in both lists: first');
    assert.ok(hybrid.includes('The kitten sleeps on the warm windowsill.'), 'a synonym is found by its vector');
    assert.ok(hybrid.indexOf('The kitten sleeps on the warm windowsill.') > 0);
    const hits = await searchRows(db, withVectors()).ranked(await access.audiences(human(olek)), plan('cat', olek.id));
    // Rank 1 of both lists: 1 / (60 + 1) twice, scaled by 61 / 2 to (0, 1] so that an encrypted space's rows still merge with it.
    assert.equal(hits[0]!.position.score, '1.000000');
    assert.ok(hits.every((hit) => Number(hit.position.score) > 0 && Number(hit.position.score) <= 1));
    assert.equal(await documentOf(both.id) > 0, true);
    // Page by page through the fused list: the position resumes after the last hit, nothing repeated or skipped.
    const first = await searchRows(db, withVectors()).ranked(await access.audiences(human(olek)), { ...plan('cat', olek.id), limit: 2 });
    const next = await searchRows(db, withVectors()).ranked(await access.audiences(human(olek)), { ...plan('cat', olek.id), limit: 2, after: first[1]!.position });
    const all = hits.map((hit) => hit.objectId);
    assert.deepEqual([...first.slice(0, 2), ...next.slice(0, 2)].map((hit) => hit.objectId), all.slice(0, 4));
  });

  test('only what the caller may read now: the restricted space, a lost grant and a guest', async () => {
    const hidden = 'Kot śpi na ciepłym parapecie w stacji.';
    assert.ok((await found(human(nia), 'cat')).includes(hidden), 'a member with the grant finds it by meaning');
    assert.ok(!(await found(human(olek), 'cat')).includes(hidden), 'a member without it never does');
    assert.ok(!(await found(human(gus), 'cat')).includes(hidden));
    const lost = await person('Lena Lost');
    await addMember(ari, ws.id, lost, 'member');
    await grant(ari, lamp.id, lost, 'contributor');
    assert.ok((await found(human(lost), 'cat')).includes(hidden));
    await removeFromSpace(ari, lamp.id, lost);
    assert.ok(!(await found(human(lost), 'cat')).includes(hidden), 'the very next search');
  });

  test('rows the caller may not read, however near the query, change nothing in their hybrid answer (#1326: no hidden row moves the order)', async () => {
    // The nearest-vector list is cut among the caller's visible, filtered rows, each distance exact: no approximate index whose graph
    // holds hidden rows. Thirty messages nearer to "cat" than anything Olek may read, in a space he cannot, leave his answer as it was.
    const answer = async (place: SearchPlanRows['place'] = null) =>
      (await searchRows(db, withVectors()).ranked(await access.audiences(human(olek)), { ...plan('cat', olek.id), place }))
        .map((hit) => [hit.objectId, hit.position.score]);
    const before = { all: await answer(), here: await answer({ type: 'project', id: open.id }) };
    assert.ok(before.all.length >= 2);
    const council = await createProject(ari, ws.id, 'Kocia rada', 'restricted');
    const thread = await conversation(ari, council.id, 'Kot kotek kitten cat.');
    try {
      for (let index = 0; index < 30; index += 1) await say(ari, thread.id, `Cat kitten kot ${index}.`);
      await settled();
      const near = await pool.query(`SELECT 1 FROM search_vectors v JOIN search_documents d ON d.id = v.document_id WHERE d.project_id = $1 AND d.kind = 'message'`, [council.id]);
      assert.equal(near.rowCount, 31, 'the hidden messages have their vectors');
      assert.deepEqual({ all: await answer(), here: await answer({ type: 'project', id: open.id }) }, before);
    } finally {
      await pool.query('DELETE FROM project_messages WHERE conversation_id = $1', [thread.id]);
    }
  });

  test("an agent's vector path follows the space's AI switch: vectors go in the same transaction and come back when it is on", async () => {
    const agent = await createAgent(human(ari), ws.id, { name: 'Fieldbot' }, db, accessPorts);
    const bot: Principal = { id: agent.id, kind: 'agent' };
    const hidden = 'Kot śpi na ciepłym parapecie w stacji.';
    try {
      assert.ok((await found(bot, 'cat')).includes(hidden));
      await setSpaceAi(lamp.id, 'blocked');
      const left = await pool.query(`SELECT 1 FROM search_vectors v JOIN search_documents d ON d.id = v.document_id WHERE d.project_id = $1
        UNION ALL SELECT 1 FROM search_vector_queue q JOIN search_documents d ON d.id = q.document_id WHERE d.project_id = $1`, [lamp.id]);
      assert.equal(left.rowCount, 0, 'no vector and nothing queued for a space whose AI is off');
      assert.ok(!(await found(bot, 'cat')).includes(hidden), 'the agent finds nothing there');
      assert.ok(!(await found(human(nia), 'cat')).includes(hidden), 'and a person finds it only by its words now');
      assert.ok((await found(human(nia), 'parapecie')).includes(hidden));
      // A new message in a space whose AI is off is not queued either.
      const quiet = await say(nia, lampThread.id, 'Kotek wrócił na parapet.');
      assert.equal(await isQueued(quiet.id), false);
      await setSpaceAi(lamp.id, 'allowed');
      await settled();
      assert.ok((await found(bot, 'cat')).includes(hidden), 'embedded again once AI is on');
      assert.equal(await hasVector(quiet.id), true);
    } finally {
      await ensureSpaceAiAllowed(lamp.id);
    }
  });

  test('an edit drops the vector in the same transaction and queues the new words; a removal and a deletion take it with the row', async () => {
    const message = await say(olek, openThread.id, 'The puppy chewed a shoe.');
    await settled();
    assert.equal(await hasVector(message.id), true);
    assert.ok((await found(human(olek), 'dog')).includes('The puppy chewed a shoe.'));
    // With the worker stopped, between the edit's commit and the next embedding: the vector is already gone.
    await worker!.stop();
    worker = null;
    json(await olek.browser.request('PATCH', `/api/v1/conversations/${openThread.id}/messages/${message.id}`, { body: { body: 'The storm broke a window.' } }), 200, 'edit');
    assert.equal(await hasVector(message.id), false, 'the old words have no vector');
    assert.equal(await isQueued(message.id), true, 'the new words wait');
    assert.ok(!(await found(human(olek), 'dog')).includes('The storm broke a window.'));
    await start();
    assert.equal(await hasVector(message.id), true);
    assert.ok((await found(human(olek), 'rain')).includes('The storm broke a window.'), 'found by the meaning of the new words');
    const response = await olek.browser.request('DELETE', `/api/v1/conversations/${openThread.id}/messages/${message.id}`);
    assert.ok(response.status === 200 || response.status === 204, response.text);
    assert.equal(await hasVector(message.id), false);
    assert.ok(!(await found(human(olek), 'rain')).includes('The storm broke a window.'), 'a removed message is not found');

    const gone = await say(olek, openThread.id, 'Faktura za kwiecień czeka.');
    await settled();
    assert.equal(await hasVector(gone.id), true);
    await pool.query('DELETE FROM project_messages WHERE id = $1', [gone.id]);
    assert.equal(await isQueued(gone.id) || await hasVector(gone.id), false, 'a deleted row leaves neither a vector nor a queue entry');
  });

  test('a vector is never stored for words that changed, or for a space whose AI went off, after the row was claimed', async () => {
    await worker!.stop();
    worker = null;
    const message = await say(olek, openThread.id, 'The rain stopped at noon.');
    const [job] = (await vectorRows.claim(50, EMBED_TEXT_LIMIT)).filter((row) => row.text === 'The rain stopped at noon.');
    assert.ok(job, 'claimed with its words');
    const vector = (await createEmbedder(mock.url).embed([job.text]))[0]!;
    json(await olek.browser.request('PATCH', `/api/v1/conversations/${openThread.id}/messages/${message.id}`, { body: { body: 'The rain started at noon.' } }), 200, 'edit');
    assert.equal(await vectorRows.store([{ ...job, vector }]), 0, 'the old words are not stored');
    assert.equal(await hasVector(message.id), false);
    assert.equal(await isQueued(message.id), true, 'the row still waits, with its new words');

    const other = await say(nia, lampThread.id, 'The storm hit the station.');
    const [again] = (await vectorRows.claim(50, EMBED_TEXT_LIMIT)).filter((row) => row.text === 'The storm hit the station.');
    assert.ok(again);
    try {
      await setSpaceAi(lamp.id, 'blocked');
      assert.equal(await vectorRows.store([{ ...again, vector }]), 0, 'AI went off in the meantime');
      assert.equal(await hasVector(other.id), false);
    } finally {
      await ensureSpaceAiAllowed(lamp.id);
    }
    // The next pass picks both up.
    await start();
    assert.equal(await hasVector(message.id), true);
    assert.equal(await hasVector(other.id), true);
  });

  test('an encrypted space is never embedded: a row that becomes sealed loses its vector, and placeholders are not queued, now or at a backfill', async () => {
    // A plaintext row that becomes sealed (its words gone, as sealing does) loses its vector in the same transaction.
    const message = await say(olek, openThread.id, 'The cat is back.');
    await settled();
    assert.equal(await hasVector(message.id), true);
    await pool.query(`UPDATE search_documents SET sealed = true, title = '', body = '' WHERE doc_key = $1`, [`message:${message.id}`]);
    assert.equal(await hasVector(message.id) || await isQueued(message.id), false);
    // A placeholder of an encrypted workspace: sealed, no words, never queued.
    const sealed = await createSealed(ari, 'Garden club', passphrase());
    const key = `probe:${randomUUID()}`;
    await pool.query(`SELECT search_put($1, 'message', $2, $3, NULL, $4, NULL, NULL, NULL, '', 'cats and kittens', 'human', $5, now())`, [key, sealed.workspace.id, `project:${randomUUID()}`, randomUUID(), ari.id]);
    const placeholder = (await pool.query<{ sealed: boolean; body: string }>(`SELECT sealed, body FROM search_documents WHERE doc_key = $1`, [key])).rows[0]!;
    assert.deepEqual(placeholder, { sealed: true, body: '' });
    const leftOver = () => pool.query(`SELECT 1 FROM search_vectors v JOIN search_documents d ON d.id = v.document_id WHERE d.sealed OR d.workspace_id = $1
      UNION ALL SELECT 1 FROM search_vector_queue q JOIN search_documents d ON d.id = q.document_id WHERE d.sealed OR d.workspace_id = $1`, [sealed.workspace.id]);
    assert.equal((await leftOver()).rowCount, 0, 'not queued by the trigger');
    // A backfill (turning on with the rows already there) leaves them out too.
    await worker!.stop();
    worker = null;
    await vectorRows.turnOff();
    await vectorRows.turnOn('fake/bge-m3');
    assert.ok((await counts()).queued > 0, 'the ordinary rows are queued');
    assert.equal((await leftOver()).rowCount, 0, 'not queued by the backfill');
  });

  test('another model drops the vectors of the first and queues every row again', async () => {
    assert.equal((await counts()).model, 'fake/bge-m3');
    await start();
    assert.ok((await counts()).vectors > 0);
    await worker!.stop();
    worker = null;
    const turned = await vectorRows.turnOn('another/model');
    assert.equal(turned.reset, true);
    const now = await counts();
    assert.equal(now.vectors, 0);
    assert.ok(now.queued > 0);
    assert.equal(now.model, 'another/model');
    assert.deepEqual(await vectorRows.turnOn('another/model'), { reset: false, queued: 0 }, 'the same model changes nothing');
  });

  test('a container that is down or loading: the queue waits, searches rank by BM25 alone, and the worker finds it by itself', async () => {
    await vectorRows.turnOff();
    mock.down = true;
    const warnings: string[] = [];
    worker = await startSearchVectors({ db, connectionString, env: url(mock), log: (message) => warnings.push(message) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await counts(), { queued: 0, vectors: 0, model: null }, 'nothing is switched on before the model answers');
    assert.ok(warnings.some((message) => message.startsWith('Embedding failed')));
    // A search does not fail and does not wait: BM25 only, and the cool-down skips the container after the first failure.
    const hook = createQueryVectors(createEmbedder(mock.url), { log: () => undefined });
    const started = Date.now();
    assert.deepEqual(await found(human(olek), 'windowsill', hook), ['The kitten sleeps on the warm windowsill.']);
    assert.deepEqual(await hook('anything'), null);
    assert.ok(Date.now() - started < 3000);
    mock.down = false;
    await waitFor(async () => (await counts()).model !== null, 'the worker to find the container', 15_000);
    await settled();
    assert.ok((await found(human(olek), 'cat')).includes('The kitten sleeps on the warm windowsill.'));
  });

  test('a text the container refuses is skipped alone; the rest of its batch is embedded', async () => {
    await worker!.stop();
    worker = null;
    const bad = await say(olek, openThread.id, 'A text the container refuses with a 413.');
    const good = await say(olek, openThread.id, 'A text it accepts happily.');
    mock.refuse.add('A text the container refuses with a 413.');
    await start();
    assert.equal(await hasVector(good.id), true);
    assert.equal(await hasVector(bad.id), false);
    assert.equal(await isQueued(bad.id), false, 'taken off the queue, not retried for ever');
    mock.refuse.clear();
  });

  test('an idle worker issues no statement for embeddings', async () => {
    await worker!.stop();
    await vectorRows.turnOff();
    const recorded = recordingDatabase();
    const idle = await startSearchVectors({ db: recorded.db, connectionString, env: url(mock), log: () => undefined });
    try {
      await waitFor(async () => (await counts()).queued === 0 && (await counts()).vectors > 0, 'the backfill', 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { sent } = await recorded.statements(() => new Promise((resolve) => setTimeout(resolve, 3000)));
      assert.deepEqual(sent.map((statement) => statement.text.slice(0, 80)), [], 'nothing is sent while the queue is empty');
    } finally {
      await idle.stop();
    }
    worker = null;
  });

  test('a worker started without FLUX_EMBEDDINGS_URL turns a former "on" off: every vector and the queue go', async () => {
    await vectorRows.turnOff();
    await vectorRows.turnOn('fake/bge-m3');
    assert.ok((await counts()).queued > 0, 'every row is queued');
    const off = await startSearchVectors({ db, connectionString, env: {}, log: () => undefined });
    await off.stop();
    assert.deepEqual(await counts(), { queued: 0, vectors: 0, model: null });
  });
});
