import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import { assistantChangeActionPath, assistantRunChangesActionPath, conversationAssistantChangesPath, projectWorkDetailPath, taskAgentPath, taskAgentStopPath, taskDiscussionPath, workItemPath,
  type AssistantChange, type AssistantChangeDecision, type AssistantRunUndone, type Conversation, type TaskAgentState, type TaskDiscussion, type WorkDetailProjection, type WorkItem } from '@flux/contracts';
import { agentLabel, answerLines, askableLines, MAX_EXCHANGE_TURNS, resolveAsked, takeAsk, taskAgentState, type Askable, type Principal, type TaskAgentFacts } from '@flux/core';
import { personalRunPorts, personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { db, pool } from './support/db.js';
import { eventNow, withFault } from './support/db-faults.js';
import { assistantScene, text, result, type AssistantScene } from './support/assistant-scene.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, workspace as createWorkspace, type Person } from './support/people.js';
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
  let workspaceId = '';
  const agents: Record<string, string> = {};

  const thread = async (id: string) => {
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(id)), 200) as TaskDiscussion;
    return [...new Map([talk.root, ...talk.messages].filter(Boolean).map((message) => [message!.id, message!])).values()].sort((a, b) => a.sequence - b.sequence).map((message) => message.body);
  };
  const readTask = async (id: string) => expectStatus(await ada.browser.request('GET', workItemPath(id)), 200) as WorkItem;
  const runRow = async (id: string) => (await pool.query('SELECT status, end_reason, stop_requested_by FROM personal_runs WHERE id = $1', [id])).rows[0] as
    { status: string; end_reason: string | null; stop_requested_by: string | null };

  /** Ada (the space's admin) made a task, Maja wrote in it, and Jonas's agent Planner holds it with a finished report that asks `ask`. */
  async function asked(title: string, ask: string, where: Awaited<ReturnType<typeof createProject>> = space) {
    const task = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${where.id}/work`, { body: { title } }), 201) as WorkItem;
    expectStatus(await maja.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'I can help with the readings', clientMessageId: randomUUID() } }), 201);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const started = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { ownerUserId: jonas.id, agentId: agents.jonas!, workId: task.id, projectId: where.id,
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
    workspaceId = ws.id;
    for (const member of [jonas, maja]) await addMember(ada, ws.id, member, 'member');
    space = await createProject(ada, ws.id, 'Rain barrel monitor', 'workspace');
    for (const [key, someone] of [['ada', ada], ['jonas', jonas], ['maja', maja]] as const) names[key] = (await pool.query('SELECT name FROM auth_users WHERE id = $1', [someone.id])).rows[0].name as string;
    // Everyone's first agent is called Assistant; Jonas's, which asks, is called Planner so that Ada's and Maja's are the ones that collide.
    // Jonas has a second agent, Reviewer, which Planner may ask: his own owner is one of the task's people (#924).
    for (const [key, someone, name] of [['jonas', jonas, 'Planner'], ['ada', ada, 'Assistant'], ['maja', maja, 'Assistant'], ['reviewer', jonas, 'Reviewer']] as const) {
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
    assert.ok(state.text.startsWith(`Waiting for Assistant (${names.maja!.split(' ')[0]}'s agent) to answer · `), `whose agent is waited for: ${state.text}`);
    assert.ok(state.resumesAt, 'when it resumes');
    assert.ok(!(await thread(held.task.id)).some((line) => line.includes('didn\'t answer')), 'a paused answer is not "didn\'t answer"');
    assert.equal((await readTask(held.task.id)).owner?.kind, 'agent', 'and the task is still waiting with the agent that asked');
    // It resumes and answers: the answer is posted, not thrown away.
    await pool.query(`UPDATE personal_runs SET status = 'completed', resume_at = NULL, completed_at = now(), committed_at = now(), answer_body = '0.82 V means full.', cost_state = 'released', charged_micros = 0 WHERE id = $1`, [resumed.run.id]);
    await waitFor(async () => (await thread(held.task.id)).includes('0.82 V means full.'), 'the resumed answer to be posted');
  });

  test('#923, #938 (TA-3): the owner of an agent can always delete a line it put in the thread, whoever answered it; no one else can', async () => {
    const held = await asked('Undo the answer', '{"agent": "Fieldbot", "question": "Which?"}');
    await waitFor(async () => (await readTask(held.task.id)).owner?.kind === 'human', 'the first exchange to end');
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [held.task.id, agents.jonas]);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(held.task.id)), 200) as TaskDiscussion;
    const answer = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { kind: 'task_answer', ownerUserId: maja.id, agentId: agents.maja!, workId: held.task.id,
      projectId: space.id, conversationId: talk.conversationId!, prompt: 'Which?', clientRunId: randomUUID(), askedByRunId: held.run.id, exchangeTurn: 1, audience: [ada.id, jonas.id, maja.id] }));
    assert.ok(answer.started, JSON.stringify(answer));
    await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = 'The 0.82 V reading means full.', cost_state = 'released', charged_micros = 0 WHERE id = $1`, [answer.run.id]);
    // Posted; then the asker cannot go on (this composition has no provider) and says so, as an agent, and the task goes back to Jonas.
    await waitFor(async () => (await thread(held.task.id)).includes('The 0.82 V reading means full.') && (await readTask(held.task.id)).owner?.kind === 'human', 'the exchange to end');
    const changes = async (viewer: Person) => (expectStatus(await viewer.browser.request('GET', conversationAssistantChangesPath(talk.conversationId!)), 200) as { items: AssistantChange[] }).items;
    const posts = (await changes(maja)).filter((change) => change.operation === 'conversation.reply' && change.runId === answer.run.id);
    assert.equal(posts.length, 1, 'the answer is its run\'s change');
    const post = posts[0]!;
    assert.deepEqual([post.objectType, post.state, post.undoable, post.owner.id], ['message', 'applied', true, maja.id]);
    assert.equal((await changes(jonas)).find((change) => change.id === post.id)?.undoable, false, 'Jonas can read it, but it is not his to take back');
    const refused = expectStatus(await jonas.browser.request('POST', assistantChangeActionPath(post.id, 'undo'), { body: {} }), 200) as AssistantChangeDecision;
    assert.equal(refused.message, `Only ${names.maja} can take back what their agent made`, 'and the server says so');
    assert.equal(refused.change.state, 'applied');
    // The run's own Undo leaves a line in a thread to its Undo.
    expectStatus(await maja.browser.request('POST', assistantRunChangesActionPath(answer.run.id, 'undo'), { body: {} }), 200) as AssistantRunUndone;
    assert.ok((await thread(held.task.id)).includes('The 0.82 V reading means full.'), 'the run\'s Undo did not take the line');
    const report = (await changes(jonas)).find((change) => change.operation === 'conversation.reply' && change.runId === held.run.id);
    assert.ok(report?.undoable, 'Jonas\'s own report is his to delete');
    // A person answers both lines. The owner's right does not wait for their silence (TA-3): the lines go to a marker that keeps their
    // place, and everyone reads who removed them.
    expectStatus(await ada.browser.request('POST', taskDiscussionPath(held.task.id), { body: { body: 'Thanks, I read the report and the answer', clientMessageId: randomUUID() } }), 201);
    const undone = expectStatus(await maja.browser.request('POST', assistantChangeActionPath(post.id, 'undo'), { body: {} }), 200) as AssistantChangeDecision;
    assert.equal(undone.message, null, 'deleted although a person replied after it');
    const after = (await changes(ada)).find((change) => change.id === post.id)!;
    assert.deepEqual([after.state, after.line], ['undone', `Removed by ${names.maja}`], 'everyone who reads the task sees who removed it');
    assert.ok(!(await thread(held.task.id)).includes('The 0.82 V reading means full.'), 'the line is gone from the thread');
    const deleted = expectStatus(await jonas.browser.request('POST', assistantChangeActionPath(report!.id, 'undo'), { body: {} }), 200) as AssistantChangeDecision;
    assert.equal(deleted.message, null);
    assert.equal(deleted.change.line, `Removed by ${names.jonas}`);
    const lines = await thread(held.task.id);
    assert.equal(lines.filter((line) => line === '[Removed]').length, 2, 'two markers keep their places');
    assert.ok(lines.includes('Thanks, I read the report and the answer'), 'and the person\'s own line stays');
    // Once deleted it is gone: a second try changes nothing.
    assert.equal((expectStatus(await jonas.browser.request('POST', assistantChangeActionPath(report!.id, 'undo'), { body: {} }), 200) as AssistantChangeDecision).change.state, 'undone');
  });

  test('#961: an owner taken out of the space can no longer delete their agent\'s line; put back, they can', async () => {
    const closed = await createProject(ada, workspaceId, 'Closed rain barrels', 'restricted');
    for (const member of [jonas, maja]) await grant(ada, closed.id, member, 'contributor');
    const held = await asked('A line in a closed space', '{"agent": "Fieldbot", "question": "Which?"}', closed);
    await waitFor(async () => (await readTask(held.task.id)).owner?.kind === 'human', 'the exchange to end');
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(held.task.id)), 200) as TaskDiscussion;
    const report = ((expectStatus(await jonas.browser.request('GET', conversationAssistantChangesPath(talk.conversationId!)), 200) as { items: AssistantChange[] }).items)
      .find((change) => change.operation === 'conversation.reply' && change.runId === held.run.id);
    assert.ok(report?.undoable, 'Jonas\'s report is his to delete while he is in the space');
    await removeFromSpace(ada, closed.id, jonas);
    const refused = await jonas.browser.request('POST', assistantChangeActionPath(report!.id, 'undo'), { body: {} });
    assert.equal(refused.status, 404, refused.text);
    assert.ok((await thread(held.task.id)).includes('I compared the readings.'), 'and the line is still there');
    await grant(ada, closed.id, jonas, 'contributor');
    const deleted = expectStatus(await jonas.browser.request('POST', assistantChangeActionPath(report!.id, 'undo'), { body: {} }), 200) as AssistantChangeDecision;
    assert.equal(deleted.change.state, 'undone', 'back in the space he can');
  });

  test('#938: an answer that cannot be handled gives up in the asker\'s name: the thread says so and the task goes back to its owner', async () => {
    const held = await asked('Answer that cannot be posted', '{"agent": "Fieldbot", "question": "Which?"}');
    await waitFor(async () => (await readTask(held.task.id)).owner?.kind === 'human', 'the first exchange to end');
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [held.task.id, agents.jonas]);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(held.task.id)), 200) as TaskDiscussion;
    const answer = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { kind: 'task_answer', ownerUserId: maja.id, agentId: agents.maja!, workId: held.task.id,
      projectId: space.id, conversationId: talk.conversationId!, prompt: 'Which?', clientRunId: randomUUID(), askedByRunId: held.run.id, exchangeTurn: 1, audience: [ada.id, jonas.id, maja.id] }));
    assert.ok(answer.started, JSON.stringify(answer));
    // The answer cannot be posted (a fault in the database for this text), so its `finished` event fails every time. The asker (Jonas's
    // Planner) still holds the task and waits for it: giving up must not leave it with no run and no line.
    await withFault(pool, { name: `atq_answer_${answer.run.id.replace(/-/g, '')}`, table: 'project_messages', on: 'INSERT', when: `NEW.body = 'The faulty answer'`, body: `RAISE EXCEPTION 'injected fault';` }, async () => {
      await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = 'The faulty answer', cost_state = 'released', charged_micros = 0 WHERE id = $1`, [answer.run.id]);
      await waitFor(async () => (await eventNow(pool, { runId: answer.run.id, kind: 'finished' })).handled_at, 'the answer\'s end to be given up', 60_000);
    });
    const lines = await thread(held.task.id);
    assert.ok(lines.includes('I couldn\'t get an answer. It\'s back with you.'), lines.join(' | '));
    assert.ok(!lines.includes('The faulty answer'));
    assert.equal((await readTask(held.task.id)).owner?.kind, 'human', 'the asker no longer waits with the task');
  });

  /** The task is Planner's again, waiting, and Maja's agent has started to answer it. */
  async function answering(title: string) {
    const held = await asked(title, '{"agent": "Fieldbot", "question": "Which?"}');
    await waitFor(async () => (await readTask(held.task.id)).owner?.kind === 'human', 'the first exchange to end');
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [held.task.id, agents.jonas]);
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(held.task.id)), 200) as TaskDiscussion;
    const answer = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { kind: 'task_answer', ownerUserId: maja.id, agentId: agents.maja!,
      workId: held.task.id, projectId: space.id, conversationId: talk.conversationId!, prompt: 'Which?', clientRunId: randomUUID(), askedByRunId: held.run.id, exchangeTurn: 1, audience: [ada.id, jonas.id, maja.id] }));
    assert.ok(answer.started, JSON.stringify(answer));
    return { held, answer: answer.run };
  }
  const complete = (runId: string, body: string) => pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = $2, cost_state = 'released', charged_micros = 0 WHERE id = $1`, [runId, body]);
  const handled = (runId: string) => waitFor(async () => (await pool.query(`SELECT 1 FROM agent_task_events WHERE run_id = $1 AND handled_at IS NOT NULL`, [runId])).rowCount === 1, 'the end of the run to be handled');

  test('#924: an answer that ends with an <ask> block is posted without it, and it starts no further question', async () => {
    const { held, answer } = await answering('Answer with a block');
    await complete(answer.id, 'The 0.82 V reading means full.\n<ask>{"agent": "Planner", "owner": "' + names.jonas + '", "question": "And the south barrel?"}</ask>');
    await handled(answer.id);
    const lines = await thread(held.task.id);
    assert.ok(lines.includes('The 0.82 V reading means full.'), lines.join(' | '));
    assert.ok(lines.every((line) => !line.includes('<ask>') && !line.includes('south barrel')), `no block is shown as markup: ${lines.join(' | ')}`);
    assert.deepEqual((await answerRuns(held.task.id)).length, 1, 'the block asked nobody anything');
  });

  test('#924: the asking owner takes the task back while it is answered: the answer is still posted, nobody goes on with it and no one is asked again', async () => {
    const { held, answer } = await answering('Taken back during the answer');
    await pool.query('UPDATE project_work_items SET owner_agent_id = NULL, owner_user_id = $2, version = version + 1 WHERE id = $1', [held.task.id, jonas.id]);
    await complete(answer.id, 'The 0.82 V reading means full.');
    await handled(answer.id);
    assert.ok((await thread(held.task.id)).includes('The 0.82 V reading means full.'), 'what Maja\'s owner paid for is posted');
    const now = await readTask(held.task.id);
    assert.deepEqual([now.owner?.kind, now.owner?.id], ['human', jonas.id], 'the task stays where its owner put it');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM personal_runs WHERE work_id = $1`, [held.task.id])).rows[0].n, 2, 'no run went on with the answer');
  });

  test('#924: an agent may ask another agent of its own owner, which is one of the task\'s people, but never itself', async () => {
    const own = await asked('Ask my owner\'s other agent', '{"agent": "Reviewer", "question": "Which?"}');
    await waitFor(async () => (await readTask(own.task.id)).owner?.kind === 'human', 'the task to go back to Ada');
    const lines = await thread(own.task.id);
    assert.ok(lines.includes(`@Reviewer (${names.jonas}'s agent), Which?`), `the question reaches Jonas's other agent: ${lines.join(' | ')}`);
    assert.ok(!lines.some((line) => line.includes('they are not in this task')), lines.join(' | '));
    const itself = await asked('Ask itself', '{"agent": "Planner", "owner": "' + names.jonas + '", "question": "Which?"}');
    await waitFor(async () => (await readTask(itself.task.id)).owner?.kind === 'human', 'the task to go back to Ada');
    assert.ok((await thread(itself.task.id)).includes(`I can't ask Planner (${names.jonas}'s agent): they are not in this task. This needs a person.`), 'an agent is not offered itself');
    assert.deepEqual(await answerRuns(itself.task.id), []);
  });

  test('C-51: after five agent messages in a row a run\'s report is still posted, and it gives no agent another turn', async () => {
    const task = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${space.id}/work`, { body: { title: 'Compare the two barrels' } }), 201) as WorkItem;
    expectStatus(await maja.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'Please compare them', clientMessageId: randomUUID() } }), 201);
    const planner: Principal = { kind: 'agent', id: agents.jonas! };
    const write = (body: string) => taskDiscussionUseCases(db).contribute(planner, task.id, { body, clientMessageId: randomUUID() });
    const limited = (error: unknown) => (error as { code?: string }).code === 'AGENT_TURN_LIMIT';
    for (let i = 1; i <= 5; i++) await write(`Earlier agent line ${i}`);
    await assert.rejects(write('A sixth line'), limited, 'the agent\'s own sixth message waits for a person');
    const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const started = await db.transaction((tx) => runs.startTask(personalRunPorts(tx, queue.factory), { ownerUserId: jonas.id, agentId: agents.jonas!, workId: task.id, projectId: space.id,
      conversationId: talk.conversationId!, prompt: `Task #${task.number}: Compare the two barrels`, clientRunId: randomUUID() }));
    assert.ok(started.started, JSON.stringify(started));
    await pool.query('UPDATE project_work_items SET owner_user_id = NULL, owner_agent_id = $2, version = version + 1 WHERE id = $1', [task.id, agents.jonas]);
    // The run ends: the drain posts its report as Planner's line, and the task follows "What it may do" as after any report.
    await complete(started.run.id, 'The north barrel reads full at 92 cm.');
    await waitFor(async () => (await readTask(task.id)).owner?.kind !== 'agent' || (await readTask(task.id)).status === 'done', 'the run\'s end to be handled');
    const lines = await thread(task.id);
    assert.deepEqual(lines.slice(-2), ['Earlier agent line 5', 'The north barrel reads full at 92 cm.'], lines.join(' | '));
    // The report is Flux's line for the agent: it was not counted against the five, and it does not give a tool another turn either.
    await assert.rejects(write('Still the sixth'), limited);
    expectStatus(await maja.browser.request('POST', taskDiscussionPath(task.id), { body: { body: 'Thanks, go on', clientMessageId: randomUUID() } }), 201);
    assert.equal((await write('After a person')).body, 'After a person');
  });
});

describe('an answer uses only what the task\'s people can all see (TA-4, #841, #924)', () => {
  const tag = randomBytes(4).toString('hex');
  const DM = `ta4dm${tag}`; const PRIVATE_MAP = `ta4private${tag}`; const ELSEWHERE = `ta4elsewhere${tag}`; const SHARED = `ta4shared${tag}`;

  test('a private map, a DM and a space the others are not in reach neither the provider nor the answer\'s tools; what everyone sees does', async () => {
    const scene = await assistantScene('ta4');
    const { owner, peer, ws, place, agentId, lead } = scene;
    const post = async (who: Person, path: string, body: unknown) => expectStatus(await who.browser.request('POST', path, { body }), 201) as { id: string };
    // Everything the answering owner (Ada) can read that the other people of the task (Jonas) cannot.
    const elsewhere = await createProject(lead, ws.id, 'Ada elsewhere', 'restricted');
    await grant(lead, elsewhere.id, owner, 'manager');
    const elsewhereDoc = await post(owner, `/api/v1/projects/${elsewhere.id}/docs`, { title: 'Elsewhere', body: ELSEWHERE });
    const privateMap = await post(owner, `/api/v1/workspaces/${ws.id}/sketches`, { title: PRIVATE_MAP, scope: 'private' });
    await post(owner, `/api/v1/sketches/${privateMap.id}/thoughts`, { text: PRIVATE_MAP, x: 0, y: 0 });
    const opened = await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [lead.id] } });
    assert.ok(opened.status === 201 || opened.status === 200, `open DM: ${opened.status}`);
    await post(owner, `/api/v1/dms/${(opened.json as { id: string }).id}/messages`, { body: DM, clientMessageId: randomUUID() });
    // What the task's people share.
    await post(owner, `/api/v1/projects/${place.id}/docs`, { title: 'Shared reading', body: `The 0.82 V reading means full. ${SHARED}` });
    const task = await scene.task(owner, 'Which reading means full?');
    await post(peer, taskDiscussionPath(task.id), { body: 'I need the reading', clientMessageId: randomUUID() });
    const talk = expectStatus(await owner.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
    const started = await db.transaction((tx) => scene.runs.startTask(personalRunPorts(tx, scene.queue.factory), { kind: 'task_answer', ownerUserId: owner.id, agentId, workId: task.id,
      projectId: place.id, conversationId: talk.conversationId!, prompt: 'Which reading means full?', clientRunId: randomUUID(), exchangeTurn: 1, audience: [owner.id, peer.id] }));
    assert.ok(started.started, JSON.stringify(started));
    scene.compute.dispatched = [];
    scene.compute.respond = async () => scene.compute.dispatched.length === 1
      ? { kind: 'completed', text: 'looking', stopReason: 'tool_use', usage: { inputTokens: 800, outputTokens: 40 }, toolCalls: [
        { id: 's1', name: 'flux_search_project', input: { projectId: place.id, q: 'reading' } },
        { id: 's2', name: 'flux_search_project', input: { projectId: place.id, q: 'ta4' } },
        { id: 's3', name: 'flux_list_maps', input: { projectId: place.id } },
        { id: 's4', name: 'flux_get_doc', input: { projectId: elsewhere.id, id: elsewhereDoc.id } },
        { id: 's5', name: 'flux_list_contexts', input: {} },
      ] }
      : { kind: 'completed', text: '0.82 V means full.', stopReason: 'end_turn', usage: { inputTokens: 800, outputTokens: 40 } };
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    const sent = JSON.stringify(scene.compute.dispatched);
    for (const canary of [DM, PRIVATE_MAP, ELSEWHERE]) assert.ok(!sent.includes(canary), `${canary} never reaches the provider`);
    assert.ok(sent.includes(SHARED), 'control: what every person of the task can see is read');
    const tools = (scene.compute.dispatched[0]?.tools ?? []).map((tool) => tool.name);
    assert.ok(tools.length > 0 && tools.every((name) => !/create|update|delete|apply|undo/.test(name)), `an answer reads only: ${tools.join(', ')}`);
  });
});
