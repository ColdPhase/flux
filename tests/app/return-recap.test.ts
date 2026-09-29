import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { Conversation, Project, ReturnSummary, Workspace, WorkItem, WorkResult } from '@flux/contracts';
import type { ClientResponse } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// The private recap, "What matters" (issue #133), on top of #106's return view: whole project or
// only what concerns the reader, a chosen period, a stable snapshot (`until`) and the sourced
// digest behind "Summarize". Everything is still built from the reader's own audience with the
// final access check; nothing is shared, posted or notified.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

const post = (someone: Person, path: string, body: unknown) => someone.browser.request('POST', path, { body });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const recap = async (someone: Person, projectId: string, extra = '', status = 200) =>
  json<ReturnSummary>(await someone.browser.request('GET', `/api/v1/return?place=project&id=${projectId}${extra}`), status, `recap ${extra}`);
const save = async (someone: Person, projectId: string, mark: string | null) =>
  expectStatus(await someone.browser.request('PUT', '/api/v1/return-points', { body: { place: { type: 'project', id: projectId }, mark } }), 200, 'save');
const start = (someone: Person, projectId: string, body: string) =>
  post(someone, `/api/v1/projects/${projectId}/conversations`, { body, clientMessageId: randomUUID() }).then((response) => json<Conversation>(response, 201, 'start'));
const say = (someone: Person, conversationId: string, body: string) =>
  post(someone, `/api/v1/conversations/${conversationId}/messages`, { body, clientMessageId: randomUUID() }).then((response) => json<{ id: string }>(response, 201, 'reply'));
const texts = (summary: ReturnSummary) => summary.items.map((item) => item.text);

describe('private recap: scope, period, snapshot and digest (#133)', () => {
  let ari: Person;
  let nia: Person;
  let kai: Person;
  let olek: Person;
  let ws: Workspace;
  let lamp: Project;
  let hers: Conversation;
  let other: Conversation;
  let niaWork: WorkItem;

  before(async () => {
    [ari, nia, kai, olek] = await Promise.all(['Ari', 'Nia', 'Kai', 'Olek'].map(person));
    ws = await workspace(ari, 'Recap studio');
    for (const someone of [nia, kai, olek]) await addMember(ari, ws.id, someone, 'member');
    lamp = await createProject(ari, ws.id, 'Gesture lamp', 'restricted');
    await grant(ari, lamp.id, nia, 'contributor');
    await grant(ari, lamp.id, kai, 'contributor');
    hers = await start(nia, lamp.id, 'Camera or sensor for the lamp?');
    niaWork = json<WorkItem>(await post(ari, `/api/v1/projects/${lamp.id}/work`,
      { title: 'Measure the sensor at 5 lux', owner: { kind: 'human', id: nia.id } }), 201, 'work');
  });

  test('a first visit starts at the beginning of the project and says so', async () => {
    const first = await recap(nia, lamp.id);
    assert.equal(first.point.savedAt, null);
    assert.equal(first.since, null, 'from the beginning');
    assert.deepEqual([first.scope, first.period], ['all', 'last-visit']);
    assert.ok(texts(first).includes('Ari added a task for you: Measure the sensor at 5 lux'));
    await save(nia, lamp.id, first.mark);
    assert.deepEqual((await recap(nia, lamp.id)).items, [], 'nothing new after the saved point');
  });

  test('whole project or only what concerns me', async () => {
    other = await start(kai, lamp.id, 'Which enclosure colour do we print?');
    await say(ari, other.id, 'Grey, like the prototype.');
    await say(ari, hers.id, 'Nia, can you check the ToF at 5 lux? I think a sensor wins.');
    await say(kai, hers.id, 'I can lend you my ToF board.');
    const result = json<WorkResult>(await post(kai, `/api/v1/projects/${lamp.id}/results`,
      { title: 'ToF sees a hand at 30 cm', finding: 'positive', evidence: '18 of 20 at 5 lux', work: [niaWork.id] }), 201, 'result');
    const all = await recap(nia, lamp.id);
    const mine = await recap(nia, lamp.id, '&scope=mine');
    assert.equal(mine.scope, 'mine');
    assert.ok(texts(all).some((text) => text.includes('Which enclosure colour')), 'the whole project includes Kai’s other conversation');
    assert.ok(!texts(mine).some((text) => text.includes('Which enclosure colour')), 'relevant to me leaves it out');
    assert.ok(texts(mine).some((text) => text.startsWith('Ari asked you')), 'a question to me stays');
    assert.ok(mine.items.some((item) => item.source.type === 'result' && item.source.id === result.id), 'a result about my work stays');
    assert.equal(mine.needsYou, all.needsYou, 'what needs me is the same in both scopes');
    assert.deepEqual(mine.nextStep, all.nextStep);
  });

  test('a stable snapshot: `until` keeps what the reader is looking at', async () => {
    const shown = await recap(nia, lamp.id);
    await say(kai, other.id, 'Printed in grey, it fits.');
    const same = await recap(nia, lamp.id, `&scope=mine&until=${shown.mark}`);
    const again = await recap(nia, lamp.id, `&until=${shown.mark}`);
    assert.equal(again.mark, shown.mark, 'the mark stays that of the snapshot');
    assert.deepEqual(texts(again), texts(shown), 'a newer message does not change the snapshot');
    assert.ok(texts(same).length <= texts(shown).length);
    const newer = await recap(nia, lamp.id);
    assert.notEqual(newer.mark, shown.mark, 'without `until` the newest state is read');
    const bad = await nia.browser.request('GET', `/api/v1/return?place=project&id=${lamp.id}&until=${randomUUID()}`);
    assert.equal((bad.json as { code: string }).code, 'INVALID_MARK');
  });

  test('"Summarize" quotes whole messages per conversation and the recorded results', async () => {
    const plain = await recap(nia, lamp.id);
    assert.equal(plain.digest, undefined, 'only on request');
    const digest = (await recap(nia, lamp.id, '&digest=1')).digest!;
    const talk = digest.conversations.find((entry) => entry.conversationId === hers.id)!;
    assert.deepEqual(talk.quotes.map((quote) => [quote.author, quote.excerpt]), [
      ['Ari', 'Nia, can you check the ToF at 5 lux? I think a sensor wins.'], ['Kai', 'I can lend you my ToF board.'],
    ]);
    assert.equal(talk.opening, 'Camera or sensor for the lamp?');
    assert.ok(digest.conversations.some((entry) => entry.conversationId === other.id));
    assert.deepEqual(digest.results.map((entry) => [entry.title, entry.finding, entry.author]), [['ToF sees a hand at 30 cm', 'positive', 'Kai']]);
    assert.ok(digest.messages >= 4);
    const mine = (await recap(nia, lamp.id, '&scope=mine&digest=1')).digest!;
    assert.deepEqual(mine.conversations.map((entry) => entry.conversationId), [hers.id], 'only conversations that concern me');
    // Quotes of a long conversation: the latest three, and how many more there are.
    for (let index = 1; index <= 5; index++) await say(kai, other.id, `Print test ${index}`);
    const busy = (await recap(nia, lamp.id, '&digest=1')).digest!.conversations.find((entry) => entry.conversationId === other.id)!;
    assert.deepEqual(busy.quotes.map((quote) => quote.excerpt), ['Print test 3', 'Print test 4', 'Print test 5']);
    assert.ok(busy.more >= 3);
  });

  test('a chosen period ignores the return point; the start is reported', async () => {
    await save(nia, lamp.id, (await recap(nia, lamp.id)).mark);
    const visit = await recap(nia, lamp.id);
    assert.deepEqual(visit.items, [], 'nothing since the visit');
    const day = await recap(nia, lamp.id, '&from=24h');
    assert.equal(day.period, '24h');
    assert.ok(day.since && Math.abs(Date.parse(day.since) - (Date.now() - 86_400_000)) < 60_000, 'starts a day ago');
    assert.ok(day.items.length > 0, 'the last day is shown again on request');
    const week = await recap(nia, lamp.id, '&from=7d&scope=mine');
    assert.ok(week.items.length > 0);
    const stored = await pool.query('SELECT seq FROM return_points WHERE user_id = $1 AND place_key = $2', [nia.id, `project:${lamp.id}`]);
    await recap(nia, lamp.id, '&from=7d');
    const unchanged = await pool.query('SELECT seq FROM return_points WHERE user_id = $1 AND place_key = $2', [nia.id, `project:${lamp.id}`]);
    assert.deepEqual(unchanged.rows, stored.rows, 'reading a period never moves the point');
  });

  test('it stays private: per person, current access only, nothing shared', async () => {
    const count = "SELECT count(*)::int AS n FROM events WHERE workspace_id = $1";
    const before = await pool.query(count, [ws.id]);
    const niaView = await recap(nia, lamp.id, '&digest=1');
    const kaiView = await recap(kai, lamp.id, '&digest=1');
    assert.notDeepEqual(texts(niaView), texts(kaiView), 'each person has their own recap');
    assert.ok(!texts(kaiView).some((text) => text.startsWith('Ari asked you')), 'a question to Nia is not "asked you" for Kai');
    const after = await pool.query(count, [ws.id]);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, 'reading a recap records no shared event');
    const outsider = await olek.browser.request('GET', `/api/v1/return?place=project&id=${lamp.id}&digest=1`);
    assert.equal(outsider.status, 404);
    await grant(ari, lamp.id, kai, 'denied');
    const revoked = await kai.browser.request('GET', `/api/v1/return?place=project&id=${lamp.id}&digest=1`);
    assert.equal(revoked.status, 404, 'revoked access ends the recap');
    const home = json<ReturnSummary>(await kai.browser.request('GET', '/api/v1/return?place=home&from=7d&digest=1'), 200);
    assert.equal(JSON.stringify(home).includes('Gesture lamp'), false, 'nothing of the revoked project on Home either');
  });

  test('unknown scope or period is refused', async () => {
    for (const extra of ['&scope=team', '&from=30d', '&digest=yes']) {
      const response = await nia.browser.request('GET', `/api/v1/return?place=project&id=${lamp.id}${extra}`);
      assert.equal(response.status, 400, extra);
    }
  });
});
