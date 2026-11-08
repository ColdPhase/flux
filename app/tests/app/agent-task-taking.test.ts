import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { taskActivityPath, taskAgentPath, taskAgentRetryPath, taskAgentStopPath, taskDiscussionPath, TASK_TAKING_PATH, workItemPath,
  type Project, type TaskActivityPage, type TaskAgentState, type TaskDiscussion, type TaskTaking, type WorkItem, type Workspace } from '@flux/contracts';
import { taskAgentState, taskRunClientId, type Principal, type TaskAgentFacts } from '@flux/core';
import { createAgentTaskDrain } from '../../apps/server/src/agent-tasks/drain.js';
import { personalRunPorts, personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { AGENT_TASK_EVENT_ATTEMPTS, AGENT_TASK_GIVE_UP_ATTEMPTS, agentTaskRows } from '@flux/db';
import { eventNow as eventNowOf, withFault as faultOf } from './support/db-faults.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { waitFor } from './support/wait.js';
import { setSpaceAi } from './support/space-ai.js';

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
    const said = [...new Map([talk.root, ...talk.messages].filter(Boolean).map((message) => [message!.id, message!])).values()]
      .sort((a, b) => a.sequence - b.sequence).map((message) => [message.authorId === null ? 'agent' : 'human', message.body]);
    assert.deepEqual(said, [['agent', 'I can\'t start: AI is switched off on this Flux.']], 'the discussion opens with the refusal, not with a promise it then breaks');
    const activity = expectStatus(await ada.browser.request('GET', taskActivityPath(task.id)), 200) as TaskActivityPage;
    const owners = activity.items.filter((entry) => entry.kind === 'owner');
    assert.deepEqual(owners.map((entry) => [entry.automation ?? null, entry.owner?.to?.kind]).reverse(), [['agent_rule', 'agent'], ['agent_rule', 'human']],
      'the setting acted for Kai, and the agent gave it back for him; both are on the task\'s record');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE work_id = $1', [task.id])).rows[0].n, 0, 'no run was made');
    // It is back with Kai without another take: the give-back is not "someone assigned it to me".
    assert.equal((await events(task.id)).length, 2);
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

  // A run the agent holds the task with, made as the start would, without the worker: the task's discussion, a queued run on it and
  // the task owned by the agent (written directly, so the events below are the ones under test).
  async function heldByAgent(owner: Person, agentId: string, title: string, project: Project = lamp) {
    const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/work`, { body: { title, owner: { kind: 'human', id: owner.id } } }), 201) as WorkItem;
    expectStatus(await owner.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'Please take this', clientMessageId: randomUUID() } }), 201);
    const talk = expectStatus(await owner.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const started = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { ownerUserId: owner.id, agentId, workId: task.id, projectId: project.id,
      conversationId: talk.conversationId!, prompt: `Task #${task.number}: ${title}`, clientRunId: randomUUID() }));
    assert.ok(started.started, JSON.stringify(started));
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [task.id, agentId]);
    return { task: await readTask(task.id), run: started.run };
  }
  const runRow = async (id: string) => (await pool.query('SELECT status, end_reason, stop_requested_by FROM personal_runs WHERE id = $1', [id])).rows[0] as
    { status: string; end_reason: string | null; stop_requested_by: string | null };
  const agentState = async (someone: Person, id: string) => expectStatus(await someone.browser.request('GET', taskAgentPath(id)), 200) as TaskAgentState;

  test('B1: a burst of assignments with several drains at once loses none and fails no request', async () => {
    expectStatus(await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: agents.kai } }), 200);
    // Two more drains beside the two API replicas, on the same events; the people keep creating tasks meanwhile.
    const extra = [createAgentTaskDrain(db, queue.factory, {}), createAgentTaskDrain(db, queue.factory, {})];
    const burst = Promise.all(Array.from({ length: 8 }, (_, index) => createTask(maja, `Burst ${index}`, { kind: 'human', id: kai.id })));
    const meanwhile = Promise.all(Array.from({ length: 6 }, (_, index) => createTask(maja, `Meanwhile ${index}`, null)));
    const [assigned, others] = await Promise.all([burst, meanwhile]);
    assert.equal(others.length, 6, 'every task a person created meanwhile was created: none answered 500');
    await Promise.all(extra.map((drain) => drain.drain()));
    for (const task of assigned) {
      await settled(task.id);
      const now = await readTask(task.id);
      assert.equal(now.owner?.kind, 'human', `${task.title} is back with Kai`);
      const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
      assert.deepEqual([...new Set([talk.root, ...talk.messages].filter(Boolean).map((message) => message!.body))], ['I can\'t start: AI is switched off on this Flux.'],
        `${task.title}: Kai's setting was applied (the agent took it and said why it could not start), not silently lost`);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_task_events WHERE handled_at IS NULL AND attempts >= 5`)).rows[0].n, 0, 'no event was given up');
    expectStatus(await kai.browser.request('PUT', TASK_TAKING_PATH, { body: { agentId: null } }), 200);
  });

  test('a task stays To do while its agent waits and is Doing when the run starts', async () => {
    const { task, run } = await heldByAgent(kai, agents.kai!, 'Waits for room');
    assert.equal(task.status, 'open');
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [run.id]);
    await waitFor(async () => (await readTask(task.id)).status === 'in_progress', 'the task to be Doing');
    assert.equal((await readTask(task.id)).owner?.id, agents.kai, 'and still the agent\'s');
  });

  test('taking a task back while its agent works stops the run, and the line does not claim a hand-back', async () => {
    const { task, run } = await heldByAgent(kai, agents.kai!, 'Taken back while it works');
    const current = await readTask(task.id);
    expectStatus(await kai.browser.request('PATCH', workItemPath(task.id), { body: { owner: { kind: 'human', id: kai.id } }, headers: { 'if-match': `"${current.version}"` } }), 200);
    const stopped = await waitFor(async () => { const row = await runRow(run.id); return row.status === 'stopped' ? row : null; }, 'the run to stop');
    assert.equal(stopped.stop_requested_by, kai.id, 'by the person who took the task back');
    const state = await agentState(kai, task.id);
    assert.deepEqual([state.line, state.text], ['stopped', 'Stopped by you · the task is back with you']);
    // Even a run that finished before the take-back is not "Back with you to check": the agent never handed the task back.
    await pool.query(`UPDATE personal_runs SET status = 'completed', end_reason = NULL, completed_at = now(), stop_requested_by = NULL, committed_at = now(), answer_body = 'Done' WHERE id = $1`, [run.id]);
    assert.equal((await agentState(kai, task.id)).line, null);
  });

  test('B2: AI turned off while the agent worked: the owner is told in the task, and the task is back with them', async () => {
    const space = await createProject(ada, ws.id, 'Rain barrel monitor two', 'workspace');
    const { task, run } = await heldByAgent(kai, agents.kai!, 'Working when AI went off', space);
    await setSpaceAi(space.id, 'blocked');
    // What the turn-off sweep does to a run in flight.
    await pool.query(`UPDATE personal_runs SET status = 'stopped', stopped_at_stage = 'before_read', end_reason = 'ai_off', cost_state = 'released', charged_micros = 0, completed_at = now() WHERE id = $1`, [run.id]);
    await waitFor(async () => (await readTask(task.id)).owner?.kind === 'human', 'the task to come back to Kai');
    const state = await agentState(kai, task.id);
    assert.deepEqual([state.line, state.text], ['stopped', 'Stopped: AI was turned off in this space · the task is back with you']);
    const kaiName = (await pool.query('SELECT name FROM auth_users WHERE id = $1', [kai.id])).rows[0].name as string;
    assert.equal((await agentState(ada, task.id)).text, `Stopped: AI was turned off in this space · the task is back with ${kaiName}`, 'everyone who reads the task sees the same line');
  });

  const eventNow = (workId: string, kind: string) => eventNowOf(pool, { workId, kind });
  const withFault = (name: string, table: string, when: string, body: string, run: () => Promise<void>) => faultOf(pool, { name, table, when, body }, run);
  const agentLines = async (workId: string) => {
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(workId)), 200) as TaskDiscussion;
    return [talk.root, ...talk.messages].filter((message) => message && message.authorId === null).map((message) => message!.body);
  };

  test('an event that fails every time is not silent: the owner reads it in the task and has the task back; a give-up that fails is tried again', async () => {
    const { task, run } = await heldByAgent(lee, agents.lee!, 'Cannot be marked Doing');
    const seen = new Set<number>();
    // A fault in the database for this one task: it cannot be set to Doing, so every drain fails the `started` event the same way. A second
    // one refuses the hand-back until the event has had seven tries, so the give-up itself fails twice before it works.
    const after = `${task.id.replace(/-/g, '')}`;
    await withFault(`atk_doing_${after}`, 'project_work_items', `OLD.id = '${task.id}' AND NEW.status = 'in_progress'`, `RAISE EXCEPTION 'injected fault';`, () =>
      withFault(`atk_back_${after}`, 'project_work_items', `OLD.id = '${task.id}' AND OLD.owner_agent_id IS NOT NULL AND NEW.owner_agent_id IS NULL`,
        `IF coalesce((SELECT max(attempts) FROM agent_task_events WHERE work_id = OLD.id AND kind = 'started' AND handled_at IS NULL), 99) < 7 THEN RAISE EXCEPTION 'injected fault'; END IF;`, async () => {
          await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [run.id]);
          const given = await waitFor(async () => {
            const row = await eventNow(task.id, 'started');
            if (!row.handled_at) seen.add(row.attempts);
            return row.handled_at ? row : null;
          }, 'the event to be given up', 60_000);
          assert.equal(given.attempts, 7, 'five tries, then the give-up, which failed twice and worked the third time');
          assert.ok([...seen].some((attempts) => attempts >= 5), `the event stayed, unhandled, while its give-up failed (saw ${[...seen].join(', ')})`);
        }));
    const back = await waitFor(async () => { const now = await readTask(task.id); return now.owner?.kind === 'human' ? now : null; }, 'the task to come back to Lee');
    assert.equal(back.owner?.id, lee.id);
    assert.deepEqual(await agentLines(task.id), ['I couldn\'t take care of this. It\'s back with you.'], 'the agent says it in the task, once');
    assert.equal((await waitFor(async () => { const row = await runRow(run.id); return row.status === 'stopped' ? row : null; }, 'the run to stop')).stop_requested_by, lee.id, 'and its run does not go on for a task that is no longer its own');
  });

  test('P2: a released event that gives up still stops the run, though the task is back with its owner, and says nothing false', async () => {
    const { task, run } = await heldByAgent(lee, agents.lee!, 'Taken back, and the stop fails');
    // The run cannot be stopped until the event has had its five tries (a fault in the database for this one run).
    await withFault(`atk_stop_${run.id.replace(/-/g, '')}`, 'personal_runs', `OLD.id = '${run.id}' AND NEW.status = 'stopped'`,
      `IF coalesce((SELECT max(attempts) FROM agent_task_events WHERE work_id = '${task.id}' AND kind = 'released' AND handled_at IS NULL), 99) < 5 THEN RAISE EXCEPTION 'injected fault'; END IF;`, async () => {
        const current = await readTask(task.id);
        expectStatus(await lee.browser.request('PATCH', workItemPath(task.id), { body: { owner: { kind: 'human', id: lee.id } }, headers: { 'if-match': `"${current.version}"` } }), 200);
        const given = await waitFor(async () => { const row = await eventNow(task.id, 'released'); return row.handled_at ? row : null; }, 'the release to be given up', 60_000);
        assert.equal(given.attempts, 5);
      });
    const stopped = await waitFor(async () => { const row = await runRow(run.id); return row.status === 'stopped' ? row : null; }, 'the run to stop');
    assert.equal(stopped.stop_requested_by, lee.id, 'stopped as the person who took the task back');
    assert.deepEqual(await agentLines(task.id), [], 'nothing is said: the person took it, and the line "still with you" would be false');
    assert.equal((await readTask(task.id)).owner?.id, lee.id);
  });

  test('a retry that is waiting is found without another notification (a drain sets its timer from the database)', async () => {
    const { task, run } = await heldByAgent(lee, agents.lee!, 'Waits for its time');
    await pool.query(`INSERT INTO agent_task_events (kind, work_id, run_id, next_try_at) VALUES ('started', $1, $2, now() + interval '3 seconds')`, [task.id, run.id]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal((await readTask(task.id)).status, 'open', 'not before its time');
    await waitFor(async () => (await readTask(task.id)).status === 'in_progress', 'the task to be Doing when the event is due', 20_000);
  });

  test('an event another replica handled is not counted as failed, so it is never given up', async () => {
    const { task, run } = await heldByAgent(lee, agents.lee!, 'Handled meanwhile');
    const { rows: [event] } = await pool.query(`INSERT INTO agent_task_events (kind, work_id, run_id, next_try_at, handled_at) VALUES ('started', $1, $2, now() + interval '1 hour', now()) RETURNING id`, [task.id, run.id]);
    assert.equal(await agentTaskRows(db).failed(event.id), null);
    assert.equal((await pool.query(`SELECT attempts FROM agent_task_events WHERE id = $1`, [event.id])).rows[0].attempts, 0);
    const open = (await pool.query(`INSERT INTO agent_task_events (kind, work_id, run_id, next_try_at) VALUES ('started', $1, $2, now() + interval '1 hour') RETURNING id`, [task.id, run.id])).rows[0];
    assert.deepEqual(await agentTaskRows(db).failed(open.id), { attempts: 1, waitSeconds: 1 });
    await pool.query(`DELETE FROM agent_task_events WHERE id = $1`, [open.id]);
  });

  test('#938: a release stops only the runs that were going when the task was taken away, not a later assignment\'s', async () => {
    const earlier = await heldByAgent(lee, agents.lee!, 'Taken back long ago');
    const later = await heldByAgent(lee, agents.lee!, 'Taken back just now');
    // A retried release of an old take-back (its event is an hour old) meets a run made since: that run is a later assignment's.
    await pool.query(`INSERT INTO agent_task_events (kind, work_id, owner_agent_id, by_kind, by_id, created_at) VALUES ('released', $1, $2, 'human', $3, now() - interval '1 hour')`, [earlier.task.id, agents.lee, lee.id]);
    await waitFor(async () => (await pool.query(`SELECT 1 FROM agent_task_events WHERE work_id = $1 AND kind = 'released' AND handled_at IS NOT NULL`, [earlier.task.id])).rowCount === 1, 'the old release to be handled');
    assert.equal((await runRow(earlier.run.id)).status, 'queued', 'the later run was not stopped by it');
    // A release made after the run began stops it, as before.
    await pool.query(`INSERT INTO agent_task_events (kind, work_id, owner_agent_id, by_kind, by_id, created_at) VALUES ('released', $1, $2, 'human', $3, now() + interval '1 minute')`, [later.task.id, agents.lee, lee.id]);
    const stopped = await waitFor(async () => { const row = await runRow(later.run.id); return row.status === 'stopped' ? row : null; }, 'the run to stop');
    assert.equal(stopped.stop_requested_by, lee.id);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now() WHERE id = $1`, [earlier.run.id]);
  });

  test('#938: a give-up that fails every time is tried a bounded number of times, and the event is left with its count', async () => {
    const { task, run } = await heldByAgent(lee, agents.lee!, 'Cannot be given back');
    // The run ends first, and what its end does is done before the faults go in. A run left queued is failed by the worker some time
    // later (this composition has no provider), and its report ("I couldn't finish this.") would be a line in the thread that this
    // test counts; a run that has ended cannot do that. The task is then held by the agent again, as the faults need it.
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now() WHERE id = $1`, [run.id]);
    await settled(task.id);
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [task.id, agents.lee]);
    const linesBefore = await agentLines(task.id);
    const after = task.id.replace(/-/g, '');
    try {
      await withFault(`atk_doing_${after}`, 'project_work_items', `OLD.id = '${task.id}' AND NEW.status = 'in_progress'`, `RAISE EXCEPTION 'injected fault';`, () =>
        withFault(`atk_back_${after}`, 'project_work_items', `OLD.id = '${task.id}' AND OLD.owner_agent_id IS NOT NULL AND NEW.owner_agent_id IS NULL`, `RAISE EXCEPTION 'injected fault';`, async () => {
          const { rows: [event] } = await pool.query(`INSERT INTO agent_task_events (kind, work_id, run_id) VALUES ('started', $1, $2) RETURNING id`, [task.id, run.id]);
          const left = await waitFor(async () => { const row = await eventNow(task.id, 'started'); return row.attempts >= AGENT_TASK_EVENT_ATTEMPTS + AGENT_TASK_GIVE_UP_ATTEMPTS ? row : null; }, 'the tries to run out', 60_000);
          assert.deepEqual([left.attempts, left.handled_at], [AGENT_TASK_EVENT_ATTEMPTS + AGENT_TASK_GIVE_UP_ATTEMPTS, null], 'five tries, five give-ups, and the count is exact');
          // It is not claimed again, whoever asks: the count stays, and nothing was done to the task.
          for (let i = 0; i < 4; i++) { await eventNow(task.id, 'started'); await new Promise((resolve) => setTimeout(resolve, 300)); }
          const still = (await pool.query(`SELECT attempts, handled_at FROM agent_task_events WHERE id = $1`, [event.id])).rows[0] as { attempts: number; handled_at: Date | null };
          assert.deepEqual([still.attempts, still.handled_at], [left.attempts, null]);
          assert.equal((await readTask(task.id)).owner?.kind, 'agent', 'the task was never given back: the hand-back failed each time');
          assert.deepEqual(await agentLines(task.id), linesBefore, 'and no line was posted, because each give-up rolled back whole');
        }));
    } finally {
      // The event is left unhandled with its count by design; a later run on this stack (B1 counts such events) must not meet it.
      await pool.query('UPDATE agent_task_events SET handled_at = now() WHERE work_id = $1 AND handled_at IS NULL', [task.id]);
    }
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
    assert.deepEqual(line({ run: run({ status: 'completed' }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' }, handedBackByAgent: true }), ['handed_back', 'Back with you to check']);
    assert.deepEqual(line({ run: run({ status: 'completed' }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' }, handedBackByAgent: false }), [null, ''], 'a person who took the task back is not "back with you to check"');
    assert.deepEqual(line({ run: run({ status: 'stopped', endReason: 'ai_off' }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' } }),
      ['stopped', 'Stopped: AI was turned off in this space · the task is back with you'], 'C-17: the owner is told');
    assert.deepEqual(line({ run: run({ status: 'stopped', stopRequestedBy: { id: 'maja', name: 'Maja' } }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' } }),
      ['stopped', 'Stopped by Maja · the task is back with you']);
    // Maja took the task herself: it is not "back with" the agent's owner (#931).
    assert.deepEqual(line({ run: run({ status: 'stopped', stopRequestedBy: { id: 'maja', name: 'Maja' } }), task: { ownerUserId: 'maja', ownerAgentId: null, status: 'in_progress' }, taskOwnerName: 'Maja' }),
      ['stopped', 'Stopped by Maja · the task is with Maja']);
    assert.deepEqual(line({ viewerId: 'maja', run: run({ status: 'stopped', stopRequestedBy: { id: 'maja', name: 'Maja' } }), task: { ownerUserId: 'maja', ownerAgentId: null, status: 'in_progress' }, taskOwnerName: 'Maja' }),
      ['stopped', 'Stopped by you · the task is with you']);
    assert.deepEqual(line({ run: run({ status: 'stopped', stopRequestedBy: { id: 'maja', name: 'Maja' } }), task: { ownerUserId: null, ownerAgentId: null, status: 'open' } }),
      ['stopped', 'Stopped by Maja'], 'a task nobody holds is not said to be anywhere');
    assert.deepEqual(line({ run: run({ status: 'stopped', stopRequestedBy: { id: 'maja', name: 'Maja' } }) }),
      ['stopped', 'Stopped by Maja · the task is back with you'], 'while the agent still holds it, the hand-back is the next step');
  });

  test('Stop is the owner\'s or a space admin\'s; Try again and Take it back are the owner\'s', () => {
    const working = (extra: Partial<TaskAgentFacts>) => taskAgentState(facts(extra));
    assert.equal(working({}).canStop, true);
    assert.equal(working({ viewerId: 'jonas' }).canStop, false);
    assert.equal(working({ viewerId: 'maja', viewerIsAdmin: true }).canStop, true);
    const failed = working({ run: run({ status: 'provider_failed', endReason: 'crashed' }) });
    assert.deepEqual([failed.canTryAgain, failed.canTakeBack], [true, true]);
    const handed = working({ run: run({ status: 'completed' }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' }, handedBackByAgent: true });
    assert.deepEqual([handed.line, handed.canMarkDone], ['handed_back', true], 'the owner closes it from the line');
    assert.equal(taskAgentState(facts({ viewerId: 'jonas', run: run({ status: 'completed' }), task: { ownerUserId: 'ada', ownerAgentId: null, status: 'in_progress' }, handedBackByAgent: true })).canMarkDone, false);
    const others = working({ viewerId: 'jonas', run: run({ status: 'provider_failed', endReason: 'crashed' }) });
    assert.deepEqual([others.canTryAgain, others.canTakeBack, others.canStop], [false, false, false]);
  });

  test('one assignment names one run', () => {
    assert.equal(taskRunClientId('e1'), taskRunClientId('e1'));
    assert.notEqual(taskRunClientId('e1'), taskRunClientId('e2'));
    assert.match(taskRunClientId('e1'), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
