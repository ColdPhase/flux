import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { taskActivityPath, taskAgentPath, taskAgentRetryPath, taskAgentStopPath, taskDiscussionPath, TASK_TAKING_PATH, workItemPath,
  type Project, type TaskActivityPage, type TaskAgentState, type TaskDiscussion, type TaskTaking, type WorkItem, type Workspace } from '@flux/contracts';
import { taskAgentState, taskRunClientId, type Principal, type TaskAgentFacts } from '@flux/core';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { waitFor } from './support/wait.js';

// People's agents take tasks (#856, F-036 AG-5) and the Owner field offers only your own agents (#904). The API container runs the
// production composition, where nobody has a key and the provider is off, so an agent that takes a task says it cannot start and gives
// the task back: that is the path asserted here, through the real routes, the real events and the real drain. The run itself (the
// agent works, reports in the task, marks it Done or hands it back) is followed in the browser suite on the mock provider
// (tests/ui/test_agent_takes_task.py). Nothing here calls a model.

const connections = new FakeConnections();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

async function post<T>(someone: Person, path: string, body: unknown, status = 201): Promise<T> {
  return expectStatus(await someone.browser.request('POST', path, { body }), status, `POST ${path}`) as T;
}

describe('people\'s agents take tasks (#856, #904)', () => {
  let ada: Person; let kai: Person; let lee: Person; let maja: Person;
  let ws: Workspace; let lamp: Project;
  const agents: Record<string, string> = {};

  const readTaking = async (someone: Person) => expectStatus(await someone.browser.request('GET', TASK_TAKING_PATH), 200) as TaskTaking;
  const readTask = async (id: string) => expectStatus(await ada.browser.request('GET', workItemPath(id)), 200) as WorkItem;
  const createTask = async (by: Person, title: string, owner: { kind: 'human' | 'agent'; id: string } | null) =>
    post<WorkItem>(by, `/api/v1/projects/${lamp.id}/work`, { title, ...(owner ? { owner } : {}) });
  const events = async (workId: string) => (await pool.query(
    'SELECT kind, owner_user_id, owner_agent_id, by_id, handled_at FROM agent_task_events WHERE work_id = $1 ORDER BY created_at, id', [workId])).rows as
    { kind: string; owner_user_id: string | null; owner_agent_id: string | null; by_id: string | null; handled_at: Date | null }[];
  const settled = async (workId: string) => waitFor(async () => {
    const rows = await events(workId);
    return rows.length && rows.every((row) => row.handled_at) ? rows : null;
  }, `the events of ${workId} to be handled`);

  before(async () => {
    [ada, kai, lee, maja] = await Promise.all(['atk-ada', 'atk-kai', 'atk-lee', 'atk-maja'].map(person));
    ws = await createWorkspace(ada, 'Rain barrels');
    for (const member of [kai, lee, maja]) await addMember(ada, ws.id, member, 'member');
    lamp = await createProject(ada, ws.id, 'Rain barrel monitor', 'workspace');
    for (const [name, someone] of [['ada', ada], ['kai', kai], ['lee', lee]] as const) {
      agents[name] = (await post<{ id: string }>(someone, `/api/v1/workspaces/${ws.id}/agents`, { name: `${name} planner`, owner: 'self' })).id;
      const connection = randomUUID();
      connections.connect(someone.id, connection);
      await runs.enable(human(someone), { agentId: agents[name]!, connection, model: 'claude-sonnet-5' });
    }
  });

  test('#904: the Owner field offers your own agents, and the server refuses someone else\'s', async () => {
    assert.deepEqual((await readTaking(kai)).agents.map((agent) => agent.id), [agents.kai], 'Kai is offered Kai\'s agent only');
    assert.deepEqual((await readTaking(maja)).agents, [], 'a person without an agent is offered none');
    const task = await createTask(ada, 'Calibrate the overflow sensor', null);
    const refused = await ada.browser.request('PATCH', workItemPath(task.id), { body: { owner: { kind: 'agent', id: agents.kai } }, headers: { 'if-match': `"${task.version}"` } });
    assert.equal(refused.status, 422, refused.text);
    assert.equal((refused.json as { code: string }).code, 'OWNER_NOT_YOUR_AGENT');
    const create = await ada.browser.request('POST', `/api/v1/projects/${lamp.id}/work`, { body: { title: 'For Kai\'s agent', owner: { kind: 'agent', id: agents.kai } } });
    assert.equal((create.json as { code: string }).code, 'OWNER_NOT_YOUR_AGENT', 'creating a task for it is refused too');
    assert.equal((await readTask(task.id)).owner, null, 'nothing was changed');
    assert.equal((await events(task.id)).length, 0, 'a refused change writes no event');
    // Your own agent is fine, and Kai's agent is fine for Kai.
    const mine = await createTask(kai, 'Kai gives it to his agent', { kind: 'agent', id: agents.kai! });
    assert.equal(mine.owner?.id, agents.kai);
  });

  test('the setting names one of your own agents, and Do nothing is the default', async () => {
    assert.equal((await readTaking(kai)).takes, null, 'Do nothing by default');
    const foreign = await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: agents.ada } });
    assert.equal(foreign.status, 409, foreign.text);
    assert.equal((foreign.json as { code: string }).code, 'TASK_TAKING_NOT_YOUR_AGENT');
    const set = expectStatus(await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: agents.kai } }), 200) as TaskTaking;
    assert.equal(set.takes, agents.kai);
    assert.equal((await readTaking(ada)).takes, null, 'it is Kai\'s setting, nobody else\'s');
    const none = expectStatus(await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: null } }), 200) as TaskTaking;
    assert.equal(none.takes, null);
    assert.equal((await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: 'not-an-id' } })).status, 400);
  });

  test('Do nothing: a task given to a person stays with the person and starts nothing', async () => {
    const task = await createTask(ada, 'For Lee', { kind: 'human', id: lee.id });
    assert.deepEqual(await events(task.id), [], 'no standing instruction, no event');
    expectStatus(await lee.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: agents.lee } }), 200);
    const self = await createTask(lee, 'Lee gives it to Lee', { kind: 'human', id: lee.id });
    assert.deepEqual(await events(self.id), [], 'nobody else gave it: the setting is for what others assign');
    expectStatus(await lee.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: null } }), 200);
  });

  test('a task given to a person whose setting names an agent goes to the agent, which cannot start here and gives it back', async () => {
    expectStatus(await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: agents.kai } }), 200);
    const task = await createTask(ada, 'Calibrate the overflow sensor', { kind: 'human', id: kai.id });
    const rows = await settled(task.id);
    assert.deepEqual(rows.map((row) => [row.kind, row.owner_user_id ? 'person' : 'agent']), [['assigned', 'person'], ['assigned', 'agent']],
      'the person was given it; then the setting gave it to the agent');
    // The production composition has no provider: the agent says so in the task and the task is back with Kai.
    const back = await waitFor(async () => { const now = await readTask(task.id); return now.owner?.kind === 'human' ? now : null; }, 'the task to come back to Kai');
    assert.equal(back.owner?.id, kai.id);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const said = [talk.root, ...talk.messages].filter(Boolean).map((message) => [message!.author.kind, message!.body]);
    assert.deepEqual(said, [['agent', 'Got it, I\'m on it.'], ['agent', 'I can\'t start: AI is switched off on this Flux.']]);
    const activity = expectStatus(await ada.browser.request('GET', taskActivityPath(task.id)), 200) as TaskActivityPage;
    const owners = activity.items.filter((entry) => entry.kind === 'owner');
    assert.deepEqual(owners.map((entry) => [entry.automation ?? null, entry.owner?.to?.kind]).reverse(), [[null, 'human'], ['agent_rule', 'agent'], ['agent_rule', 'human']],
      'the setting acted for Kai, and the agent gave it back for him; both are on the task\'s record');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE work_id = $1', [task.id])).rows[0].n, 0, 'no run was made');
    // It is back with Kai without another take: the give-back is not "someone assigned it to me".
    assert.equal((await events(task.id)).length, 3);
    expectStatus(await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: null } }), 200);
  });

  test('giving a task to your own agent starts it, and a stranger cannot stop or retry it', async () => {
    const task = await createTask(kai, 'Compare the readings', { kind: 'agent', id: agents.kai! });
    await settled(task.id);
    const state = expectStatus(await kai.browser.request('GET', taskAgentPath(task.id)), 200) as TaskAgentState;
    // The agent could not start in this composition and handed the task back; the line is quiet.
    assert.equal(state.line, null);
    assert.equal((await lee.browser.request('POST', taskAgentStopPath(task.id), { body: {} })).status, 409, 'nothing is working');
    assert.equal((await lee.browser.request('POST', taskAgentRetryPath(task.id), { body: {} })).status, 403, 'only the agent\'s owner can try again');
  });
});

describe('the state line of an agent on a task (#856)', () => {
  const agent = { id: 'a1', name: 'Planner', owner: { id: 'ada', name: 'Ada' } };
  const run = (extra: Partial<NonNullable<TaskAgentFacts['run']>> = {}): NonNullable<TaskAgentFacts['run']> => ({
    id: 'r1', status: 'dispatching', engine: 'runtime', provider: 'anthropic', endReason: null, resumeAt: null, stopRequestedAt: null, stopRequestedBy: null, planLimitResetsAt: null, ...extra });
  const facts = (extra: Partial<TaskAgentFacts> = {}): TaskAgentFacts => ({
    viewerId: 'ada', viewerIsAdmin: false, task: { ownerUserId: null, ownerAgentId: 'a1', status: 'in_progress' }, agent, run: run(), successor: null, waitingChanges: 0, ...extra });
  const line = (extra?: Partial<TaskAgentFacts>) => { const state = taskAgentState(facts(extra)); return [state.line, state.text]; };

  test('each state says what the agent is doing', () => {
    assert.deepEqual(line({ run: run({ status: 'queued', endReason: 'no_room' }) }), ['waiting_for_room', 'Waiting for room on the server']);
    assert.deepEqual(line(), ['working', 'Working…']);
    assert.deepEqual(line({ waitingChanges: 2, run: run({ status: 'completed' }) }), ['waiting_for_ok', 'Waiting for your OK']);
    assert.deepEqual(line({ viewerId: 'jonas', waitingChanges: 2, run: run({ status: 'completed' }) }), ['waiting_for_ok', 'Waiting for Ada\'s OK']);
    assert.deepEqual(line({ run: run({ status: 'unavailable', endReason: 'plan_limit' }), successor: { resumeAt: new Date('2026-11-07T14:00:00Z') } }), ['paused_by_limit', 'Claude limit reached']);
    assert.deepEqual(line({ run: run({ status: 'provider_failed', endReason: 'unknown' }) }), ['failed', 'Couldn\'t finish']);
    assert.deepEqual(line({ run: run({ status: 'completed' }), task: { ownerUserId: null, ownerAgentId: 'a1', status: 'done' } }), ['done', 'Marked done · you were told']);
    assert.deepEqual(line({ run: run({ status: 'completed' }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' } }), ['handed_back', 'Back with you to check']);
    assert.deepEqual(line({ run: run({ status: 'stopped', stopRequestedBy: { id: 'maja', name: 'Maja' } }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' } }),
      ['stopped', 'Stopped by Maja · the task is back with you']);
  });

  test('Stop is the owner\'s or a space admin\'s; Try again and Take it back are the owner\'s', () => {
    const working = (extra: Partial<TaskAgentFacts>) => taskAgentState(facts(extra));
    assert.equal(working({}).canStop, true);
    assert.equal(working({ viewerId: 'jonas' }).canStop, false);
    assert.equal(working({ viewerId: 'maja', viewerIsAdmin: true }).canStop, true);
    const failed = working({ run: run({ status: 'provider_failed', endReason: 'crashed' }) });
    assert.deepEqual([failed.canTryAgain, failed.canTakeBack], [true, true]);
    const others = working({ viewerId: 'jonas', run: run({ status: 'provider_failed', endReason: 'crashed' }) });
    assert.deepEqual([others.canTryAgain, others.canTakeBack, others.canStop], [false, false, false]);
  });

  test('one assignment names one run', () => {
    assert.equal(taskRunClientId('e1'), taskRunClientId('e1'));
    assert.notEqual(taskRunClientId('e1'), taskRunClientId('e2'));
    assert.match(taskRunClientId('e1'), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
