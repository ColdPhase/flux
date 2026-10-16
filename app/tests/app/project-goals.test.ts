import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { candidatesFor, DomainError, type NotificationFacts } from '@flux/core';
import { PROJECT_GOAL_EVENTS, type Agent, type Project, type ProjectGoalList, type ProjectGoalState, type WorkItem, type Workspace } from '@flux/contracts';
import { projectGoalUseCases } from '../../apps/server/src/project-goals/adapters.js';
import { db, pool } from './support/db.js';
import type { ClientResponse } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// A project's optional goal (#520, F-028) through the running API: who may set, edit, remove, mark
// reached and reopen it (writers yes; viewers, agents and outsiders no), the project version
// precondition, one current goal, reopen as Undo, events without notifications, and that closing
// every task never reaches a goal.

const goalPath = (id: string) => `/api/v1/projects/${id}/goal`;
const reachedPath = (id: string) => `/api/v1/projects/${id}/goal/reached`;
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const read = async (someone: Person, id: string) => json<Project>(await someone.browser.request('GET', `/api/v1/projects/${id}`), 200);
const ifMatch = (version: number | null, extra: Record<string, string> = {}) => version === null ? extra : { ...extra, 'if-match': `"${version}"` };
const setGoal = (someone: Person, id: string, title: unknown, version: number | null, headers: Record<string, string> = {}) =>
  someone.browser.request('PUT', goalPath(id), { body: { title }, headers: ifMatch(version, headers) });
const removeGoal = (someone: Person, id: string, version: number | null) => someone.browser.request('DELETE', goalPath(id), { headers: ifMatch(version) });
const reach = (someone: Person, id: string, version: number | null) => someone.browser.request('POST', reachedPath(id), { headers: ifMatch(version) });
const reopen = (someone: Person, id: string, version: number | null) => someone.browser.request('DELETE', reachedPath(id), { headers: ifMatch(version) });
const goalEvents = async (projectId: string) => (await pool.query<{ kind: string; data: { goalId: string } }>(
  "SELECT kind, data FROM events WHERE object_id = $1 AND kind LIKE 'project.goal_%' ORDER BY seq", [projectId])).rows;

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
}

describe('a project goal over HTTP', () => {
  let owner: Person;
  let writer: Person;
  let viewer: Person;
  let member: Person;
  let outsider: Person;
  let ws: Workspace;
  let garden: Project;
  let agent: Agent;

  before(async () => {
    [owner, writer, viewer, member, outsider] = await Promise.all(['goal-owner', 'Jonas Goal', 'goal-viewer', 'goal-member', 'goal-outsider'].map(person));
    ws = await workspace(owner, 'Riverside Makers');
    for (const someone of [writer, viewer, member]) await addMember(owner, ws.id, someone, 'member');
    garden = await createProject(owner, ws.id, 'Community garden sensors', 'restricted');
    await grant(owner, garden.id, writer, 'contributor');
    await grant(owner, garden.id, viewer, 'viewer');
    agent = json<Agent>(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Garden helper', owner: 'workspace' } }), 201);
    json(await owner.browser.request('POST', `/api/v1/projects/${garden.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  });

  test('a project without a goal says so: goal null, an empty history, no events', async () => {
    assert.equal(garden.goal, null, 'a new project has no goal');
    assert.equal((await read(viewer, garden.id)).goal, null);
    assert.deepEqual(json<ProjectGoalList>(await viewer.browser.request('GET', `/api/v1/projects/${garden.id}/goals`), 200).items, []);
    assert.deepEqual(await goalEvents(garden.id), []);
  });

  test('a contributor sets the goal with the version they saw; every reader sees it with who set it and when', async () => {
    const before = await read(writer, garden.id);
    expectStatus(await setGoal(writer, garden.id, 'All six beds report moisture', null), 428, 'If-Match is required');
    const response = await setGoal(writer, garden.id, '  All six   beds\nreport moisture ', before.version);
    const state = json<ProjectGoalState>(response, 200);
    assert.equal(response.headers.get('etag'), `"${state.version}"`);
    assert.equal(state.version, before.version + 1, 'the project version moves on');
    assert.equal(state.goal?.title, 'All six beds report moisture', 'spaces and line breaks are tidied into one line');
    assert.deepEqual(state.goal?.setBy, { id: writer.id, name: 'Jonas Goal' });
    assert.ok(Date.parse(state.goal!.setAt) > Date.now() - 60_000);
    assert.equal(state.goal?.reachedAt, null);
    for (const someone of [owner, viewer]) {
      const seen = await read(someone, garden.id);
      assert.deepEqual(seen.goal, state.goal, 'the goal is shared: one goal per project, the same for every reader');
      assert.equal(seen.version, state.version);
    }
    const listed = json<{ items: Project[] }>(await viewer.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects`), 200).items.find((item) => item.id === garden.id);
    assert.equal(listed?.goal?.title, 'All six beds report moisture', 'project lists carry it too');
  });

  test('viewers cannot change it, and people outside the project never learn it exists', async () => {
    const { version, goal } = await read(owner, garden.id);
    for (const attempt of [setGoal(viewer, garden.id, 'Mine now', version), removeGoal(viewer, garden.id, version), reach(viewer, garden.id, version), reopen(viewer, garden.id, version)]) {
      expectStatus(await attempt, 403, 'viewer');
    }
    for (const someone of [member, outsider]) {
      expectStatus(await setGoal(someone, garden.id, 'Mine now', version), 404, 'not in the project');
      expectStatus(await reach(someone, garden.id, version), 404, 'not in the project');
      expectStatus(await someone.browser.request('GET', `/api/v1/projects/${garden.id}/goals`), 404, 'not in the project');
    }
    const after = await read(owner, garden.id);
    assert.deepEqual([after.version, after.goal], [version, goal], 'nothing changed');
  });

  test('agents read the goal but can never change it, even with a contributor grant', async () => {
    const { version } = await read(owner, garden.id);
    const goals = projectGoalUseCases(db);
    const asAgent = { kind: 'agent' as const, id: agent.id };
    await rejects(goals.set(asAgent, garden.id, { title: 'Agent goal' }, version), 'GOAL_NEEDS_PERSON');
    await rejects(goals.reach(asAgent, garden.id, version), 'GOAL_NEEDS_PERSON');
    await rejects(goals.remove(asAgent, garden.id, version), 'GOAL_NEEDS_PERSON');
    await rejects(goals.reopen(asAgent, garden.id, version), 'GOAL_NEEDS_PERSON');
    assert.equal((await goals.list(asAgent, garden.id)).items[0]?.title, 'All six beds report moisture', 'agents can read it');
    assert.equal((await read(owner, garden.id)).version, version);
  });

  test('a stale version is refused with the current goal, and nothing changes', async () => {
    const current = await read(owner, garden.id);
    const refused = await setGoal(owner, garden.id, 'Something else', current.version - 1);
    const body = json<{ code: string; currentVersion: number; current: ProjectGoalState }>(refused, 409);
    assert.deepEqual([body.code, body.currentVersion, body.current.version, body.current.goal?.title], ['VERSION_CONFLICT', current.version, current.version, 'All six beds report moisture']);
    expectStatus(await reach(owner, garden.id, current.version - 1), 409);
    assert.deepEqual(await read(owner, garden.id), current);
  });

  test('editing keeps the same goal; one current goal per project; equal words change nothing; bad titles are refused', async () => {
    const current = await read(owner, garden.id);
    const edited = json<ProjectGoalState>(await setGoal(owner, garden.id, 'All six beds report soil moisture', current.version), 200);
    assert.equal(edited.goal?.id, current.goal?.id, 'an edit keeps the goal id (its moment stays once per goal)');
    assert.deepEqual(edited.goal?.setBy, current.goal?.setBy, 'the person who set it stays');
    const same = json<ProjectGoalState>(await setGoal(owner, garden.id, 'All six beds report soil moisture', edited.version), 200);
    assert.equal(same.version, edited.version, 'the same words change nothing');
    for (const title of ['', '   ', 'x'.repeat(121), ['two', 'lines']]) expectStatus(await setGoal(owner, garden.id, title, edited.version), 400, `title ${String(title).slice(0, 8)}`);
    assert.equal(json<ProjectGoalState>(await setGoal(owner, garden.id, 'é'.repeat(120), edited.version), 200).goal?.title.length, 120, '120 characters fit');
    const back = await read(owner, garden.id);
    json<ProjectGoalState>(await setGoal(owner, garden.id, 'All six beds report moisture', back.version), 200);
    const rows = (await pool.query('SELECT count(*)::int AS n FROM project_goals WHERE project_id = $1 AND reached_at IS NULL', [garden.id])).rows[0].n;
    assert.equal(rows, 1, 'still exactly one current goal');
    await assert.rejects(pool.query('INSERT INTO project_goals (id, workspace_id, project_id, title, set_by) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), ws.id, garden.id, 'A second current goal', owner.id]), /project_goals_current_idx/, 'the database refuses a second current goal');
  });

  test('closing every task does not reach the goal', async () => {
    const task = json<WorkItem>(await writer.browser.request('POST', `/api/v1/projects/${garden.id}/work`, { body: { title: 'Wire sensor 6' } }), 201);
    const other = json<WorkItem>(await writer.browser.request('POST', `/api/v1/projects/${garden.id}/work`, { body: { title: 'Try a second probe' } }), 201);
    json(await writer.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { status: 'done' }, headers: { 'if-match': `"${task.version}"` } }), 200);
    json(await writer.browser.request('PATCH', `/api/v1/work/${other.id}`, { body: { status: 'not_pursued' }, headers: { 'if-match': `"${other.version}"` } }), 200);
    const after = await read(owner, garden.id);
    assert.equal(after.goal?.reachedAt, null, 'goal state is never inferred from tasks');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id = $1 AND kind = 'project.goal_reached.v1'", [garden.id])).rows[0].n, 0);
  });

  test('a contributor marks it reached; who and when are shown; the project goes on; no one is notified', async () => {
    const notificationsBefore = (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = ANY($1)', [[owner.id, viewer.id, writer.id]])).rows[0].n;
    const inboxBefore = json<{ items: unknown[] }>(await owner.browser.request('GET', '/api/v1/needs-you'), 200).items.length;
    const current = await read(writer, garden.id);
    const state = json<ProjectGoalState>(await reach(writer, garden.id, current.version), 200);
    assert.equal(state.goal?.id, current.goal?.id);
    assert.deepEqual(state.goal?.reachedBy, { id: writer.id, name: 'Jonas Goal' });
    assert.ok(state.goal?.reachedAt && Date.parse(state.goal.reachedAt) > Date.now() - 60_000);
    const seen = await read(viewer, garden.id);
    assert.deepEqual(seen.goal, state.goal, 'Project.goal shows the reached goal until a new one is set');
    assert.deepEqual(seen.views, garden.views, 'the project itself is unchanged: no status, archive or read-only state');
    // The project stays writable for its people.
    json(await writer.browser.request('POST', `/api/v1/projects/${garden.id}/work`, { body: { title: 'Plan the winter covers' } }), 201);
    expectStatus(await reach(writer, garden.id, state.version), 422, 'a reached goal is not reached twice');
    expectStatus(await removeGoal(writer, garden.id, state.version), 422, 'a reached goal is history, not removed');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = ANY($1)', [[owner.id, viewer.id, writer.id]])).rows[0].n, notificationsBefore);
    assert.equal(json<{ items: unknown[] }>(await owner.browser.request('GET', '/api/v1/needs-you'), 200).items.length, inboxBefore, 'nothing joins the Inbox');
  });

  test('Undo reopens the reached goal; a new goal can then be set after reaching it again', async () => {
    const reached = await read(owner, garden.id);
    const reopened = json<ProjectGoalState>(await reopen(owner, garden.id, reached.version), 200);
    assert.deepEqual([reopened.goal?.id, reopened.goal?.reachedAt, reopened.goal?.reachedBy], [reached.goal?.id, null, null]);
    expectStatus(await reopen(owner, garden.id, reopened.version), 422, 'nothing to reopen while a goal is current');
    const again = json<ProjectGoalState>(await reach(owner, garden.id, reopened.version), 200);
    assert.equal(again.goal?.id, reached.goal?.id, 'the same goal: its moment does not replay on devices that saw it');
    const next = json<ProjectGoalState>(await setGoal(writer, garden.id, 'Two shared cargo bikes by spring', again.version), 200);
    assert.notEqual(next.goal?.id, again.goal?.id, 'a new goal has its own id');
    assert.equal(next.goal?.reachedAt, null);
    const history = json<ProjectGoalList>(await viewer.browser.request('GET', `/api/v1/projects/${garden.id}/goals`), 200).items;
    assert.deepEqual(history.map((goal) => [goal.title, !!goal.reachedAt]), [['Two shared cargo bikes by spring', false], ['All six beds report moisture', true]]);
    // Removing the current goal brings back the last reached one as what the project shows.
    const removed = json<ProjectGoalState>(await removeGoal(writer, garden.id, next.version), 200);
    assert.equal(removed.goal?.id, reached.goal?.id);
    assert.equal((await read(owner, garden.id)).goal?.title, 'All six beds report moisture');
    expectStatus(await removeGoal(writer, garden.id, removed.version), 422, 'no current goal to remove');
  });

  test('every change recorded one project event with identifiers only, and none of them notifies', async () => {
    const events = await goalEvents(garden.id);
    assert.deepEqual([...new Set(events.map((event) => event.kind))].sort(), [...PROJECT_GOAL_EVENTS].sort());
    for (const event of events) assert.deepEqual(Object.keys(event.data), ['goalId'], 'no goal words in events');
    const facts = { audience: async () => [owner.id, writer.id, viewer.id], names: async () => new Map() } as unknown as NotificationFacts;
    for (const kind of PROJECT_GOAL_EVENTS) {
      const candidates = await candidatesFor({ id: randomUUID(), seq: 1, kind, workspaceId: ws.id, objectId: garden.id, actorId: `human:${writer.id}`, data: { goalId: randomUUID() } }, facts);
      assert.deepEqual(candidates, [], `${kind} creates no notification`);
    }
  });

  test('an idempotent retry answers the same change once', async () => {
    const current = await read(owner, garden.id);
    const key = randomUUID();
    const first = json<ProjectGoalState>(await setGoal(owner, garden.id, 'Know when each bed needs water', current.version, { 'idempotency-key': key }), 200);
    const replay = await setGoal(owner, garden.id, 'Know when each bed needs water', current.version, { 'idempotency-key': key });
    assert.deepEqual(json<ProjectGoalState>(replay, 200), first);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal((await read(owner, garden.id)).version, first.version);
  });
});
