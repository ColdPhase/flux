import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, Decision, Doc, Project, ReturnPlace, ReturnPoint, ReturnSummary, Workspace, WorkItem, WorkResult } from '@flux/contracts';
import { pool } from './support/db.js';
import type { ClientResponse } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// The return view, "Since you left" (issue #106): server-side return points per person and
// place, a summary built only from the reader's own event audience after the point (plus the
// final access check), human-language grouping with source links, one next step with its
// reason, and nothing about places the reader cannot currently see.


const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const query = (place: ReturnPlace) => place.type === 'home' ? 'place=home' : `place=${place.type}&id=${place.id}`;
const summary = async (someone: Person, place: ReturnPlace) => json<ReturnSummary>(await someone.browser.request('GET', `/api/v1/return?${query(place)}`), 200, `summary ${place.type}`);
const save = async (someone: Person, place: ReturnPlace, mark: string | null) =>
  json<ReturnPoint>(await someone.browser.request('PUT', '/api/v1/return-points', { body: { place, mark } }), 200, 'save point');
/** Views a place: reads its summary, then saves the point at what was shown. */
const view = async (someone: Person, place: ReturnPlace) => { const seen = await summary(someone, place); await save(someone, place, seen.mark); return seen; };
const say = (someone: Person, conversationId: string, body: string) =>
  post(someone, `/api/v1/conversations/${conversationId}/messages`, { body, clientMessageId: randomUUID() }).then((response) => json(response, 201, 'reply'));
const texts = (items: ReturnSummary['items']) => items.map((item) => item.text);

describe('return view: since you left', () => {
  let ari: Person;
  let nia: Person;
  let outsider: Person;
  let ws: Workspace;
  let lamp: Project;
  let thread: Conversation;

  before(async () => {
    [ari, nia, outsider] = await Promise.all(['Ari', 'Nia', 'Olek'].map(person));
    ws = await workspace(ari, 'Studio');
    await addMember(ari, ws.id, nia, 'member');
    await addMember(ari, ws.id, outsider, 'member');
    lamp = await createProject(ari, ws.id, 'Gesture lamp', 'restricted');
    await grant(ari, lamp.id, nia, 'contributor');
    thread = json<Conversation>(await post(nia, `/api/v1/projects/${lamp.id}/conversations`,
      { body: 'Camera or sensor for the lamp?', clientMessageId: randomUUID() }), 201);
  });

  test('a place never viewed has no return point; viewing saves one on the server', async () => {
    const first = await summary(nia, { type: 'project', id: lamp.id });
    assert.equal(first.point.savedAt, null);
    assert.deepEqual(first.items, []);
    assert.equal(first.nextStep, null);
    assert.ok(first.mark, 'the reader has audience rows, so there is a mark');
    const saved = await save(nia, { type: 'project', id: lamp.id }, first.mark);
    assert.ok(saved.savedAt);
    const row = await pool.query('SELECT place_type, project_id, seq FROM return_points WHERE user_id = $1 AND place_key = $2', [nia.id, `project:${lamp.id}`]);
    assert.equal(row.rows[0]?.place_type, 'project');
    assert.equal(row.rows[0]?.project_id, lamp.id);
    await view(nia, { type: 'home' });
    await view(ari, { type: 'home' });
    await view(outsider, { type: 'home' });

    // A mark must be one of the reader's own audience positions.
    const bad = await nia.browser.request('PUT', '/api/v1/return-points', { body: { place: { type: 'home' }, mark: randomUUID() } });
    assert.equal((bad.json as { code: string }).code, 'INVALID_MARK');
    const own = (await pool.query("SELECT event_id FROM event_audience WHERE recipient = $1 ORDER BY seq DESC LIMIT 1", [`human:${ari.id}`])).rows[0]!.event_id as string;
    const hidden = (await pool.query("SELECT e.id FROM events e WHERE NOT EXISTS (SELECT 1 FROM event_audience a WHERE a.event_id = e.id AND a.recipient = $1) AND e.object_id = $2 LIMIT 1", [`human:${outsider.id}`, lamp.id])).rows[0]!.id as string;
    assert.ok(own);
    const foreign = await outsider.browser.request('PUT', '/api/v1/return-points', { body: { place: { type: 'home' }, mark: hidden } });
    assert.equal((foreign.json as { code: string }).code, 'INVALID_MARK', 'another reader\'s event is not a valid mark');
    // Invisible places are not found, exactly like missing ones.
    const invisible = await outsider.browser.request('GET', `/api/v1/return?place=project&id=${lamp.id}`);
    const missing = await outsider.browser.request('GET', `/api/v1/return?place=project&id=${randomUUID()}`);
    assert.deepEqual([invisible.status, missing.status], [404, 404]);
    assert.deepEqual([(invisible.json as { code: string }).code, (missing.json as { code: string }).code], ['PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND']);
    const conversation = await outsider.browser.request('GET', `/api/v1/return?place=conversation&id=${thread.id}`);
    assert.equal((conversation.json as { code: string }).code, 'CONVERSATION_NOT_FOUND');
  });

  test('changes are grouped in human language, each links to its source, and one next step has a reason', async () => {
    const reply = json<{ id: string }>(await post(ari, `/api/v1/conversations/${thread.id}/messages`,
      { body: 'Nia, can you check the camera at 5 lux before Friday?', clientMessageId: randomUUID() }), 201);
    await say(ari, thread.id, 'I also ordered a PIR sensor.');
    const rule = json<Decision>(await post(ari, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Use the camera', rationale: 'It sees gestures' }), 201);
    json(await post(ari, `/api/v1/decisions/${rule.id}/accept`, {}, { 'if-match': '"1"' }), 200);
    const pivot = json<Decision>(await post(ari, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Use a PIR sensor', supersedes: rule.id }), 201);
    json(await post(ari, `/api/v1/decisions/${pivot.id}/accept`, {}, { 'if-match': '"1"' }), 200);
    const task = json<WorkItem>(await post(ari, `/api/v1/projects/${lamp.id}/work`, { title: 'Mount the PIR sensor', owner: { kind: 'human', id: nia.id } }), 201);
    const blocked = json<WorkItem>(await post(ari, `/api/v1/projects/${lamp.id}/work`, { title: 'Order the lens' }), 201);
    json(await patch(ari, `/api/v1/work/${blocked.id}`, { status: 'blocked' }, { 'if-match': '"1"' }), 200);
    const result = json<WorkResult>(await post(ari, `/api/v1/projects/${lamp.id}/results`,
      { title: 'Camera misses gestures at 5 lux', finding: 'negative', work: [task.id] }), 201);
    const material = json<{ materialId: string }>(await post(ari, `/api/v1/projects/${lamp.id}/materials`, { clientMutationId: randomUUID(), title: 'Low-light test plan', body: '5 lux, 20 gestures' }), 201);
    const sketch = json<{ id: string }>(await post(ari, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Sensing options', scope: 'project', projectId: lamp.id }), 201);
    const secret = json<{ id: string }>(await post(ari, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Ari private ideas', scope: 'private' }), 201);

    const back = await summary(nia, { type: 'project', id: lamp.id });
    const list = texts(back.items);
    assert.ok(back.point.savedAt);
    assert.ok(list.includes('Ari asked you: “Nia, can you check the camera at 5 lux before Friday?”'), list.join('\n'));
    assert.ok(list.includes('Ari replied in “Camera or sensor for the lamp?”'), 'other messages are grouped per conversation');
    const changed = back.items.find((item) => item.text === 'Current rule changed: Use a PIR sensor')!;
    assert.equal(changed.detail, 'Previously: Use the camera · No reason was recorded.', 'the previous rule, and a missing reason is said');
    assert.ok(list.includes('Ari added a task for you: Mount the PIR sensor'));
    const lens = back.items.find((item) => item.text === 'Blocked: Order the lens')!;
    assert.equal(lens.detail, 'No reason was recorded.');
    const recorded = back.items.find((item) => item.kind === 'result')!;
    assert.equal(recorded.text, 'Ari recorded a result: Camera misses gestures at 5 lux');
    assert.equal(recorded.detail, 'It did not work out, about “Mount the PIR sensor” · No evidence was recorded.');
    assert.ok(list.includes('New material: Low-light test plan'));
    assert.ok(list.includes('Ari started a sketch: Sensing options'));
    assert.equal(JSON.stringify(back).includes(secret.id), false, 'a private sketch of someone else never appears');
    assert.equal(JSON.stringify(back).includes('Ari private ideas'), false);
    // The result, linked to Nia's task, also opened that task's own thread with its title as the first contribution (#154).
    assert.ok(list.includes('Ari started “Camera misses gestures at 5 lux”'), list.join('\n'));
    assert.equal(list.length, 9, list.join('\n'));

    // Every item links to its source.
    const sources = new Map(back.items.map((item) => [item.text, item.source]));
    assert.deepEqual(sources.get('Ari asked you: “Nia, can you check the camera at 5 lux before Friday?”'), { type: 'message', projectId: lamp.id, conversationId: thread.id, messageId: reply.id });
    assert.deepEqual(changed.source, { type: 'decision', id: pivot.id, projectId: lamp.id });
    assert.deepEqual(recorded.source, { type: 'result', id: result.id, projectId: lamp.id });
    assert.deepEqual(sources.get('New material: Low-light test plan'), { type: 'material', projectId: lamp.id, materialId: material.materialId, version: 1 });
    assert.deepEqual(sources.get('Ari started a sketch: Sensing options'), { type: 'sketch', sketchId: sketch.id, projectId: lamp.id });
    for (const item of back.items) assert.deepEqual(item.project, { id: lamp.id, name: 'Gesture lamp' });

    // What needs Nia comes first; the counts are only of what she can see.
    assert.deepEqual(back.items.filter((item) => item.needsYou).map((item) => item.kind).sort(), ['question', 'result', 'work']);
    assert.equal(back.needsYou, 3);
    assert.ok(back.items.slice(0, 3).every((item) => item.needsYou));
    assert.deepEqual(back.nextStep && [back.nextStep.text, back.nextStep.reason, back.nextStep.item],
      ['Answer Ari\'s question', '“Nia, can you check the camera at 5 lux before Friday?” Ari asked you in “Camera or sensor for the lamp?”.', `message:${reply.id}`]);

    // Ari's own changes are never "since you left" for Ari.
    const own = await summary(ari, { type: 'home' });
    assert.deepEqual(own.items, []);

    // Home shows the same changes across places, named by project.
    const home = await summary(nia, { type: 'home' });
    assert.deepEqual(texts(home.items).sort(), [...list].sort());

    // The next step follows real state: once Nia answers, the result about her work is next.
    await say(nia, thread.id, 'Checked it: the camera fails at 5 lux.');
    const later = await summary(nia, { type: 'project', id: lamp.id });
    assert.equal(later.items.some((item) => item.kind === 'question'), false, 'an answered question no longer needs you');
    assert.deepEqual(later.nextStep && [later.nextStep.text, later.nextStep.reason],
      ['Review the result Ari attached', 'It reports on “Mount the PIR sensor”, which is yours.']);

    // A proposed rule needs a person who can write; the proposer and viewers are not asked.
    const proposal = json<Decision>(await post(ari, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Dim the lamp at night', rationale: 'Less glare' }), 201);
    const withProposal = await summary(nia, { type: 'project', id: lamp.id });
    const proposed = withProposal.items.find((item) => item.source.type === 'decision' && item.source.id === proposal.id)!;
    assert.deepEqual([proposed.text, proposed.detail, proposed.needsYou], ['Proposed rule: Dim the lamp at night', 'Ari proposed it', true]);
  });

  test('doc changes (#112) are one item in human language that opens what changed', async () => {
    const place = { type: 'project' as const, id: lamp.id };
    await view(nia, place);
    const doc = json<Doc>(await post(ari, `/api/v1/projects/${lamp.id}/docs`, { title: 'Lamp wiring', body: 'Mains to the driver.' }), 201);
    const started = (await summary(nia, place)).items.filter((item) => item.kind === 'doc');
    assert.deepEqual(started.map((item) => [item.text, item.detail, item.needsYou]), [['Ari started a doc: Lamp wiring', null, false]]);
    assert.deepEqual(started[0]!.source, { type: 'doc', projectId: lamp.id, docId: doc.id, version: 1, since: null });
    await view(nia, place);
    json(await patch(ari, `/api/v1/docs/${doc.id}`, { body: 'Mains to the 24 V driver.', reason: 'Named the driver' }, { 'if-match': '"1"' }), 200);
    json(await patch(ari, `/api/v1/docs/${doc.id}`, { state: 'published' }, { 'if-match': '"2"' }), 200);
    const updated = (await summary(nia, place)).items.filter((item) => item.kind === 'doc');
    assert.deepEqual(updated.map((item) => [item.text, item.detail]), [['Doc updated: Lamp wiring', '2 new versions by Ari · latest: Published']]);
    assert.deepEqual(updated[0]!.source, { type: 'doc', projectId: lamp.id, docId: doc.id, version: 3, since: 1 });
    // A person's own edits are not news to them.
    assert.equal((await summary(ari, place)).items.some((item) => item.kind === 'doc'), false);
  });

  test('saving moves the point forward only; the person may move it back once', async () => {
    const place = { type: 'project' as const, id: lamp.id };
    const seen = await summary(nia, place);
    assert.ok(seen.items.length > 0);
    const saved = await save(nia, place, seen.mark);
    assert.equal(saved.canRestore, true);
    assert.deepEqual((await summary(nia, place)).items, [], 'nothing new since the saved point');
    // An older mark never moves the point back.
    const oldest = (await pool.query('SELECT event_id FROM event_audience WHERE recipient = $1 ORDER BY seq ASC LIMIT 1', [`human:${nia.id}`])).rows[0]!.event_id as string;
    await save(nia, place, oldest);
    assert.deepEqual((await summary(nia, place)).items, []);
    const restored = json<ReturnPoint>(await post(nia, '/api/v1/return-points/restore', { place }), 200);
    assert.equal(restored.canRestore, false);
    // A point first saved in the visit being undone is removed: the place is unviewed again.
    const talk = { type: 'conversation' as const, id: thread.id };
    assert.ok((await save(nia, talk, seen.mark)).savedAt);
    assert.equal(json<ReturnPoint>(await post(nia, '/api/v1/return-points/restore', { place: talk }), 200).savedAt, null);
    assert.deepEqual(texts((await summary(nia, place)).items).sort(), texts(seen.items).sort(), 'the same changes show again');
    // Home counts a project as seen once its own point has passed a change.
    await view(nia, place);
    assert.deepEqual((await summary(nia, { type: 'home' })).items, []);
  });

  test('revoked access removes items; a restricted project leaks nothing to an outsider', async () => {
    await view(nia, { type: 'home' });
    await view(outsider, { type: 'home' });
    const open = await createProject(ari, ws.id, 'Open notes', 'workspace');
    const openThread = json<Conversation>(await post(ari, `/api/v1/projects/${open.id}/conversations`, { body: 'Welcome to the open notes', clientMessageId: randomUUID() }), 201);
    await say(ari, thread.id, 'Nia, did the PIR arrive?');
    json(await post(ari, `/api/v1/projects/${lamp.id}/work`, { title: 'Secret restricted task', owner: { kind: 'human', id: nia.id } }), 201);

    const outsiderHome = await summary(outsider, { type: 'home' });
    assert.deepEqual(outsiderHome.items.map((item) => item.project?.id), [open.id], 'only the place the outsider can see');
    assert.equal(outsiderHome.needsYou, 0);
    const body = JSON.stringify(outsiderHome);
    for (const hidden of [lamp.id, 'Gesture lamp', 'Secret restricted task', 'PIR', thread.id]) assert.equal(body.includes(hidden), false, `no hint of ${hidden}`);
    assert.equal(outsiderHome.more, false);
    assert.equal(outsiderHome.items[0]!.text, 'Ari started “Welcome to the open notes”');
    assert.deepEqual(outsiderHome.items[0]!.source, { type: 'message', projectId: open.id, conversationId: openThread.id, messageId: openThread.messages[0]!.id });

    const before = await summary(nia, { type: 'home' });
    assert.ok(before.items.some((item) => item.project?.id === lamp.id));
    await grant(ari, lamp.id, nia, 'denied');
    const after = await summary(nia, { type: 'home' });
    assert.deepEqual(after.items.map((item) => item.project?.id), [open.id], 'revoked items disappear');
    assert.equal(JSON.stringify(after).includes('Gesture lamp'), false);
    assert.equal(after.nextStep, null);
    assert.equal((await nia.browser.request('GET', `/api/v1/return?place=project&id=${lamp.id}`)).status, 404);
    assert.equal((await nia.browser.request('PUT', '/api/v1/return-points', { body: { place: { type: 'project', id: lamp.id }, mark: null } })).status, 404);
  });
});

describe('return view: hidden rows never hint at anything', () => {
  test('hundreds of now-hidden audience rows give the same summary as never having had them', async () => {
    const [ari, nia, olek] = await Promise.all(['Ari', 'Nia', 'Olek'].map(person));
    const ws = await workspace(ari, 'Saturation studio');
    await addMember(ari, ws.id, nia, 'member');
    await addMember(ari, ws.id, olek, 'member');
    const secret = await createProject(ari, ws.id, 'Secret launch', 'restricted');
    await grant(ari, secret.id, nia, 'contributor');
    const hiddenThread = json<Conversation>(await post(ari, `/api/v1/projects/${secret.id}/conversations`, { body: 'Launch plan', clientMessageId: randomUUID() }), 201);
    for (const someone of [nia, olek]) await view(someone, { type: 'home' });

    // More than one page (400) of Nia's audience rows, in a place she will lose.
    for (let start = 0; start < 450; start += 25)
      await Promise.all(Array.from({ length: 25 }, (_, index) => say(ari, hiddenThread.id, `Launch step ${start + index + 1}`)));
    const open = await createProject(ari, ws.id, 'Open notes', 'workspace');
    const openThread = json<Conversation>(await post(ari, `/api/v1/projects/${open.id}/conversations`, { body: 'Welcome to the open notes', clientMessageId: randomUUID() }), 201);
    await say(ari, openThread.id, 'The workshop is on Thursday.');
    const rows = await pool.query('SELECT count(*)::int AS n FROM event_audience ea JOIN events e ON e.id = ea.event_id WHERE ea.recipient = $1 AND e.object_id = $2', [`human:${nia.id}`, secret.id]);
    assert.ok(rows.rows[0]!.n > 400, 'the hidden rows are more than one scan page');
    await grant(ari, secret.id, nia, 'denied');

    const shape = (summary: ReturnSummary) => ({ items: summary.items.map(({ text, detail, needsYou, kind, source, project }) => ({ text, detail, needsYou, kind, source, project })),
      needsYou: summary.needsYou, more: summary.more, nextStep: summary.nextStep });
    const hers = await summary(nia, { type: 'home' });
    const his = await summary(olek, { type: 'home' });
    assert.equal(hers.more, false, 'hidden rows do not make "more" true');
    assert.deepEqual(shape(hers), shape(his), 'identical to a member who never had those events');
    assert.deepEqual(texts(hers.items), ['Ari started “Welcome to the open notes”']);
    assert.equal(JSON.stringify(hers).includes('Secret launch'), false);
  });
});
