import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import { assistantRunChangesActionPath, projectWorkDetailPath, taskAgentPath, taskAgentStopPath, taskDiscussionPath, workItemPath,
  type Conversation, type TaskAgentState, type TaskDiscussion, type WorkDetailProjection, type WorkItem } from '@flux/contracts';
import { agentLabel, answerLines, askableLines, MAX_EXCHANGE_TURNS, resolveAsked, takeAsk, taskAgentState, type Askable, type Principal, type TaskAgentFacts } from '@flux/core';
import { personalRunPorts, personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { assistantScene, text, result, type AssistantScene } from './support/assistant-scene.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { waitFor } from './support/wait.js';

// Agents in a task's thread (#841, F-036 TA-2, TA-3) and a task's link to its message (#844). A run's change tool goes through the
// real `/mcp` route with the run's own token; nothing calls a model. The exchange of questions between two agents, which needs two
// owners' runs, is followed in the browser suite on the mock provider (tests/ui/test_agent_task_questions.py).

describe('agents split a task into subtasks, and a task keeps the message it came from (#841, #844)', () => {
  let scene: AssistantScene;
  let messageId = '';

  before(async () => {
    scene = await assistantScene('att');
    const talk = expectStatus(await scene.owner.browser.request('GET', `/api/v1/conversations/${scene.thread.id}`), 200) as Conversation;
    messageId = talk.messages[0]!.id;
  });
  beforeEach(() => scene.reset());

  const detail = async (id: string) => (expectStatus(await scene.owner.browser.request('GET', projectWorkDetailPath(scene.place.id, 'work', id)), 200) as WorkDetailProjection).object;

  test('#844: a task an agent makes from a message keeps it as its source; a message of another space is refused', async () => {
    const run = await scene.liveRun();
    const made = JSON.parse(text((await run.call('flux_create_task', { task: { title: 'Check the lamp wiring', sourceMessageId: messageId } })).message)) as { workId: string };
    const links = (await pool.query(`SELECT role, to_type, to_id FROM project_object_links WHERE from_id = $1`, [made.workId])).rows;
    assert.deepEqual(links, [{ role: 'source', to_type: 'message', to_id: messageId }], 'the task opens the message, and the message shows the task');
    // A message the agent could not read in this space is not a source.
    const other = await createProject(scene.owner, scene.ws.id, 'Elsewhere', 'workspace');
    const foreign = expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${other.id}/conversations`, { body: { body: 'Not here', clientMessageId: randomUUID() } }), 201) as Conversation;
    const refused = await run.call('flux_create_task', { task: { title: 'From elsewhere', sourceMessageId: foreign.messages[0]!.id } });
    assert.equal(result(refused.message)?.isError, true, text(refused.message));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'From elsewhere'`)).rows[0].n, 0);
    await scene.complete(run.runId);
  });

  test('#841: a subtask for the owner is made at once, one for another person waits for the owner\'s OK, and the parent counts them', async () => {
    const parent = await scene.task(scene.owner, 'Calibrate the overflow sensor');
    const run = await scene.liveRun();
    const mine = JSON.parse(text((await run.call('flux_create_task', { task: { title: 'Compare the last 40 readings', parentTaskId: parent.id } })).message)) as { workId: string };
    const waiting = await run.call('flux_create_task', { task: { title: 'Weigh the full barrel on Thursday', parentTaskId: parent.id, ownerUserId: scene.peer.id } });
    assert.match(text(waiting.message), /^Waiting for /, 'a task for another person is a proposal');
    let object = await detail(parent.id);
    assert.equal(object.kind, 'work');
    assert.deepEqual(object.kind === 'work' ? object.subtasks?.map((subtask) => subtask.title) : null, ['Compare the last 40 readings'], 'only what exists is listed');
    // Approve all: the proposal becomes a subtask of the same task, now Jonas's.
    expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'apply'), { body: {} }), 200);
    object = await detail(parent.id);
    const subtasks = object.kind === 'work' ? object.subtasks ?? [] : [];
    assert.deepEqual(subtasks.map((subtask) => [subtask.title, subtask.owner?.id ?? null]), [['Compare the last 40 readings', null], ['Weigh the full barrel on Thursday', scene.peer.id]]);
    // The parent does not wait for them: it can be worked on while they are open.
    const patched = await scene.patchWork(scene.owner, parent.id, parent.version, { status: 'in_progress' });
    assert.ok(patched.version > parent.version);
    // A subtask of a task in another space is refused.
    const other = await createProject(scene.owner, scene.ws.id, 'Elsewhere too', 'workspace');
    const foreign = await scene.task(scene.owner, 'Elsewhere task', other.id);
    const refused = await run.call('flux_create_task', { task: { title: 'Not a subtask', parentTaskId: foreign.id } });
    assert.equal(result(refused.message)?.isError, true, text(refused.message));
    assert.equal(mine.workId.length > 0, true);
    await scene.complete(run.runId);
  });
});

describe('the question one agent asks another (#841, TA-3)', () => {
  test('a report may end with one well-formed question; anything else asks nothing', () => {
    assert.deepEqual(takeAsk('I compared the readings.\n<ask>{"agent": "Fieldbot", "owner": "Jonas", "question": "Which reading means full?"}</ask>'),
      { body: 'I compared the readings.', ask: { agent: 'Fieldbot', owner: 'Jonas', question: 'Which reading means full?' } });
    assert.deepEqual(takeAsk('Done. <ask>{"agent": "Fieldbot", "question": "Which?"}</ask>'), { body: 'Done.', ask: { agent: 'Fieldbot', question: 'Which?' } }, 'the owner is optional');
    assert.deepEqual(takeAsk('Done. <ask>not json</ask>'), { body: 'Done.', ask: null });
    assert.deepEqual(takeAsk('Done. <ask>{"agent": "", "question": "x"}</ask>'), { body: 'Done.', ask: null });
    assert.deepEqual(takeAsk(`Done. <ask>{"agent": "A", "question": "${'q'.repeat(1001)}"}</ask>`), { body: 'Done.', ask: null });
    assert.deepEqual(takeAsk('No question here.'), { body: 'No question here.', ask: null });
    assert.deepEqual(takeAsk('Half a block <ask>{"agent": "A", "question": "x"}'), { body: 'Half a block', ask: null }, 'an unfinished block asks nothing and is not posted');
  });

  test('N6: a model\'s text cannot make the block search slow (no pattern over it)', () => {
    for (const hostile of ['<ask>'.repeat(200_000), `<ask>${' '.repeat(2_000_000)}`, `${'<ask></ask'.repeat(100_000)}`, `<ask>{${'"a":'.repeat(100_000)}</ask>`]) {
      const started = Date.now();
      takeAsk(hostile);
      assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
    }
  });

  test('N1: the owner says which agent is meant, and an ambiguous name is refused, never guessed', () => {
    const agents: Askable[] = [
      { id: 'a1', name: 'Assistant', ownerId: 'jonas', ownerName: 'Jonas Berg' }, { id: 'a2', name: 'Assistant', ownerId: 'maja', ownerName: 'Maja Wiśniewska' },
      { id: 'a3', name: 'Fieldbot', ownerId: 'jonas', ownerName: 'Jonas Berg' }];
    assert.deepEqual(resolveAsked({ agent: 'Fieldbot', question: 'q' }, agents), { found: agents[2] }, 'a name only one agent has');
    assert.deepEqual(resolveAsked({ agent: 'assistant', owner: 'maja', question: 'q' }, agents), { found: agents[1] }, 'by the first name, in any case');
    assert.deepEqual(resolveAsked({ agent: 'Assistant', owner: 'Jonas Berg', question: 'q' }, agents), { found: agents[0] }, 'or the whole name');
    assert.deepEqual(resolveAsked({ agent: 'Assistant', question: 'q' }, agents), { ambiguous: [agents[0], agents[1]] }, 'two agents of that name: no guess');
    assert.deepEqual(resolveAsked({ agent: 'Assistant', owner: 'Ada', question: 'q' }, agents), { none: true }, 'an owner who has none of that name');
    assert.deepEqual(resolveAsked({ agent: 'Ghost', question: 'q' }, agents), { none: true });
    assert.equal(agentLabel(agents[1]!), 'Assistant (Maja\'s agent)');
  });

  test('what an agent is told it may ask, and what comes back, is data with a bound', () => {
    assert.equal(askableLines([]), '');
    assert.match(askableLines([{ name: 'Fieldbot', owner: 'Jonas Berg' }]), /Fieldbot \(Jonas's agent\)/);
    assert.match(askableLines([{ name: 'Fieldbot', owner: 'Jonas Berg' }]), /"owner"/, 'the block names the owner');
    assert.ok(answerLines({ agent: 'Fieldbot', question: 'Which?' }, 'x'.repeat(5000)).length < 1500, 'an answer is cut, so a long exchange cannot grow a request without end');
    assert.ok(MAX_EXCHANGE_TURNS >= 2 && MAX_EXCHANGE_TURNS <= 10, 'a bound nobody meets in normal use');
  });

  test('N2, N3: only the answering owner (or an admin) stops an answer, and a paused answer shows as paused', () => {
    const agent = { id: 'a1', name: 'Planner', owner: { id: 'ada', name: 'Ada' } };
    const own = { id: 'r1', status: 'completed', engine: 'server' as const, provider: 'anthropic', endReason: null, resumeAt: null, stopRequestedAt: null, stopRequestedBy: null, planLimitResetsAt: null };
    const facts = (extra: Partial<TaskAgentFacts>): TaskAgentFacts => ({ viewerId: 'ada', viewerIsAdmin: false, agent, run: own, successor: null, waitingChanges: 0,
      task: { ownerUserId: null, ownerAgentId: 'a1', status: 'in_progress' }, ...extra });
    const answering = { name: 'Fieldbot', ownerId: 'jonas', run: { status: 'dispatching', engine: 'runtime' as const, provider: 'anthropic', endReason: null, resumeAt: null } };
    const asker = taskAgentState(facts({ waitingForAnswer: answering }));
    assert.deepEqual([asker.line, asker.text, asker.canStop], ['working', 'Waiting for Fieldbot to answer…', false], 'the one who asked cannot stop the other\'s answer');
    assert.equal(taskAgentState(facts({ viewerId: 'jonas', waitingForAnswer: answering })).canStop, true, 'the answering agent\'s owner can');
    assert.equal(taskAgentState(facts({ viewerId: 'maja', viewerIsAdmin: true, waitingForAnswer: answering })).canStop, true, 'and a space admin');
    const resumeAt = new Date('2026-11-07T14:00:00Z');
    const paused = taskAgentState(facts({ waitingForAnswer: { ...answering, run: { ...answering.run, status: 'queued', endReason: 'plan_limit', resumeAt } } }));
    assert.deepEqual([paused.line, paused.text, paused.resumesAt], ['paused_by_limit', 'Waiting for Fieldbot to answer · Claude limit reached', resumeAt.toISOString()]);
  });
});

describe('the exchange through the real drain (#841, N1 to N3)', () => {
  // The API container runs the production composition: no provider, so an agent that is asked cannot answer there. What is asserted is
  // what Flux decides and says in the thread; the answers themselves are followed on the mock provider in tests/ui/test_agent_task_questions.py.
  const connections = new FakeConnections();
  const queue = new FakeQueue();
  const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
  const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
  let ada: Person; let jonas: Person; let maja: Person;
  const names: Record<string, string> = {};
  let space: Awaited<ReturnType<typeof createProject>>;
  const agents: Record<string, string> = {};

  const thread = async (id: string) => {
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(id)), 200) as TaskDiscussion;
    return [...new Map([talk.root, ...talk.messages].filter(Boolean).map((message) => [message!.id, message!])).values()].sort((a, b) => a.sequence - b.sequence).map((message) => message.body);
  };
  const readTask = async (id: string) => expectStatus(await ada.browser.request('GET', workItemPath(id)), 200) as WorkItem;
  const runRow = async (id: string) => (await pool.query('SELECT status, end_reason, stop_requested_by FROM personal_runs WHERE id = $1', [id])).rows[0] as
    { status: string; end_reason: string | null; stop_requested_by: string | null };

  /** Ada (the space's admin) made a task, Maja wrote in it, and Jonas's agent Planner holds it with a finished report that asks `ask`. */
  async function asked(title: string, ask: string) {
    const task = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${space.id}/work`, { body: { title } }), 201) as WorkItem;
    expectStatus(await maja.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'I can help with the readings', clientMessageId: randomUUID() } }), 201);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const started = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { ownerUserId: jonas.id, agentId: agents.jonas!, workId: task.id, projectId: space.id,
      conversationId: talk.conversationId!, prompt: `Task #${task.number}: ${title}`, clientRunId: randomUUID() }));
    assert.ok(started.started, JSON.stringify(started));
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [task.id, agents.jonas]);
    // The report ends: the trigger writes the event, and the API container drains it.
    await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = $2, cost_state = 'released', charged_micros = 0 WHERE id = $1`,
      [started.run.id, `I compared the readings.\n<ask>${ask}</ask>`]);
    return { task, run: started.run };
  }
  const answerRuns = async (workId: string) => (await pool.query(`SELECT id, status FROM personal_runs WHERE work_id = $1 AND kind = 'task_answer' ORDER BY created_at`, [workId])).rows as { id: string; status: string }[];

  before(async () => {
    [ada, jonas, maja] = await Promise.all(['atq-ada', 'atq-jonas', 'atq-maja'].map(person));
    const ws = await createWorkspace(ada, 'Rain barrels two');
    for (const member of [jonas, maja]) await addMember(ada, ws.id, member, 'member');
    space = await createProject(ada, ws.id, 'Rain barrel monitor', 'workspace');
    for (const [key, someone] of [['ada', ada], ['jonas', jonas], ['maja', maja]] as const) names[key] = (await pool.query('SELECT name FROM auth_users WHERE id = $1', [someone.id])).rows[0].name as string;
    // Everyone's first agent is called Assistant; Jonas's, which asks, is called Planner so that Ada's and Maja's are the ones that collide.
    for (const [key, someone, name] of [['jonas', jonas, 'Planner'], ['ada', ada, 'Assistant'], ['maja', maja, 'Assistant']] as const) {
      agents[key] = (expectStatus(await someone.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
      const connection = randomUUID();
      connections.connect(someone.id, connection);
      await runs.enable(human(someone), { agentId: agents[key]!, connection, model: 'claude-sonnet-5' });
    }
  });

  test('N1: two agents called Assistant: a question that does not say whose is refused in the thread, and one that does reaches the right one', async () => {
    const vague = await asked('Which reading is full?', '{"agent": "Assistant", "question": "Which reading means full?"}');
    await waitFor(async () => (await readTask(vague.task.id)).owner?.kind === 'human', 'the task to go back to Ada');
    const said = await thread(vague.task.id);
    assert.ok(said.includes(`There is more than one agent called Assistant in this task: Assistant (${names.ada}'s agent) and Assistant (${names.maja}'s agent). Say whose you mean. This needs a person.`), said.join(' | '));
    assert.deepEqual(await answerRuns(vague.task.id), [], 'nobody\'s agent was asked');
    const clear = await asked('Which reading is full, Maja?', '{"agent": "Assistant", "owner": "' + names.maja + '", "question": "Which reading means full?"}');
    await waitFor(async () => (await readTask(clear.task.id)).owner?.kind === 'human', 'the task to go back to Ada');
    const lines = await thread(clear.task.id);
    assert.ok(lines.includes(`@Assistant (${names.maja}'s agent), Which reading means full?`), `the question names whose agent is asked: ${lines.join(' | ')}`);
    assert.ok(lines.includes(`Assistant (${names.maja}'s agent) can't answer now. This needs a person.`), 'and so does the refusal (this composition has no provider)');
  });

  test('N2: the asking owner cannot stop the other owner\'s answer; the answering owner can, and the thread says who stopped it', async () => {
    const held = await asked('Stop the answer', '{"agent": "Fieldbot", "question": "Which?"}');
    // The ask above names an agent nobody has, so it goes back; make the answer run directly, as a start would, on a task still held.
    await waitFor(async () => (await readTask(held.task.id)).owner?.kind === 'human', 'the first exchange to end');
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [held.task.id, agents.jonas]);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(held.task.id)), 200) as TaskDiscussion;
    const answer = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { kind: 'task_answer', ownerUserId: maja.id, agentId: agents.maja!, workId: held.task.id,
      projectId: space.id, conversationId: talk.conversationId!, prompt: 'Which?', clientRunId: randomUUID(), askedByRunId: held.run.id, exchangeTurn: 1, audience: [ada.id, jonas.id, maja.id] }));
    assert.ok(answer.started, JSON.stringify(answer));
    const state = expectStatus(await ada.browser.request('GET', taskAgentPath(held.task.id)), 200) as TaskAgentState;
    assert.deepEqual([state.line, state.canStop], ['working', true], 'Ada is the space\'s admin: she may stop any run');
    assert.equal((expectStatus(await jonas.browser.request('GET', taskAgentPath(held.task.id)), 200) as TaskAgentState).canStop, false, 'Jonas asked, so he cannot stop the other owner\'s answer');
    assert.equal((await jonas.browser.request('POST', taskAgentStopPath(held.task.id), { body: {} })).status, 403);
    assert.equal((expectStatus(await maja.browser.request('GET', taskAgentPath(held.task.id)), 200) as TaskAgentState).canStop, true);
    expectStatus(await maja.browser.request('POST', taskAgentStopPath(held.task.id), { body: {} }), 202);
    assert.equal((await runRow(answer.run.id)).stop_requested_by, maja.id);
    const majaName = names.maja!;
    await waitFor(async () => (await thread(held.task.id)).includes(`Stopped by ${majaName}.`), 'the thread to say who stopped it');
    await waitFor(async () => (await readTask(held.task.id)).owner?.kind === 'human', 'the task to go back to Ada');
    assert.ok((await thread(held.task.id)).includes(`Assistant (${names.maja}'s agent) didn't answer. This needs a person.`));
  });

  test('N3: an answer paused by the provider\'s limit shows as paused, and when it resumes its answer is used', async () => {
    const held = await asked('Paused answer', '{"agent": "Fieldbot", "question": "Which?"}');
    await waitFor(async () => (await readTask(held.task.id)).owner?.kind === 'human', 'the first exchange to end');
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [held.task.id, agents.jonas]);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(held.task.id)), 200) as TaskDiscussion;
    const start = (clientRunId: string) => db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { kind: 'task_answer', ownerUserId: maja.id, agentId: agents.maja!,
      workId: held.task.id, projectId: space.id, conversationId: talk.conversationId!, prompt: 'Which?', clientRunId, askedByRunId: held.run.id, exchangeTurn: 1, audience: [ada.id, jonas.id, maja.id] }));
    const first = await start(randomUUID()); const resumed = await start(randomUUID());
    assert.ok(first.started && resumed.started);
    // The limit: the first run ended, and a run of the same question waits for the reset.
    await pool.query(`UPDATE personal_runs SET retry_of_run_id = $2, resume_at = now() + interval '1 hour', end_reason = 'plan_limit' WHERE id = $1`, [resumed.run.id, first.run.id]);
    await pool.query(`UPDATE personal_runs SET status = 'unavailable', end_reason = 'plan_limit', plan_limit_resets_at = now() + interval '1 hour', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [first.run.id]);
    await waitFor(async () => (await pool.query(`SELECT 1 FROM agent_task_events WHERE run_id = $1 AND handled_at IS NOT NULL`, [first.run.id])).rowCount === 1, 'the end of the first run to be handled');
    const state = expectStatus(await ada.browser.request('GET', taskAgentPath(held.task.id)), 200) as TaskAgentState;
    assert.equal(state.line, 'paused_by_limit', state.text);
    assert.match(state.text, /^Waiting for Assistant to answer · /);
    assert.ok(state.resumesAt, 'when it resumes');
    assert.ok(!(await thread(held.task.id)).some((line) => line.includes('didn\'t answer')), 'a paused answer is not "didn\'t answer"');
    assert.equal((await readTask(held.task.id)).owner?.kind, 'agent', 'and the task is still waiting with the agent that asked');
    // It resumes and answers: the answer is posted, not thrown away.
    await pool.query(`UPDATE personal_runs SET status = 'completed', resume_at = NULL, completed_at = now(), committed_at = now(), answer_body = '0.82 V means full.', cost_state = 'released', charged_micros = 0 WHERE id = $1`, [resumed.run.id]);
    await waitFor(async () => (await thread(held.task.id)).includes('0.82 V means full.'), 'the resumed answer to be posted');
  });
});
