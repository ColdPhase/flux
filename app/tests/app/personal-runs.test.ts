import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { recoverPersonalRuns, runReservationMicros, type PersonalRunHooks, type Principal } from '@flux/core';
import {
  type AssistantRun, type Conversation, type Decision, type Page, type PersonalAssistantStatus,
  type Project, type WorkItem, type Workspace,
} from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { workUseCases } from '../../apps/server/src/work/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, removeMember, workspace as createWorkspace, type Person } from './support/people.js';
import { chooseModel, FAKE_PRICE, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';
import { StreamClient } from './support/stream.js';
import { waitFor } from './support/wait.js';

// Owner-invoked personal assistant runs (#68, decision O-008). HTTP routes run against the API container's production composition, where
// nobody has a key connection yet (#124) and the provider is off, so every route fails closed there. Runs that reach dispatch are driven in
// this process through the same core use cases and worker processor, with the test-only fakes of `support/personal-runs.ts` (a fake connection
// lookup and a fake queue) and, since every agent runs in pi in the agent runtime (#1441, RT-1), a runtime of its own (support/pi-runtime.ts):
// the real supervisor and the real pinned pi, whose model is a script of the fake model gateway. No model is called; none of these tests is a
// provider, billing or compatibility pass. Flux's model gateway charges each request on the run's row; the fake gateway charges nothing, so a
// test that needs a charge writes it there, as the gateway does.

const connections = new FakeConnections();
const queue = new FakeQueue();
const hooks: PersonalRunHooks = {};
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });

const TOKENS = {
  dm: `DM-SECRET-${randomUUID()}`,
  sketch: `PRIVATE-SKETCH-${randomUUID()}`,
  otherProject: `OTHER-PROJECT-${randomUUID()}`,
};

const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

async function post<T>(someone: Person, path: string, body: unknown, status = 201): Promise<T> {
  return expectStatus(await someone.browser.request('POST', path, { body }), status, `POST ${path}`) as T;
}

async function row(runId: string) {
  const result = await pool.query('SELECT status, end_reason, cost_state, charged_micros, reserved_micros, answer_body, stopped_at_stage FROM personal_runs WHERE id = $1', [runId]);
  return result.rows[0] as { status: string; end_reason: string | null; cost_state: string; charged_micros: number; reserved_micros: number; answer_body: string | null; stopped_at_stage: string | null };
}

async function runCount(ownerId: string) {
  return (await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id = $1', [ownerId])).rows[0].n as number;
}

describe('personal assistant runs (#68, pi in the runtime on a scripted model: no provider pass is claimed)', () => {
  let ada: Person; let hubert: Person; let maurycy: Person; let kai: Person; let viewer: Person; let lee: Person; let outsider: Person;
  let ws: Workspace; let lamp: Project; let other: Project;
  let thread: Conversation; let work: WorkItem;
  const agents: Record<string, string> = {};
  let projectSketch: { id: string; thoughtId: string };
  let privateSketch: { id: string; thoughtId: string };
  let answeredRunId = '';
  /** Everything pi's model was sent on the run AC-1 answers: the brief, the tools offered and what they returned. */
  let answeredInput = '';
  let pi: PiRuntime;
  let processor: ReturnType<PiRuntime['processor']>;
  const hubertConnection = randomUUID();
  const maurycyConnection = randomUUID();

  const ask = (someone: Person, prompt = 'Summarize where we are', extra: Record<string, unknown> = {}) =>
    runs.invoke(human(someone), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt, ...extra });

  /** Hubert removed from the space: his assistant loses it with him (F-036 AG-3). */
  async function keepHubertOut() {
    await removeFromSpace(ada, lamp.id, hubert);
  }
  async function letHubertBack() {
    await grant(ada, lamp.id, hubert, 'contributor');
  }
  async function enable(someone: Person, name: string, connectionId: string) {
    connections.connect(someone.id, connectionId);
    const enabled = await runs.enable(human(someone), { agentId: agents[name]!, connection: connectionId, model: 'claude-sonnet-5' });
    await pi.place(someone.id);
    return enabled;
  }

  before(async () => {
    pi = await startPiRuntime();
    processor = pi.processor(connections, { hooks, stopPollMs: 20 });
    [ada, hubert, maurycy, kai, viewer, lee, outsider] = await Promise.all(['pr-ada', 'pr-hubert', 'pr-maurycy', 'pr-kai', 'pr-viewer', 'pr-lee', 'pr-outsider'].map(person));
    ws = await createWorkspace(ada, 'Gesture lamp');
    for (const member of [hubert, maurycy, kai, viewer, lee]) await addMember(ada, ws.id, member, 'member');
    lamp = await createProject(ada, ws.id, 'Lamp sensor', 'restricted');
    other = await createProject(ada, ws.id, 'Payroll', 'restricted');
    for (const member of [hubert, maurycy, kai, viewer, lee]) await grant(ada, lamp.id, member, 'contributor');
    await post(ada, `/api/v1/projects/${other.id}/grants`, { principal: { kind: 'human', id: hubert.id }, role: 'contributor' });
    for (const [name, someone] of [['hubert', hubert], ['maurycy', maurycy], ['lee', lee]] as const) {
      agents[name] = (await post<{ id: string }>(someone, `/api/v1/workspaces/${ws.id}/agents`, { name: `${name} assistant`, owner: 'self' })).id;
    }

    thread = await post<Conversation>(kai, `/api/v1/projects/${lamp.id}/conversations`, { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() });
    await post(hubert, `/api/v1/conversations/${thread.id}/messages`, { body: 'The ToF sensor kept working with swipe + hold', clientMessageId: randomUUID() });
    work = await post<WorkItem>(kai, `/api/v1/projects/${lamp.id}/work`, { title: 'Camera in low light', owner: { kind: 'human', id: kai.id } });

    // Material the owner can open but a project run must never read.
    const payroll = await post<Conversation>(ada, `/api/v1/projects/${other.id}/conversations`, { body: `Salaries ${TOKENS.otherProject}`, clientMessageId: randomUUID() });
    assert.ok(payroll.id);
    const dm = await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [kai.id] });
    await post(hubert, `/api/v1/dms/${dm.id}/messages`, { body: `Between us: ${TOKENS.dm}`, clientMessageId: randomUUID() });
    const mine = await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'My private map', scope: 'private' });
    privateSketch = { id: mine.id, thoughtId: (await post<{ thought: { id: string } }>(hubert, `/api/v1/sketches/${mine.id}/thoughts`, { text: TOKENS.sketch, x: 0, y: 0 })).thought.id };
    const shared = await post<{ id: string }>(kai, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Sensor options', scope: 'project', projectId: lamp.id });
    projectSketch = { id: shared.id, thoughtId: (await post<{ thought: { id: string } }>(kai, `/api/v1/sketches/${shared.id}/thoughts`, { text: 'ToF sensor: swipe + hold', x: 10, y: 10 })).thought.id };

    await enable(hubert, 'hubert', hubertConnection);
  });
  after(async () => { await pi.close(); });

  test('AC-4: the production composition fails closed with an explicit state and human work continues', async () => {
    const status = expectStatus(await hubert.browser.request('GET', '/api/v1/personal-assistant'), 200) as PersonalAssistantStatus;
    assert.equal(status.state, 'unavailable');
    assert.equal(status.unavailableReason, 'provider_off');
    assert.deepEqual(status.setup, { provider: 'off', connection: 'none', runtime: { state: 'off', payer: null, accountLabel: null, client: null } }, 'the UI can say why, truthfully');
    assert.deepEqual([status.enablement?.connection, status.enablement?.engine, status.enablement?.model], [hubertConnection, 'server', 'claude-sonnet-5']);
    const refused = await hubert.browser.request('POST', `/api/v1/conversations/${thread.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'Summarize' } });
    assert.equal(refused.status, 503, refused.text);
    assert.deepEqual([(refused.json as { code: string }).code, (refused.json as { reason: string }).reason], ['PERSONAL_RUN_UNAVAILABLE', 'provider_off']);
    assert.equal(await runCount(hubert.id), 0, 'a refused invoke writes no run and reserves nothing');
    assert.equal((expectStatus(await maurycy.browser.request('GET', '/api/v1/personal-assistant'), 200) as PersonalAssistantStatus).state, 'not_enabled');
    // Without a connection of one's own there is no model to pick (#854); nothing else is asked.
    const enable = await maurycy.browser.request('POST', '/api/v1/my-agents', { body: { agentId: agents.maurycy, connection: randomUUID(), model: 'claude-sonnet-5' } });
    assert.equal((enable.json as { code: string }).code, 'ASSISTANT_MODEL_UNAVAILABLE', enable.text);
    const foreign = await maurycy.browser.request('POST', '/api/v1/my-agents', { body: { agentId: agents.hubert, connection: 'claude_plan', model: 'sonnet' } });
    assert.equal(foreign.status, 403, 'another person\'s agent cannot be enabled');

    // In the fake composition: no connection means an explicit unavailable state, never a fallback.
    connections.disconnect(hubert.id);
    assert.deepEqual([(await runs.status(human(hubert))).unavailableReason, (await runs.status(human(hubert))).setup.connection], ['no_connection', 'none']);
    await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_UNAVAILABLE' });
    connections.connect(hubert.id, randomUUID());
    const changed = await runs.status(human(hubert));
    assert.equal(changed.unavailableReason, 'connection_changed', 'another key is never used by itself: the owner picks a model of it');
    assert.equal(changed.setup.connection, 'active', 'setup does not also claim that no key is connected (#192 note 5)');
    connections.connect(hubert.id, hubertConnection);
    assert.equal((await runs.status(human(hubert))).state, 'ready');
    assert.equal(await runCount(hubert.id), 0);
    assert.equal(pi.gateway.requests.length, 0);
    await post(kai, `/api/v1/conversations/${thread.id}/messages`, { body: 'Let us compare the ToF sensor next', clientMessageId: randomUUID() });
  });

  test('AC-1: another person reaches the owner\'s assistant by no route, and no model call or usage happens for the owner', async () => {
    const invokePath = `/api/v1/conversations/${thread.id}/assistant-runs`;
    const body = { clientRunId: randomUUID(), kind: 'ask' as const, prompt: 'Use Hubert\'s AI' };
    const notEnabled = await maurycy.browser.request('POST', invokePath, { body });
    assert.deepEqual([notEnabled.status, (notEnabled.json as { code: string }).code], [409, 'PERSONAL_RUN_NOT_ENABLED']);
    for (const claim of [{ ownerId: hubert.id }, { agentId: agents.hubert }, { connectionId: hubertConnection }]) {
      const response = await maurycy.browser.request('POST', invokePath, { body: { ...body, clientRunId: randomUUID(), ...claim } });
      assert.deepEqual([response.status, (response.json as { code: string }).code], [403, 'PERSONAL_RUN_NOT_OWNER'], JSON.stringify(claim));
    }
    await assert.rejects(runs.invoke(human(maurycy), thread.id, { ...body, clientRunId: randomUUID(), connectionId: hubertConnection }), { code: 'PERSONAL_RUN_NOT_OWNER' });
    // Someone outside the space cannot post an answer into it, even with their own assistant.
    const outside = await outsider.browser.request('POST', invokePath, { body: { ...body, clientRunId: randomUUID() } });
    assert.equal(outside.status, 404);

    const live = await StreamClient.connect(kai.browser);
    await live.ready();
    // pi reads the thread and the space's tasks with Flux tools, then answers citing what it read.
    pi.gateway.script([{ tool: 'mcp__flux__flux_get_conversation', args: { projectId: lamp.id, id: thread.id } }, { tool: 'mcp__flux__flux_list_work', args: { projectId: lamp.id } },
      { text: `The camera fails below 5 lux [message:${thread.messages[0]!.id}], and the task is open [task:${work.id}].` }]);
    const mine = await ask(hubert);
    assert.equal(mine.created, true);
    assert.equal(mine.run.status, 'queued');
    assert.equal(mine.run.cost.state, 'reserved');
    for (const someone of [maurycy, ada, kai]) {
      assert.equal((await someone.browser.request('GET', `/api/v1/assistant-runs/${mine.run.id}`)).status, 404, `${someone.email} reads the run`);
      assert.equal((await someone.browser.request('POST', `/api/v1/assistant-runs/${mine.run.id}/stop`)).status, 404, `${someone.email} stops the run`);
      assert.equal((await someone.browser.request('POST', `/api/v1/assistant-runs/${mine.run.id}/retry`, { body: { clientRunId: randomUUID() } })).status, 404, `${someone.email} retries`);
      const continued = await someone.browser.request('POST', invokePath, { body: { ...body, clientRunId: randomUUID(), continuesRunId: mine.run.id } });
      assert.equal(continued.status, 404, `${someone.email} continues: ${continued.text}`);
      const own = expectStatus(await someone.browser.request('GET', '/api/v1/assistant-runs'), 200) as Page<AssistantRun>;
      assert.equal(own.items.some((item) => item.id === mine.run.id), false);
    }
    await assert.rejects(runs.retry(human(maurycy), mine.run.id, { clientRunId: randomUUID() }), { code: 'ASSISTANT_RUN_NOT_FOUND' });

    // Replying to or mentioning the assistant is an ordinary message; a WebSocket command is ignored.
    await post(maurycy, `/api/v1/conversations/${thread.id}/messages`, { body: '@pr-hubert\'s assistant /ai retry that for me', clientMessageId: randomUUID() });
    const socket = await StreamClient.connect(maurycy.browser);
    socket.socket.send(JSON.stringify({ type: 'assistant.run', conversationId: thread.id, ownerId: hubert.id, connectionId: hubertConnection, clientRunId: randomUUID(), kind: 'ask', prompt: 'x' }));
    socket.socket.send(JSON.stringify({ type: 'assistant.stop', runId: mine.run.id }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await socket.close();

    // A queued job can only name a run id; unknown or malformed ids are skipped without a call.
    assert.equal(await processor.process(randomUUID()), 'skipped');
    assert.equal(await processor.process('not-a-run'), 'skipped');
    assert.equal(pi.gateway.requests.length, 0);
    assert.equal(await runCount(maurycy.id), 0, 'no run was written for the other person');
    assert.equal(await runCount(hubert.id), 1, 'only the owner\'s own invocation exists');
    assert.equal((await row(mine.run.id)).status, 'queued', 'the WebSocket stop was ignored');

    assert.equal(await processor.process(mine.run.id), 'completed', JSON.stringify(pi.lastPi()));
    answeredInput = JSON.stringify(pi.gateway.requests);
    assert.equal(await processor.process(mine.run.id), 'skipped', 'a repeated job never starts pi twice');
    assert.equal(pi.gateway.requests.length, 3, 'two tool calls and the answer, once');
    assert.equal(pi.gateway.requests[0]!.model, 'claude-sonnet-5');
    assert.equal((await pool.query('SELECT connection_id FROM personal_runs WHERE id = $1', [mine.run.id])).rows[0].connection_id, hubertConnection);
    assert.deepEqual(new Set(connections.resolved), new Set([hubert.id]), 'only the owner\'s connection was ever looked up');
    // The answer to `/ai` is its asker's alone (#842): the project's audience is told nothing, not even that it exists.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(live.events.filter((event) => event.kind.startsWith('project.assistant_')), []);
    await live.close();
    const audience = await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind LIKE 'project.assistant_%' AND data->>'runId' = $1`, [mine.run.id]);
    assert.equal(audience.rows[0].n, 0);
    answeredRunId = mine.run.id;
  });

  test('AC-5: DMs, private captures and other projects never reach pi or the answer; sources are openable by the audience', async () => {
    assert.match(answeredInput, /Camera fails below 5 lux/);
    for (const token of Object.values(TOKENS)) assert.equal(answeredInput.includes(token), false, `pi was given ${token}`);

    // The answer is the asker's alone: their own view of it names the agent and the provenance, and nobody else lists it.
    const answer = (await runs.get(human(hubert), answeredRunId)).answer!;
    assert.equal(answer.assistant.label, 'hubert assistant');
    assert.equal(answer.askedBy.id, hubert.id);
    assert.deepEqual(answer.provenance, { provider: 'anthropic', model: 'claude-sonnet-5' });
    for (const token of Object.values(TOKENS)) assert.equal(answer.body.includes(token), false, `answer contains ${token}`);
    const text = JSON.stringify(answer);
    for (const hidden of ['Micros', 'reserved', 'test-key-ref', hubertConnection]) assert.equal(text.includes(hidden), false, `the answer shows ${hidden}`);

    assert.deepEqual(answer.sources.map((source) => source.type), ['message', 'work'], 'what pi read and cited, in the order it cited it');
    const conversation = expectStatus(await viewer.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
    for (const source of answer.sources) {
      if (source.type === 'message') assert.ok(conversation.messages.some((message) => message.id === source.id), 'viewer can open the cited message');
      if (source.type === 'work') expectStatus(await viewer.browser.request('GET', `/api/v1/work/${source.id}`), 200, 'viewer opens the cited work');
      if (source.type === 'thought') expectStatus(await viewer.browser.request('GET', `/api/v1/sketches/${source.sketchId}`), 200, 'viewer opens the cited map');
    }

    // A thought on the owner's private map: the owner may open it, the agent never reads it. pi is told the thought by its ids and asks for the
    // map with a Flux tool, which refuses it; the thought's words are never in what pi was given.
    const privateRun = await runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'map_thought', prompt: 'Expand this', target: { type: 'thought', sketchId: privateSketch.id, thoughtId: privateSketch.thoughtId } });
    pi.gateway.script([{ tool: 'mcp__flux__flux_get_map', args: { projectId: lamp.id, id: privateSketch.id } }, { text: 'I could not read that map.' }]);
    assert.equal(await processor.process(privateRun.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.ok(pi.gateway.requests[0]!.prompt.includes(`thought ${privateSketch.thoughtId} on map ${privateSketch.id}`), 'the brief names the thought');
    assert.equal(pi.gateway.requests[1]!.results.length, 1, 'the tool answered');
    assert.equal(JSON.stringify(pi.gateway.requests).includes(TOKENS.sketch), false, 'the private map\'s words never reached pi');
    assert.equal((await row(privateRun.run.id)).answer_body?.includes(TOKENS.sketch) ?? false, false);
    await assert.rejects(runs.invoke(human(maurycy), thread.id, { clientRunId: randomUUID(), kind: 'map_thought', prompt: 'x', target: { type: 'thought', sketchId: privateSketch.id, thoughtId: privateSketch.thoughtId } }), { code: 'THOUGHT_NOT_FOUND' });

    // The thought on a map of the space is the same, and pi reads its words.
    const mapRun = await runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'map_thought', prompt: 'What next?', target: { type: 'thought', sketchId: projectSketch.id, thoughtId: projectSketch.thoughtId } });
    pi.gateway.script([{ tool: 'mcp__flux__flux_get_map', args: { projectId: lamp.id, id: projectSketch.id } }, { text: 'Next, compare the ToF sensor.' }]);
    assert.equal(await processor.process(mapRun.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.ok(pi.gateway.requests[0]!.prompt.includes(`thought ${projectSketch.thoughtId} on map ${projectSketch.id}`), 'the brief names the thought');
    assert.match(pi.gateway.requests[1]!.results[0] ?? '', /ToF sensor: swipe \+ hold/);
  });

  test('AC-2: denied, stopped-before-read, refused-by-the-gateway and revoked runs cost zero; a retry key never charges twice; the key\'s daily budget pauses a request', async () => {
    pi.gateway.script([]);
    const requested = () => pi.gateway.requests.length;
    const clientRunId = randomUUID();
    const first = await runs.invoke(human(hubert), thread.id, { clientRunId, kind: 'summarize', prompt: 'Summarize' });
    const again = await runs.invoke(human(hubert), thread.id, { clientRunId, kind: 'summarize', prompt: 'Summarize' });
    assert.equal(again.run.id, first.run.id);
    assert.equal(again.created, false);
    await assert.rejects(runs.invoke(human(hubert), thread.id, { clientRunId, kind: 'summarize', prompt: 'Something else' }), { code: 'IDEMPOTENCY_CONFLICT' });
    // F-027 A4: a request waits behind the working one.
    const behind = await ask(hubert);
    assert.equal(behind.run.status, 'queued');
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [behind.run.id]);

    // Stopped before read, through the API.
    const stopped = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${first.run.id}/stop`), 200) as AssistantRun;
    assert.deepEqual([stopped.status, stopped.cost.state, stopped.cost.chargedMicros], ['stopped', 'released', 0]);
    const requestedBefore = requested();
    assert.equal(await processor.process(first.run.id), 'skipped');
    assert.equal(requested(), requestedBefore);

    // Retrying the stopped run twice with the same key creates and charges one run.
    const retryKey = randomUUID();
    const retried = await runs.retry(human(hubert), first.run.id, { clientRunId: retryKey });
    const retriedAgain = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${first.run.id}/retry`, { body: { clientRunId: retryKey } }), 200) as AssistantRun;
    assert.equal(retriedAgain.id, retried.run.id);
    assert.equal(await processor.process(retried.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.equal((await runs.retry(human(hubert), first.run.id, { clientRunId: retryKey })).created, false);
    assert.equal(requested(), requestedBefore + 1);
    const charged = await pool.query(`SELECT count(*)::int AS n, sum(charged_micros)::int AS micros FROM personal_runs WHERE retry_of_run_id = $1`, [first.run.id]);
    assert.equal(charged.rows[0].n, 1);
    assert.equal(charged.rows[0].micros, (await row(retried.run.id)).charged_micros);

    // Denied before read: the agent lost its grant.
    const denied = await ask(hubert);
    await keepHubertOut();
    assert.equal(await processor.process(denied.run.id), 'denied');
    await letHubertBack();
    // Disconnected before dispatch.
    const disconnected = await ask(hubert);
    connections.disconnect(hubert.id);
    assert.equal(await processor.process(disconnected.run.id), 'unavailable');
    connections.connect(hubert.id, hubertConnection);
    // Deleted: queued work ends at once, and a person without an agent has none to ask.
    const revoked = await ask(hubert);
    expectStatus(await hubert.browser.request('DELETE', `/api/v1/my-agents/${agents.hubert}`), 204);
    await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_NOT_ENABLED' });
    agents.hubert = (await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/agents`, { name: 'hubert assistant', owner: 'self' })).id;
    await enable(hubert, 'hubert', hubertConnection);
    for (const run of [denied, disconnected, revoked]) {
      const stored = await row(run.run.id);
      assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], ['released', 0, null], `${stored.status} costs nothing`);
    }
    assert.equal((await row(revoked.run.id)).status, 'revoked');
    assert.equal(requested(), requestedBefore + 1, 'none of them reached the model');

    // The key's one daily budget (#854): a request that finds it used waits for the key's next day; one admitted while budget was left but
    // that finds it used when its turn comes waits too. Nothing is refused and nothing switches. A run in pi needs room for one request with
    // tools to start, at the table price of the fake key's model. Flux's model gateway charges what the run's requests cost on its row; the
    // fake gateway charges nothing, so the cost of the heavy run is written as the gateway writes it.
    const oneRequest = runReservationMicros(FAKE_PRICE, true)!;
    const spend = (await runs.status(human(hubert))).today!;
    const used = spend.chargedMicros + spend.reservedMicros;
    const budget = Math.ceil((used + oneRequest) / 10_000);
    connections.connect(hubert.id, hubertConnection, { dailyBudgetCents: budget });
    const heavy = await ask(hubert);
    assert.equal(heavy.run.resumesAt, null, 'admitted while budget was left');
    assert.equal(await processor.process(heavy.run.id), 'completed', JSON.stringify(pi.lastPi()));
    await pool.query(`UPDATE personal_runs SET cost_state = 'observed', charged_micros = $2 WHERE id = $1`, [heavy.run.id, oneRequest]);
    const waiting = await ask(hubert);
    assert.deepEqual([waiting.run.status, waiting.run.endReason, !!waiting.run.resumesAt], ['queued', 'budget', true], 'it waits for the key\'s next day');
    assert.equal((await runs.status(human(hubert))).state, 'capped');
    assert.equal(await processor.process(waiting.run.id), 'skipped', 'not before its resume time');
    await runs.stop(human(hubert), waiting.run.id);
    connections.connect(hubert.id, hubertConnection, { dailyBudgetCents: budget + 20 });
    const late = await ask(hubert);
    assert.equal(late.run.resumesAt, null, 'admitted while budget was left');
    connections.connect(hubert.id, hubertConnection, { dailyBudgetCents: budget });
    const lateRequests = requested();
    assert.equal(await processor.process(late.run.id), 'skipped', 'paused again when its turn comes');
    const latePaused = await row(late.run.id);
    assert.deepEqual([latePaused.status, latePaused.end_reason, latePaused.reserved_micros], ['queued', 'budget', 0]);
    assert.ok((await pool.query('SELECT resume_at FROM personal_runs WHERE id = $1', [late.run.id])).rows[0].resume_at, 'it resumes by itself');
    assert.equal(requested(), lateRequests, 'nothing was sent');
    await runs.stop(human(hubert), late.run.id);
    connections.connect(hubert.id, hubertConnection);

    // Stopped while pi works: pi is stopped, nothing is committed, and what the gateway charged on the run's row so far is kept.
    pi.gateway.script([{ tool: 'bash', args: { command: 'sleep 30' } }, { text: 'Late answer.' }]);
    const long = await ask(hubert);
    const processing = processor.process(long.run.id);
    await waitFor(async () => pi.gateway.requests.length > 0, 'pi\'s first model request', 20_000);
    await pool.query(`UPDATE personal_runs SET charged_micros = $2 WHERE id = $1`, [long.run.id, 900 * 2 + 40 * 10]);
    expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${long.run.id}/stop`), 200);
    assert.equal(await processing, 'stopped', JSON.stringify(pi.lastPi()));
    const stoppedLate = await row(long.run.id);
    assert.deepEqual([stoppedLate.cost_state, stoppedLate.charged_micros, stoppedLate.answer_body], ['observed', 900 * 2 + 40 * 10, null]);

    // The gateway refuses a request for the key's day (402): the run ends at once, calmly, with nothing posted and nothing charged; Retry is a new run.
    pi.gateway.script([{ status: 402, body: { type: 'error', error: { type: 'flux_budget_exhausted', code: 'flux_budget_exhausted', message: 'The key\'s daily budget cannot hold this request; stop' } } }]);
    const limited = await ask(hubert);
    assert.equal(await processor.process(limited.run.id), 'cap_reached', JSON.stringify(pi.lastPi()));
    const limitedRow = await row(limited.run.id);
    assert.deepEqual([limitedRow.status, limitedRow.end_reason, limitedRow.cost_state, limitedRow.charged_micros, limitedRow.answer_body], ['cap_reached', 'budget', 'released', 0, null]);
    assert.equal(pi.gateway.requests.length, 1, 'pi does not retry a refusal');
    pi.gateway.script([]);
    const retryAfterLimit = await runs.retry(human(hubert), limited.run.id, { clientRunId: randomUUID() });
    assert.notEqual(retryAfterLimit.run.id, limited.run.id, 'Retry is a new run');
    assert.equal(await processor.process(retryAfterLimit.run.id), 'completed', JSON.stringify(pi.lastPi()));

    // A run a crashed worker left dispatching does not block the owner forever; its cost stays unknown.
    const stuck = await ask(hubert);
    await pool.query(`UPDATE personal_runs SET status = 'dispatching', updated_at = now() - interval '2 hours' WHERE id = $1`, [stuck.run.id]);
    const next = await ask(hubert);
    assert.deepEqual([(await row(stuck.run.id)).status, (await row(stuck.run.id)).cost_state], ['provider_failed', 'unknown']);
    assert.equal(await processor.process(next.run.id), 'completed', JSON.stringify(pi.lastPi()));
  });

  test('AC-3: once Maurycy connects, his run uses only his connection and cap; Hubert\'s usage does not change', async () => {
    const hubertBefore = (await runs.status(human(hubert))).today!;
    await enable(maurycy, 'maurycy', maurycyConnection);
    const status = expectStatus(await maurycy.browser.request('GET', '/api/v1/personal-assistant'), 200) as PersonalAssistantStatus;
    assert.equal(status.enablement?.ownerUserId, maurycy.id);
    const mine = await ask(maurycy, 'What did the ToF test show?');
    pi.gateway.script([{ text: 'The ToF sensor kept working.' }]);
    assert.equal(await processor.process(mine.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.equal(pi.gateway.requests.length, 1);
    const stored = await pool.query('SELECT owner_user_id, agent_id, connection_id FROM personal_runs WHERE id = $1', [mine.run.id]);
    assert.deepEqual(stored.rows[0], { owner_user_id: maurycy.id, agent_id: agents.maurycy, connection_id: maurycyConnection });
    // What the run's requests cost is charged on its row, and so on his key's day; the fake gateway charges nothing, so it is written here.
    await pool.query(`UPDATE personal_runs SET cost_state = 'observed', charged_micros = 1840 WHERE id = $1`, [mine.run.id]);
    assert.deepEqual((await runs.status(human(hubert))).today, hubertBefore);
    assert.equal((await runs.status(human(maurycy))).today!.chargedMicros, 1840);
  });

  test('F-024: provider suspension stops the agent before read and before commit; retained consent recovers', async () => {
    const suspend = () => pool.query(`INSERT INTO auth_idp_standing (user_id, provider_id, state, reason)
      VALUES ($1, 'oidc-standing-fixture', 'sign_in_required', 'invalid_grant')
      ON CONFLICT (user_id, provider_id) DO UPDATE SET state = 'sign_in_required'`, [hubert.id]);
    const recover = () => pool.query(`DELETE FROM auth_idp_standing WHERE user_id = $1 AND provider_id = 'oidc-standing-fixture'`, [hubert.id]);
    try {
      for (const stage of ['before_read', 'before_commit'] as const) {
        await recover();
        pi.gateway.script([{ text: 'Looked at it.' }]);
        const started = await ask(hubert);
        hooks.afterDispatch = stage === 'before_commit' ? async () => { await suspend(); } : undefined;
        if (stage === 'before_read') await suspend();
        assert.equal(await processor.process(started.run.id), 'revoked', stage);
        const stored = await row(started.run.id);
        assert.equal(stored.stopped_at_stage, stage);
        assert.equal(stored.answer_body, null);
        assert.equal(pi.gateway.requests.length, stage === 'before_commit' ? 1 : 0, `${stage}: model requests`);
      }
    } finally { hooks.afterDispatch = undefined; await recover(); }
    pi.gateway.script([{ text: 'Looked at it.' }]);
    const resumed = await ask(hubert);
    assert.equal(await processor.process(resumed.run.id), 'completed', 'same owner, consent, connection and grants');
  });

  test('AC-6: revoking the grant or removing the member after pi ends, before the commit, commits nothing', async () => {
    // The gateway charges each request on the run's row as it is made; the fake gateway charges nothing, so the hook writes that charge.
    hooks.afterDispatch = async (run) => {
      await pool.query(`UPDATE personal_runs SET charged_micros = 1840 WHERE id = $1`, [run.id]);
      await keepHubertOut();
    };
    pi.gateway.script([{ text: 'Looked at it.' }]);
    const beforeCommit = await ask(hubert);
    assert.equal(await processor.process(beforeCommit.run.id), 'denied', JSON.stringify(pi.lastPi()));
    const withheld = await row(beforeCommit.run.id);
    assert.deepEqual([withheld.stopped_at_stage, withheld.cost_state, withheld.answer_body], ['before_commit', 'observed', null]);
    assert.equal(withheld.charged_micros, 1840, 'a request that was made keeps its observed charge');
    await letHubertBack();

    await enable(lee, 'lee', randomUUID());
    hooks.afterDispatch = async () => { await removeMember(ada, ws.id, lee); };
    pi.gateway.script([{ text: 'Looked at it.' }]);
    const leeRun = await ask(lee);
    assert.ok(['denied', 'revoked'].includes(await processor.process(leeRun.run.id)));
    hooks.afterDispatch = undefined;
    assert.equal((await row(leeRun.run.id)).answer_body, null);

    // A withheld answer is nobody's: neither run has one, and the space hears nothing of them.
    for (const withheldRun of [beforeCommit, leeRun]) assert.equal((await row(withheldRun.run.id)).answer_body, null);
    const events = await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind LIKE 'project.assistant_%' AND data->>'runId' = ANY($1)`,
      [[beforeCommit.run.id, leeRun.run.id]]);
    assert.equal(events.rows[0].n, 0);
  });

  test('progress: every state change of a run reaches only its owner; the others hear nothing, not even that an assistant worked (#842)', async () => {
    const [own, peer, admin] = await Promise.all([hubert, kai, ada].map((someone) => StreamClient.connect(someone.browser)));
    pi.gateway.script([{ text: 'The sensor test is under way.' }]);
    const run = await ask(hubert, 'Where are we on the sensor?');
    const progressOf = (client: StreamClient) => client.events.filter((event) => event.objectType === 'assistant_run');
    await own.until(() => progressOf(own).find((event) => event.objectId === run.run.id), 8000, 'the owner hears the queued run');
    assert.equal(await processor.process(run.run.id), 'completed', JSON.stringify(pi.lastPi()));
    await own.until(() => progressOf(own).filter((event) => event.objectId === run.run.id).length >= 4, 8000, 'queued, reading, dispatching and completed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const other of [peer, admin]) assert.deepEqual(other.events.filter((event) => event.kind.startsWith('project.assistant_')), [], 'they hear nothing about the run');
    assert.deepEqual(progressOf(peer), [], 'a project member hears nothing about the run');
    assert.deepEqual(progressOf(admin), [], 'a workspace owner hears nothing about the run');
    for (const client of [own, peer, admin]) await client.close();

    const events = await pool.query(`SELECT e.data->>'status' AS status, array_agg(a.recipient ORDER BY a.recipient) AS recipients
      FROM events e LEFT JOIN event_audience a ON a.event_id = e.id WHERE e.kind = 'assistant_run.changed.v1' AND e.object_id = $1 GROUP BY e.seq, e.data ORDER BY e.seq`, [run.run.id]);
    assert.deepEqual(events.rows.map((item: { status: string }) => item.status), ['queued', 'reading', 'dispatching', 'completed']);
    for (const item of events.rows as { recipients: string[] }[]) assert.deepEqual(item.recipients, [`human:${hubert.id}`], 'the owner is the only recipient');
    assert.equal(JSON.stringify(events.rows).includes('Where are we'), false, 'events carry no content');

    // A stop before dispatch is announced too, and a paused run's end as well; still to the owner only.
    const stopped = await ask(hubert, 'Never mind');
    await runs.stop(human(hubert), stopped.run.id);
    const stops = await pool.query(`SELECT e.data->>'status' AS status, array_agg(a.recipient) AS recipients FROM events e JOIN event_audience a ON a.event_id = e.id
      WHERE e.kind = 'assistant_run.changed.v1' AND e.object_id = $1 GROUP BY e.seq, e.data ORDER BY e.seq`, [stopped.run.id]);
    assert.deepEqual(stops.rows.map((item: { status: string; recipients: string[] }) => [item.status, item.recipients]), [['queued', [`human:${hubert.id}`]], ['stopped', [`human:${hubert.id}`]]]);
  });

  test('crash recovery prevents a late answer or a repeated queue delivery from publishing', async () => {
    const previous = hooks.afterDispatch;
    hooks.afterDispatch = async (run) => {
      await pool.query("UPDATE personal_runs SET updated_at=now()-interval '2 hours' WHERE id=$1", [run.id]);
      await recoverPersonalRuns(personalRunWorkerUnitOfWork(db));
    };
    try {
      pi.gateway.script([{ text: 'Looked at it.' }]);
      const pending = await ask(hubert);
      assert.equal(await processor.process(pending.run.id), 'skipped', 'a late answer cannot commit');
      assert.deepEqual(await row(pending.run.id), { status: 'provider_failed', end_reason: null, cost_state: 'unknown', charged_micros: 0, reserved_micros: 0, answer_body: null, stopped_at_stage: null });
      const requested = pi.gateway.requests.length;
      assert.equal(await processor.process(pending.run.id), 'skipped');
      assert.equal(pi.gateway.requests.length, requested, 'queue redelivery cannot start pi again');
    } finally { hooks.afterDispatch = previous; }
  });

  test('PROV-1: runs use the connection the assistant was enabled on, never the owner\'s newer one', async () => {
    // Hubert's assistant is enabled on `hubertConnection`. He adds a newer connection, and while a
    // run is out at the provider, another: neither takes the run over or withholds its answer.
    const newer = randomUUID();
    connections.connect(hubert.id, newer, { provider: 'openrouter', model: 'vendor/newer-model' });
    const latest = randomUUID();
    const previous = hooks.afterDispatch;
    try {
      assert.equal((await runs.status(human(hubert))).state, 'ready', 'a newer connection changes nothing for the assistant');
      const run = await ask(hubert, `On the consented connection ${randomUUID()}`);
      pi.gateway.script([{ text: 'Answered on the consented connection.' }]);
      hooks.afterDispatch = async () => { connections.connect(hubert.id, latest, { provider: 'openai', model: 'gpt-latest' }); };
      assert.equal(await processor.process(run.run.id), 'completed', `a connection added mid-run does not withhold the paid answer: ${JSON.stringify(pi.lastPi())}`);
      assert.equal(pi.gateway.requests.length, 1);
      const sent = (await pool.query('SELECT connection_id, provider, model FROM personal_runs WHERE id = $1', [run.run.id])).rows[0];
      assert.deepEqual([sent.connection_id, sent.provider, sent.model], [hubertConnection, 'anthropic', 'claude-sonnet-5']);
      assert.deepEqual([pi.gateway.requests[0]!.path, pi.gateway.requests[0]!.model], ['/anthropic/v1/messages', 'claude-sonnet-5'], 'pi asked the model the run was sent with, through Anthropic\'s wire');
      assert.ok((await row(run.run.id)).answer_body, 'the answer was posted');
      // Removing the assistant's key stops it, and says that another connection exists: nothing switches to it by itself.
      connections.disconnect(hubert.id, hubertConnection);
      assert.equal((await runs.status(human(hubert))).unavailableReason, 'connection_changed');
      // The agent's own status (C-3) says the same for that agent; an id that is not one of his agents is 404.
      assert.equal((await runs.agentStatus(human(hubert), agents.hubert)).unavailableReason, 'connection_changed');
      await assert.rejects(runs.agentStatus(human(hubert), randomUUID()), { code: 'AGENT_NOT_FOUND' });
      await assert.rejects(runs.agentStatus(human(hubert), 'not-an-id'), { code: 'AGENT_NOT_FOUND' });
      await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_UNAVAILABLE' });
      // Picking a model of another key moves the assistant there (#854): the enablement stores that key and its provider.
      await chooseModel(runs, human(hubert), { connection: newer, model: 'vendor/newer-model' });
      const stored = await pool.query('SELECT api_key_id AS connection_id, provider, model AS assistant_model FROM assistant_settings WHERE agent_id = $1', [agents.hubert]);
      assert.deepEqual(stored.rows, [{ connection_id: newer, provider: 'openrouter', assistant_model: 'vendor/newer-model' }]);
    } finally {
      hooks.afterDispatch = previous;
      await hubert.browser.request('DELETE', `/api/v1/my-agents/${agents.hubert}`);
      agents.hubert = (await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/agents`, { name: 'hubert assistant', owner: 'self' })).id;
      connections.disconnect(hubert.id, newer);
      connections.disconnect(hubert.id, latest);
      await enable(hubert, 'hubert', hubertConnection);
    }
  });

  test('C-3: removing a connection pauses only the agents that use it; each agent\'s own status says so', async () => {
    // Before the fix an agent's private chat read the first agent's status, so Planner on a live key looked paused (v0.2 J12).
    const owner = await person('pr-c3');
    await addMember(ada, ws.id, owner, 'member');
    const first = randomUUID(); const second = randomUUID();
    const assistant = (await post<{ id: string }>(owner, `/api/v1/workspaces/${ws.id}/agents`, { name: 'c3 assistant', owner: 'self' })).id;
    const planner = (await post<{ id: string }>(owner, `/api/v1/workspaces/${ws.id}/agents`, { name: 'c3 planner', owner: 'self' })).id;
    connections.connect(owner.id, first); connections.connect(owner.id, second);
    try {
      await runs.enable(human(owner), { agentId: assistant, connection: first, model: 'claude-sonnet-5' });
      await runs.enable(human(owner), { agentId: planner, connection: second, model: 'claude-sonnet-5' });
      assert.equal((await runs.agentStatus(human(owner), planner)).state, 'ready');
      connections.disconnect(owner.id, first);
      const paused = await runs.agentStatus(human(owner), assistant);
      assert.deepEqual([paused.state, paused.unavailableReason, paused.enablement?.agentId], ['unavailable', 'connection_changed', assistant]);
      assert.equal((await runs.status(human(owner))).unavailableReason, 'connection_changed', '`/ai` (the first agent) waits for a model');
      const going = await runs.agentStatus(human(owner), planner);
      assert.deepEqual([going.state, going.unavailableReason, going.enablement?.agentId, going.enablement?.connection], ['ready', null, planner, second]);
      // Nobody else reads it: another person's agent is 404, whoever asks.
      await assert.rejects(runs.agentStatus(human(hubert), planner), { code: 'AGENT_NOT_FOUND' });
      expectStatus(await hubert.browser.request('GET', `/api/v1/my-agents/${planner}/status`), 404, 'another person\'s agent');
      expectStatus(await owner.browser.request('GET', `/api/v1/my-agents/${planner}/status`), 200, 'the owner reads it over HTTP');
    } finally {
      connections.disconnect(owner.id, second);
    }
  });

  test('#250 AC-3: nothing an assistant writes accepts a decision; only a person with authority decides', async () => {
    // O-009 DA-1/DA-4: the assistant writes no decision rows. A block shaped like a decision, or one that
    // claims it is already accepted, is only text: it never makes a rule current.
    const pending = await post<Decision>(kai, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Use the ToF sensor', rationale: 'It works in the dark' });
    const decisionState = async () => {
      const current = expectStatus(await viewer.browser.request('GET', `/api/v1/decisions/${pending.id}`), 200) as Decision;
      const accepted = (await pool.query("SELECT count(*)::int AS n FROM events WHERE kind = 'project.decision_accepted.v1' AND data->>'decisionId' = $1", [pending.id])).rows[0].n as number;
      return [current.status, current.version, current.decidedBy, accepted];
    };
    const untouched = ['proposed', pending.version, null, 0];
    const counts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM project_decisions WHERE project_id = $1) AS decisions,
      (SELECT count(*)::int FROM project_decisions WHERE project_id = $1 AND status <> 'proposed') AS decided`, [lamp.id])).rows[0] as { decisions: number; decided: number };
    const before = await counts();
    const claim = { type: 'decision', decisionId: pending.id, status: 'accepted', decidedBy: hubert.id, title: 'Use the ToF sensor', rationale: 'Accepted for the team' };
    pi.gateway.script([{ text: `Fact: Kai proposed the ToF sensor.\n<proposal>${JSON.stringify(claim)}</proposal>` }]);
    const claimed = await ask(hubert, 'Accept the ToF decision for us');
    assert.equal(await processor.process(claimed.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.deepEqual(await decisionState(), untouched);
    assert.deepEqual(await counts(), before, 'no decision or acceptance was written by the assistant');

    // Neither the assistant's agent identity nor a person outside the space decides the decision.
    const assistant: Principal = { kind: 'agent', id: agents.hubert! };
    await assert.rejects(workUseCases(db).acceptDecision(assistant, pending.id, pending.version), { code: 'DECISION_NEEDS_PERSON' });
    assert.equal((await outsider.browser.request('POST', `/api/v1/decisions/${pending.id}/accept`, { body: { expectedVersion: pending.version } })).status, 404);
    assert.deepEqual(await decisionState(), untouched);
    assert.deepEqual(await counts(), before);

    // Only a person's own explicit acceptance makes the decision current.
    const decided = expectStatus(await kai.browser.request('POST', `/api/v1/decisions/${pending.id}/accept`, { body: { expectedVersion: pending.version } }), 200) as Decision;
    assert.deepEqual([decided.status, decided.decidedBy?.id, decided.proposedBy.id], ['accepted', kai.id, kai.id]);
  });
});
