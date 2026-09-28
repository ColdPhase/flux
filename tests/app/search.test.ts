import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { Conversation, Decision, Dm, Draft, Material, Project, SearchResponse, SearchResult, Sketch, CreatedThought, WorkItem, WorkResult, Workspace } from '@flux/contracts';
import { register, uniqueEmail, type ClientResponse } from './support/http.js';
import { addMember, draft as createDraft, expectStatus, grant, password, project as createProject, workspace, type Person } from './support/people.js';

// Search across Flux (issue #114): one query over project and direct messages, materials and
// their versions, work, decisions, results, sketches and thoughts, drafts and people. The access
// policy is applied in SQL before ranking, limits, counts and snippets, so nothing hidden ever
// shows, counts, or changes the work the database does.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;

interface Params { q: string; type?: string; place?: string; author?: string; cursor?: string; limit?: number }
const qs = (params: Params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
const searchRaw = (someone: Person, params: Params) => someone.browser.request('GET', `/api/v1/search?${qs(params)}`);
const search = async (someone: Person, params: Params | string) => json<SearchResponse>(await searchRaw(someone, typeof params === 'string' ? { q: params } : params), 200, 'search');
const explain = async (someone: Person, params: Params) => json<{ rows: number; nodes: string[] }>(await someone.browser.request('GET', `/api/v1/search/explain?${qs(params)}`), 200, 'explain');
/** A person with a full display name, as the search results show it. */
async function person(name: string): Promise<Person> {
  const email = uniqueEmail(name.toLowerCase().replace(/[^a-z]+/g, '-'));
  const { browser } = await register(email, password, name);
  const me = json<{ user: { id: string } }>(await browser.request('GET', '/api/v1/me'), 200, 'me');
  return { id: me.user.id, email, browser };
}
const text = (value: SearchResult['title'] | null) => (value ?? []).map((part) => part.text).join('');
const titles = (answer: SearchResponse) => answer.items.map((item) => text(item.title));
const kinds = (answer: SearchResponse) => answer.items.map((item) => item.kind).sort();

async function conversation(someone: Person, projectId: string, body: string) {
  return json<Conversation>(await post(someone, `/api/v1/projects/${projectId}/conversations`, { body, clientMessageId: randomUUID() }), 201, 'conversation');
}
async function say(someone: Person, conversationId: string, body: string) {
  return json<{ id: string }>(await post(someone, `/api/v1/conversations/${conversationId}/messages`, { body, clientMessageId: randomUUID() }), 201, 'message');
}
async function sketch(someone: Person, workspaceId: string, title: string, projectId?: string) {
  return json<Sketch>(await post(someone, `/api/v1/workspaces/${workspaceId}/sketches`, projectId ? { title, scope: 'project', projectId } : { title, scope: 'private' }), 201, 'sketch');
}
async function thought(someone: Person, sketchId: string, textValue: string, x = 0) {
  return json<CreatedThought>(await post(someone, `/api/v1/sketches/${sketchId}/thoughts`, { text: textValue, x, y: 0 }), 201, 'thought');
}
async function dm(someone: Person, workspaceId: string, others: Person[]) {
  const response = await post(someone, `/api/v1/workspaces/${workspaceId}/dms`, { participantIds: others.map((other) => other.id) });
  assert.ok(response.status === 201 || response.status === 200, response.text);
  return response.json as Dm;
}
async function dmSay(someone: Person, dmId: string, body: string) {
  return json<{ id: string }>(await post(someone, `/api/v1/dms/${dmId}/messages`, { body, clientMessageId: randomUUID() }), 201, 'dm message');
}

describe('search: one query across Flux, only what you may read', () => {
  let ari: Person; // owner
  let nia: Person; // member with a contributor grant on the restricted project and in the DM
  let olek: Person; // member without the grant, not in the DM
  let gus: Person; // guest
  let ws: Workspace;
  let lamp: Project; // restricted
  let open: Project; // workspace-visible
  let lampThread: Conversation;
  let material: Material;
  let work: WorkItem;
  let privateSketch: Sketch;
  let ariDraft: Draft;
  let niaDraft: Draft;
  let direct: Dm;

  before(async () => {
    [ari, nia, olek, gus] = await Promise.all(['Ari Nowak', 'Nia Berg', 'Olek Marsh', 'Gus Field'].map(person));
    ws = await workspace(ari, 'Studio');
    await addMember(ari, ws.id, nia, 'member');
    await addMember(ari, ws.id, olek, 'member');
    await addMember(ari, ws.id, gus, 'guest');
    lamp = await createProject(ari, ws.id, 'Gesture lamp', 'restricted');
    await grant(ari, lamp.id, nia, 'contributor');
    open = await createProject(ari, ws.id, 'Open notes', 'workspace');
    await grant(ari, open.id, gus, 'viewer');

    lampThread = await conversation(nia, lamp.id, 'Camera or sensor for the bedside lamp?');
    await say(ari, lampThread.id, 'The infrared sensor reacts at 5 lux in the hallway test.');
    material = json<Material>(await post(ari, `/api/v1/projects/${lamp.id}/materials`, {
      clientMutationId: randomUUID(), title: 'Sensor comparison', body: 'The capacitive option drifts with humidity.',
    }), 201, 'material');
    json(await patch(ari, `/api/v1/materials/${material.materialId}`, {
      clientMutationId: randomUUID(), expectedVersion: 1, body: 'The infrared option wins on battery life.',
    }), 200, 'material v2');
    work = json<WorkItem>(await post(nia, `/api/v1/projects/${lamp.id}/work`, { title: 'Test the infrared sensor at night', outcome: 'Numbers for the low-light case' }), 201, 'work');
    json<Decision>(await post(ari, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Use the infrared sensor', rationale: 'It passed the hallway test.' }), 201, 'decision');
    json<WorkResult>(await post(nia, `/api/v1/projects/${lamp.id}/results`, { title: 'Infrared sensor passed low light', finding: 'positive', evidence: 'Hallway log from Tuesday' }), 201, 'result');
    const lampSketch = await sketch(nia, ws.id, 'Lamp shapes', lamp.id);
    await thought(nia, lampSketch.id, 'Sensor hidden in the base');
    const openThread = await conversation(olek, open.id, 'The workshop is on Thursday, bring the sensor kit.');
    void openThread;
    privateSketch = await sketch(ari, ws.id, 'Ari private ideas');
    await thought(ari, privateSketch.id, 'Secret sensor pricing');
    ariDraft = await createDraft(ari, ws.id, 'Sensor shopping list', { body: 'Only for Ari' });
    niaDraft = await createDraft(nia, ws.id, 'Nia sensor notes', { body: 'Only for Nia' });
    direct = await dm(ari, ws.id, [nia]);
    await dmSay(ari, direct.id, 'Did the sensor arrive at your place?');
  });

  test('a contributor finds every kind she may read, with places, labels and exact targets', async () => {
    const answer = await search(nia, 'sensor');
    assert.deepEqual(kinds(answer), ['decision', 'dm_message', 'draft', 'material', 'message', 'message', 'message', 'result', 'thought', 'work'].sort());
    const byKind = (kind: string) => answer.items.filter((item) => item.kind === kind);
    const materialHit = byKind('material')[0]!;
    assert.equal(text(materialHit.title), 'Sensor comparison');
    assert.equal(materialHit.label, 'Material · version 2, current');
    assert.deepEqual(materialHit.target, { type: 'material', projectId: lamp.id, materialId: material.materialId, version: 2 });
    assert.deepEqual(materialHit.place, { type: 'project', id: lamp.id, name: 'Gesture lamp' });
    const dmHit = byKind('dm_message')[0]!;
    assert.deepEqual(dmHit.place, { type: 'dm', id: direct.id, name: 'Ari Nowak' });
    assert.equal(dmHit.label, 'Direct message');
    assert.equal(dmHit.author, 'Ari Nowak');
    assert.deepEqual(dmHit.target, { type: 'dm_message', dmId: direct.id, messageId: (dmHit.target as { messageId: string }).messageId });
    const workHit = byKind('work')[0]!;
    assert.equal(workHit.label, 'Task');
    assert.deepEqual(workHit.target, { type: 'work', projectId: lamp.id, id: work.id });
    assert.equal(text(workHit.snippet), 'Numbers for the low-light case');
    assert.equal(byKind('thought')[0]!.label, 'Thought in “Lamp shapes”');
    assert.equal(byKind('draft')[0]!.label, 'Private draft');
    assert.deepEqual(byKind('draft')[0]!.target, { type: 'draft', draftId: niaDraft.id });
    assert.equal(byKind('decision')[0]!.label, 'Decision · proposed');
    assert.equal(byKind('result')[0]!.label, 'Result · it worked');
    // The matched word is marked, never as markup.
    const message = answer.items.find((item) => text(item.title).includes('5 lux'))!;
    assert.ok(message.title.some((part) => part.match && /sensor/i.test(part.text)), 'the match is highlighted');
    assert.deepEqual(message.target, { type: 'message', projectId: lamp.id, conversationId: lampThread.id, messageId: (message.target as { messageId: string }).messageId });
    assert.equal(answer.counts.message, 4, 'project and direct messages');
    assert.equal(answer.counts.material, 1, 'two matching versions are one material');
    assert.equal(answer.next, null);
    for (const hidden of ['Ari private ideas', 'Secret sensor pricing', 'Sensor shopping list', ariDraft.id, privateSketch.id]) assert.equal(JSON.stringify(answer).includes(hidden), false, hidden);
  });

  test('a member outside the restricted project and the DM finds only the open project, and nothing hints at the rest', async () => {
    const answer = await search(olek, 'sensor');
    assert.deepEqual(titles(answer), ['The workshop is on Thursday, bring the sensor kit.']);
    assert.deepEqual(answer.counts, { message: 1 });
    assert.equal(answer.countsCapped, false);
    assert.equal(answer.next, null);
    const body = JSON.stringify(answer);
    for (const hidden of ['Gesture lamp', lamp.id, 'infrared', 'Sensor comparison', direct.id, 'arrive', 'Nia sensor notes', 'Secret sensor']) assert.equal(body.includes(hidden), false, hidden);
    // Filtering by a place he cannot see is the same as a place without matches.
    assert.deepEqual(await search(olek, { q: 'sensor', place: `project:${lamp.id}` }), { items: [], next: null, counts: {}, countsCapped: false });
    assert.deepEqual(await search(olek, { q: 'sensor', place: `dm:${direct.id}` }), { items: [], next: null, counts: {}, countsCapped: false });
  });

  test('private drafts and sketches reach only their author; owners do not see other people’s private drafts or DMs they are not in', async () => {
    const answer = await search(ari, 'sensor');
    const found = titles(answer);
    assert.ok(found.includes('Secret sensor pricing'), 'own private thought');
    assert.ok(found.includes('Sensor shopping list'), 'own private draft');
    assert.equal(found.includes('Nia sensor notes'), false, 'not another person’s private draft');
    const privateHits = await search(ari, { q: 'sensor', place: 'private' });
    assert.deepEqual(titles(privateHits).sort(), ['Secret sensor pricing', 'Sensor shopping list']);
    assert.ok(privateHits.items.every((item) => item.place.type === 'private'));
    // A group DM without Ari stays invisible to the workspace owner.
    const side = await dm(nia, ws.id, [olek, gus]);
    await dmSay(nia, side.id, 'A sensor surprise for Ari’s birthday');
    assert.equal(titles(await search(ari, 'birthday')).length, 0);
    assert.deepEqual(titles(await search(olek, 'birthday')), ['A sensor surprise for Ari’s birthday']);
  });

  test('people are found by name by those who may read the members, and a person filters by author', async () => {
    const people = await search(olek, { q: 'Nia', type: 'person' });
    assert.equal(people.items.length, 1);
    assert.equal(people.items[0]!.label, 'Person');
    assert.deepEqual(people.items[0]!.target, { type: 'person', userId: nia.id, workspaceId: ws.id });
    assert.deepEqual(people.items[0]!.place, { type: 'workspace', id: ws.id, name: 'Studio' });
    assert.equal((await search(gus, { q: 'Nia', type: 'person' })).items.length, 0, 'a guest cannot read the member list');
    const byNia = await search(ari, { q: 'sensor', author: `human:${nia.id}` });
    assert.ok(byNia.items.length > 0);
    assert.ok(byNia.items.every((item) => item.author === 'Nia Berg'), 'only Nia’s writing');
  });

  test('type filters narrow results while counts cover every type', async () => {
    const answer = await search(nia, { q: 'sensor', type: 'material' });
    assert.deepEqual(kinds(answer), ['material']);
    assert.equal(answer.counts.material, 1);
    assert.ok((answer.counts.message ?? 0) >= 4);
    assert.equal(answer.counts.sketch, 1);
    const sketches = await search(nia, { q: 'sensor', type: 'sketch' });
    assert.deepEqual(kinds(sketches), ['thought']);
    assert.equal((await searchRaw(nia, { q: 'sensor', type: 'secrets' })).status, 400);
    assert.equal((await searchRaw(nia, { q: 'sensor', place: 'project:not-a-uuid' })).status, 400);
    assert.equal((await searchRaw(nia, { q: '' })).status, 400);
    assert.equal((await searchRaw(nia, { q: 'x'.repeat(201) })).status, 400);
  });

  test('an edit is searchable at once, and an old material version is still found at the version it was', async () => {
    const before = await search(nia, 'night');
    assert.deepEqual(titles(before), ['Test the infrared sensor at night']);
    json(await patch(nia, `/api/v1/work/${work.id}`, { title: 'Test the infrared sensor at dawn', expectedVersion: work.version }), 200, 'rename work');
    assert.deepEqual(titles(await search(nia, 'night')), []);
    assert.deepEqual(titles(await search(nia, 'dawn')), ['Test the infrared sensor at dawn']);
    const old = await search(nia, 'humidity');
    assert.equal(old.items.length, 1);
    assert.equal(old.items[0]!.label, 'Material · version 1 of 2');
    assert.deepEqual(old.items[0]!.target, { type: 'material', projectId: lamp.id, materialId: material.materialId, version: 1 });
    assert.ok(old.items[0]!.snippet?.some((part) => part.match && part.text.toLowerCase() === 'humidity'));
  });

  test('docs are found at the version that matched, as drafts or published, only by project readers', async () => {
    const created = json<{ id: string; version: number }>(await post(ari, `/api/v1/projects/${lamp.id}/docs`, {
      title: 'Lamp wiring guide', body: 'Solder the dimmer before the brass fitting.', state: 'draft',
    }), 201, 'doc');
    const draftHit = await search(nia, 'dimmer');
    assert.equal(draftHit.items.length, 1);
    assert.equal(draftHit.items[0]!.kind, 'doc');
    assert.equal(draftHit.items[0]!.label, 'Doc · draft');
    assert.deepEqual(draftHit.items[0]!.target, { type: 'doc', projectId: lamp.id, docId: created.id, version: 1 });
    json(await patch(ari, `/api/v1/docs/${created.id}`, { body: 'Fit the brass collar first, then the switch.', state: 'published' },
      { 'if-match': `"${created.version}"` }), 200, 'publish doc');
    const published = await search(nia, 'collar');
    assert.equal(published.items[0]!.label, 'Doc · published');
    assert.deepEqual(published.items[0]!.target, { type: 'doc', projectId: lamp.id, docId: created.id, version: 2 });
    const old = await search(nia, 'dimmer');
    assert.equal(old.items[0]!.label, 'Doc · version 1 of 2, draft', 'the old text is found at its own version');
    const both = await search(nia, 'brass');
    assert.equal(both.items.filter((item) => item.kind === 'doc').length, 1, 'one result per doc');
    assert.equal(both.counts.doc, 1);
    assert.deepEqual((await search(olek, 'brass')).items, [], 'not outside the project');
    assert.deepEqual(kinds(await search(nia, { q: 'brass', type: 'doc' })), ['doc']);
  });

  test('revoking access removes results on the very next search, and leaving a DM removes its messages', async () => {
    assert.ok((await search(nia, 'infrared')).items.length >= 4);
    await grant(ari, lamp.id, nia, 'denied');
    const denied = await search(nia, 'infrared');
    assert.deepEqual(denied.items, []);
    assert.deepEqual(denied.counts, {});
    await grant(ari, lamp.id, nia, 'contributor');
    assert.ok((await search(nia, 'infrared')).items.length >= 4, 'restored');
    const third = await dm(olek, ws.id, [nia]);
    await dmSay(olek, third.id, 'The walnut veneer quote came back');
    assert.equal((await search(nia, 'walnut')).items.length, 1);
    expectStatus(await nia.browser.request('POST', `/api/v1/dms/${third.id}/leave`), 204);
    assert.equal((await search(nia, 'walnut')).items.length, 0);
    assert.equal((await search(olek, 'walnut')).items.length, 1, 'still there for the remaining participant');
  });

  test('ranking: a title match comes before a mention in a body; typing a prefix already finds it', async () => {
    const answer = await search(nia, 'comparison');
    assert.equal(text(answer.items[0]!.title), 'Sensor comparison');
    const typing = await search(nia, 'compar');
    assert.equal(text(typing.items[0]!.title), 'Sensor comparison');
    const typo = await search(nia, 'comparisn');
    assert.ok(titles(typo).includes('Sensor comparison'), 'trigram matching tolerates typos in titles');
  });

  test('queries are data: operators, quotes and SQL never break or widen the search', async () => {
    const attempts = [
      "'); DROP TABLE search_documents; --", 'sensor:* & !lamp', '"unbalanced', '\\', '%_%', '<script>alert(1)</script>',
      'sensor | lamp', 'sensor or lamp', '-sensor', '((((', '⦃sensor⦄', 'ąęłńóśźż 中文 🙂', "sensor' OR '1'='1",
    ];
    for (const q of attempts) {
      const response = await searchRaw(olek, { q });
      assert.equal(response.status, 200, `${q}: ${response.text}`);
      const body = JSON.stringify(response.json);
      for (const hidden of ['Gesture lamp', 'infrared', 'Secret sensor']) assert.equal(body.includes(hidden), false, `${q} leaks ${hidden}`);
    }
    const phrase = await search(nia, '"hallway test"');
    assert.ok(phrase.items.length >= 1);
    const excluded = await search(nia, 'sensor -infrared');
    assert.ok(excluded.items.every((item) => !JSON.stringify(item).toLowerCase().includes('infrared')));
    const table = await pool.query("SELECT to_regclass('search_documents') AS name");
    assert.equal(table.rows[0]!.name, 'search_documents');
  });

  test('pages follow a sealed cursor: no repeats, no gaps, and a cursor works only for its reader and query', async () => {
    const thread = await conversation(olek, open.id, 'Pagination kickoff');
    for (let start = 0; start < 25; start += 5)
      await Promise.all(Array.from({ length: 5 }, (_, index) => say(olek, thread.id, `Pagination entry ${start + index + 1}`)));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await search(nia, { q: 'pagination', limit: 10, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next ?? undefined;
      pages += 1;
      if (cursor) {
        assert.equal((await searchRaw(olek, { q: 'pagination', limit: 10, cursor })).status, 400, 'another reader');
        assert.equal((await searchRaw(nia, { q: 'pagination entry', limit: 10, cursor })).status, 400, 'another query');
        assert.equal((await searchRaw(nia, { q: 'pagination', type: 'message', limit: 10, cursor })).status, 400, 'another filter');
      }
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 26);
    assert.equal(new Set(seen).size, 26, 'no repeats');
    const forged = await searchRaw(nia, { q: 'pagination', cursor: 's1.' + 'A'.repeat(60) });
    assert.equal(forged.status, 400);
    assert.equal((forged.json as { code: string }).code, 'CURSOR_INVALID');
  });
});

describe('search: hidden matches never change the answer or the work', () => {
  test('hundreds of hidden matches give the same results, counts, `more` and rows examined', async () => {
    const [ari, nia, olek] = await Promise.all(['Ari Hidden', 'Nia Hidden', 'Olek Hidden'].map(person));
    const ws = await workspace(ari, 'Saturation studio');
    await addMember(ari, ws.id, nia, 'member');
    await addMember(ari, ws.id, olek, 'member');
    // Every place that will hold hidden matches exists before the baseline: the audiences are the same.
    const secret = await createProject(ari, ws.id, 'Secret launch', 'restricted');
    await grant(ari, secret.id, nia, 'contributor');
    const hiddenThread = await conversation(ari, secret.id, 'Launch plan');
    const hiddenSketch = await sketch(ari, ws.id, 'Ari private board');
    const privateDm = await dm(ari, ws.id, [nia]);
    const open = await createProject(ari, ws.id, 'Open notes', 'workspace');
    const openThread = await conversation(ari, open.id, 'Welcome to the open notes');
    await say(ari, openThread.id, 'The prototype review is on Thursday.');
    await say(nia, openThread.id, 'Prototype photos are in the shared folder.');

    const query = { q: 'prototype', limit: 5 };
    const median = async () => {
      const samples: number[] = [];
      for (let i = 0; i < 9; i += 1) { const started = performance.now(); await search(olek, query); samples.push(performance.now() - started); }
      return samples.sort((a, b) => a - b)[4]!;
    };
    // Writes leave dead row versions in the audience tables (a DM's or sketch's activity time
    // changes with every message or thought) until autovacuum removes them. That is write load,
    // not matching, so both measurements start from a vacuumed state.
    const settle = () => pool.query('VACUUM ANALYZE search_documents, projects, dms, dm_participants, sketches, drafts');
    await settle();
    const baseline = await search(olek, query);
    const baselineWork = await explain(olek, query);
    const baselineTime = await median();
    assert.equal(baseline.items.length, 2);

    for (let start = 0; start < 300; start += 25)
      await Promise.all(Array.from({ length: 25 }, (_, index) => say(ari, hiddenThread.id, `Prototype launch step ${start + index + 1}`)));
    for (let start = 0; start < 100; start += 25)
      await Promise.all(Array.from({ length: 25 }, (_, index) => thought(ari, hiddenSketch.id, `Prototype idea ${start + index + 1}`, (start + index) * 200)));
    for (let start = 0; start < 60; start += 20)
      await Promise.all(Array.from({ length: 20 }, (_, index) => dmSay(ari, privateDm.id, `Prototype secret ${start + index + 1}`)));
    const hidden = await pool.query("SELECT count(*)::int AS n FROM search_documents WHERE workspace_id = $1 AND tsv @@ to_tsquery('simple', 'prototype')", [ws.id]);
    assert.ok(hidden.rows[0]!.n > 450, 'hundreds of matches the reader cannot see');
    await settle();

    const saturated = await search(olek, query);
    assert.deepEqual(saturated, baseline, 'identical answer, counts and `next`');
    assert.equal(saturated.next, null, 'hidden matches never make `more` true');
    const saturatedWork = await explain(olek, query);
    assert.equal((await explain(olek, query)).rows, saturatedWork.rows, 'the metric is deterministic');
    assert.equal(saturatedWork.rows, baselineWork.rows,
      `rows examined do not grow with hidden matches (before: ${baselineWork.nodes.join(', ')}; after: ${saturatedWork.nodes.join(', ')})`);
    // The reader who can see them does get them, with `more` and a count.
    const insider = await search(nia, query);
    assert.ok(insider.next, 'Nia has more pages');
    assert.ok((insider.counts.message ?? 0) > 300);
    // Coarse timing: the hidden matches do not slow the outsider's search.
    const saturatedTime = await median();
    assert.ok(saturatedTime < baselineTime * 2 + 25, `median ${saturatedTime.toFixed(1)} ms with hidden matches vs ${baselineTime.toFixed(1)} ms before`);
  });
});
