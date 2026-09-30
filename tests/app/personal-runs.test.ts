import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { createPersonalRunProcessor, type PersonalRunHooks, type Principal } from '@flux/core';
import {
  PERSONAL_RUN_CONSENT_VERSION,
  type AssistantAnswer, type AssistantProposal, type AssistantRun, type Conversation, type Page, type PersonalAssistantStatus,
  type Project, type WorkItem, type WorkResult, type Workspace,
} from '@flux/contracts';
import { assistantProposalUseCases, personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { addMember, expectStatus, person, project as createProject, removeMember, workspace as createWorkspace, type Person } from './support/people.js';
import { echo, FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { StreamClient } from './support/stream.js';

// Owner-invoked personal assistant runs (#68, decision O-008), first slice. HTTP routes run
// against the API container's production composition, where nobody has a key connection yet
// (#124) and the provider is off, so every route fails closed there. Runs that reach dispatch are
// driven in this process through the same core use cases and worker processor with the test-only
// fakes of `support/personal-runs.ts`: a fake connection lookup, a fake queue and a FAKE COMPUTE.
// No model is called; none of these tests is a provider, billing or compatibility pass.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const hooks: PersonalRunHooks = {};
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const proposals = assistantProposalUseCases(db, queue.factory);
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20, hooks });

const TOKENS = {
  dm: `DM-SECRET-${randomUUID()}`,
  draft: `PRIVATE-DRAFT-${randomUUID()}`,
  sketch: `PRIVATE-SKETCH-${randomUUID()}`,
  otherProject: `OTHER-PROJECT-${randomUUID()}`,
};

const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

async function post<T>(someone: Person, path: string, body: unknown, status = 201): Promise<T> {
  return expectStatus(await someone.browser.request('POST', path, { body }), status, `POST ${path}`) as T;
}

async function row(runId: string) {
  const result = await pool.query('SELECT status, cost_state, charged_micros, reserved_micros, answer_body, stopped_at_stage FROM personal_runs WHERE id = $1', [runId]);
  return result.rows[0] as { status: string; cost_state: string; charged_micros: number; reserved_micros: number; answer_body: string | null; stopped_at_stage: string | null };
}

async function runCount(ownerId: string) {
  return (await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id = $1', [ownerId])).rows[0].n as number;
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('personal assistant runs (#68, fake compute: no provider pass is claimed)', () => {
  let ada: Person; let hubert: Person; let maurycy: Person; let kai: Person; let viewer: Person; let lee: Person; let outsider: Person;
  let ws: Workspace; let lamp: Project; let other: Project;
  let thread: Conversation;
  let work: WorkItem;
  const agents: Record<string, string> = {};
  const grants: Record<string, string> = {};
  let projectSketch: { id: string; thoughtId: string };
  let privateSketch: { id: string; thoughtId: string };
  let dmSketch: { id: string; thoughtId: string };
  const hubertConnection = randomUUID();
  const maurycyConnection = randomUUID();

  const ask = (someone: Person, prompt = 'Summarize where we are', extra: Record<string, unknown> = {}) =>
    runs.invoke(human(someone), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt, ...extra });

  async function grantAgent(name: string) {
    grants[name] = (await post<{ id: string }>(ada, `/api/v1/projects/${lamp.id}/grants`, { principal: { kind: 'agent', id: agents[name] }, role: 'contributor' })).id;
  }
  async function revokeAgentGrant(name: string) {
    expectStatus(await ada.browser.request('DELETE', `/api/v1/projects/${lamp.id}/grants/${grants[name]}`), 204, 'revoke agent grant');
  }
  async function enable(someone: Person, name: string, connectionId: string) {
    connections.connect(someone.id, connectionId);
    return runs.enable(human(someone), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agents[name]!, dailyCapCents: 1000 });
  }

  before(async () => {
    [ada, hubert, maurycy, kai, viewer, lee, outsider] = await Promise.all(['pr-ada', 'pr-hubert', 'pr-maurycy', 'pr-kai', 'pr-viewer', 'pr-lee', 'pr-outsider'].map(person));
    ws = await createWorkspace(ada, 'Gesture lamp');
    for (const member of [hubert, maurycy, kai, viewer, lee]) await addMember(ada, ws.id, member, 'member');
    lamp = await createProject(ada, ws.id, 'Lamp sensor', 'workspace');
    other = await createProject(ada, ws.id, 'Payroll', 'restricted');
    await post(ada, `/api/v1/projects/${lamp.id}/grants`, { principal: { kind: 'human', id: viewer.id }, role: 'viewer' });
    await post(ada, `/api/v1/projects/${other.id}/grants`, { principal: { kind: 'human', id: hubert.id }, role: 'contributor' });
    for (const [name, someone] of [['hubert', hubert], ['maurycy', maurycy], ['lee', lee]] as const) {
      agents[name] = (await post<{ id: string }>(someone, `/api/v1/workspaces/${ws.id}/agents`, { name: `${name} assistant`, owner: 'self' })).id;
      await grantAgent(name);
    }
    await post(ada, `/api/v1/projects/${other.id}/grants`, { principal: { kind: 'agent', id: agents.hubert }, role: 'contributor' });

    thread = await post<Conversation>(kai, `/api/v1/projects/${lamp.id}/conversations`, { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() });
    await post(hubert, `/api/v1/conversations/${thread.id}/messages`, { body: 'The ToF sensor kept working with swipe + hold', clientMessageId: randomUUID() });
    work = await post<WorkItem>(kai, `/api/v1/projects/${lamp.id}/work`, { title: 'Camera in low light', owner: { kind: 'human', id: kai.id } });

    // Material the owner can open but a project run must never read.
    const payroll = await post<Conversation>(ada, `/api/v1/projects/${other.id}/conversations`, { body: `Salaries ${TOKENS.otherProject}`, clientMessageId: randomUUID() });
    assert.ok(payroll.id);
    const dm = await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [kai.id] });
    await post(hubert, `/api/v1/dms/${dm.id}/messages`, { body: `Between us: ${TOKENS.dm}`, clientMessageId: randomUUID() });
    // A DM sketch (#96) the owner is part of: it belongs to the DM, never to a project run.
    const dmMap = await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Our lamp ideas', scope: 'dm', dmId: dm.id });
    dmSketch = { id: dmMap.id, thoughtId: (await post<{ thought: { id: string } }>(hubert, `/api/v1/sketches/${dmMap.id}/thoughts`, { text: `DM map: ${TOKENS.dm}`, x: 0, y: 0 })).thought.id };
    await post(hubert, `/api/v1/workspaces/${ws.id}/drafts`, { title: 'Notes', body: `Private capture ${TOKENS.draft}`, projectId: lamp.id });
    const mine = await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'My private map', scope: 'private' });
    privateSketch = { id: mine.id, thoughtId: (await post<{ thought: { id: string } }>(hubert, `/api/v1/sketches/${mine.id}/thoughts`, { text: TOKENS.sketch, x: 0, y: 0 })).thought.id };
    const shared = await post<{ id: string }>(kai, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Sensor options', scope: 'project', projectId: lamp.id });
    projectSketch = { id: shared.id, thoughtId: (await post<{ thought: { id: string } }>(kai, `/api/v1/sketches/${shared.id}/thoughts`, { text: 'ToF sensor: swipe + hold', x: 10, y: 10 })).thought.id };

    await enable(hubert, 'hubert', hubertConnection);
  });

  test('AC-4: the production composition fails closed with an explicit state and human work continues', async () => {
    const status = expectStatus(await hubert.browser.request('GET', '/api/v1/personal-assistant'), 200) as PersonalAssistantStatus;
    assert.equal(status.state, 'unavailable');
    assert.equal(status.unavailableReason, 'provider_off');
    assert.deepEqual(status.setup, { provider: 'off', connection: 'none' }, 'the UI can say why, truthfully');
    assert.equal(status.enablement?.connectionId, hubertConnection);
    assert.equal(status.enablement?.consent.version, PERSONAL_RUN_CONSENT_VERSION);
    const refused = await hubert.browser.request('POST', `/api/v1/conversations/${thread.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'Summarize' } });
    assert.equal(refused.status, 503, refused.text);
    assert.deepEqual([(refused.json as { code: string }).code, (refused.json as { reason: string }).reason], ['PERSONAL_RUN_UNAVAILABLE', 'provider_off']);
    assert.equal(await runCount(hubert.id), 0, 'a refused invoke writes no run and reserves nothing');
    assert.equal((expectStatus(await maurycy.browser.request('GET', '/api/v1/personal-assistant'), 200) as PersonalAssistantStatus).state, 'not_enabled');
    const enable = await maurycy.browser.request('POST', '/api/v1/personal-assistant', { body: { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agents.maurycy } });
    assert.equal((enable.json as { code: string }).code, 'PERSONAL_RUN_CONNECTION_REQUIRED', enable.text);
    const foreign = await maurycy.browser.request('POST', '/api/v1/personal-assistant', { body: { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agents.hubert } });
    assert.equal(foreign.status, 403, 'another person\'s agent cannot be enabled');

    // In the fake composition: no connection means an explicit unavailable state, never a fallback.
    connections.disconnect(hubert.id);
    assert.equal((await runs.status(human(hubert))).unavailableReason, 'no_connection');
    await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_UNAVAILABLE' });
    connections.connect(hubert.id, randomUUID());
    assert.equal((await runs.status(human(hubert))).unavailableReason, 'connection_changed', 'a replaced key needs a new consent');
    connections.connect(hubert.id, hubertConnection);
    assert.equal((await runs.status(human(hubert))).state, 'ready');
    assert.equal(await runCount(hubert.id), 0);
    assert.equal(compute.dispatched.length, 0);
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
    // Someone who may only read the project cannot post an answer into it, even with their own assistant.
    const readOnly = await viewer.browser.request('POST', invokePath, { body: { ...body, clientRunId: randomUUID() } });
    assert.deepEqual([readOnly.status, (readOnly.json as { code: string }).code], [403, 'FORBIDDEN']);

    const live = await StreamClient.connect(kai.browser);
    await live.ready();
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
    assert.equal(compute.dispatched.length, 0);
    assert.equal(await runCount(maurycy.id), 0, 'no run was written for the other person');
    assert.equal(await runCount(hubert.id), 1, 'only the owner\'s own invocation exists');
    assert.equal((await row(mine.run.id)).status, 'queued', 'the WebSocket stop was ignored');

    assert.equal(await processor.process(mine.run.id), 'completed');
    assert.equal(await processor.process(mine.run.id), 'skipped', 'a repeated job never dispatches twice');
    assert.equal(compute.dispatched.length, 1);
    assert.equal(compute.dispatched[0]!.connection.id, hubertConnection);
    assert.deepEqual(new Set(connections.resolved), new Set([hubert.id]), 'only the owner\'s connection was ever looked up');
    await live.until(() => live.events.find((event) => event.kind === 'project.assistant_answer_committed.v1'), 8000, 'answer event for the conversation audience');
    await live.close();
    const audience = await pool.query(`SELECT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id
      WHERE e.kind = 'project.assistant_answer_committed.v1' AND e.data->>'runId' = $1`, [mine.run.id]);
    const recipients = audience.rows.map((item: { recipient: string }) => item.recipient);
    assert.ok(recipients.includes(`human:${kai.id}`) && recipients.includes(`human:${viewer.id}`));
    assert.ok(!recipients.includes(`human:${outsider.id}`));
  });

  test('AC-5: DMs, private captures and other projects never reach the input or the output; sources are openable by the audience', async () => {
    const dispatched = compute.dispatched.map((request) => request.input).join('\n');
    assert.match(dispatched, /Camera fails below 5 lux/);
    for (const token of Object.values(TOKENS)) assert.equal(dispatched.includes(token), false, `input contains ${token}`);

    const kaiView = expectStatus(await kai.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`), 200) as Page<AssistantAnswer>;
    const answer = kaiView.items.at(-1)!;
    assert.equal(answer.assistant.label, 'pr-hubert\'s assistant');
    assert.equal(answer.askedBy.id, hubert.id);
    assert.deepEqual(answer.provenance, { provider: 'anthropic', model: 'claude-sonnet-5' });
    for (const token of Object.values(TOKENS)) assert.equal(answer.body.includes(token), false, `answer contains ${token}`);
    const text = JSON.stringify(kaiView);
    for (const hidden of ['Micros', 'reserved', 'test-key-ref', hubertConnection]) assert.equal(text.includes(hidden), false, `audience view shows ${hidden}`);
    assert.equal((await outsider.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`)).status, 404);

    assert.ok(answer.sources.length >= 2);
    const conversation = expectStatus(await viewer.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
    for (const source of answer.sources) {
      if (source.type === 'message') assert.ok(conversation.messages.some((message) => message.id === source.id), 'viewer can open the cited message');
      if (source.type === 'work') expectStatus(await viewer.browser.request('GET', `/api/v1/work/${source.id}`), 200, 'viewer opens the cited work');
      if (source.type === 'thought') expectStatus(await viewer.browser.request('GET', `/api/v1/sketches/${source.sketchId}`), 200, 'viewer opens the cited map');
    }

    // A thought on the owner's private map: the owner may open it, the assistant never reads it.
    const privateRun = await runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'map_thought', prompt: 'Expand this', target: { type: 'thought', sketchId: privateSketch.id, thoughtId: privateSketch.thoughtId } });
    const before = compute.dispatched.length;
    assert.equal(await processor.process(privateRun.run.id), 'denied');
    assert.deepEqual(await row(privateRun.run.id), { status: 'denied', cost_state: 'released', charged_micros: 0, reserved_micros: 60_000, answer_body: null, stopped_at_stage: 'before_read' });
    assert.equal(compute.dispatched.length, before);
    assert.equal(compute.counted.some((request) => request.input.includes(TOKENS.sketch)), false);
    await assert.rejects(runs.invoke(human(maurycy), thread.id, { clientRunId: randomUUID(), kind: 'map_thought', prompt: 'x', target: { type: 'thought', sketchId: privateSketch.id, thoughtId: privateSketch.thoughtId } }), { code: 'THOUGHT_NOT_FOUND' });

    // A thought on a DM sketch the owner is in: the assistant never reads DM content (#96, O-008).
    const dmRun = await runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'map_thought', prompt: 'Expand this', target: { type: 'thought', sketchId: dmSketch.id, thoughtId: dmSketch.thoughtId } });
    assert.equal(await processor.process(dmRun.run.id), 'denied');
    assert.equal((await row(dmRun.run.id)).charged_micros, 0);
    assert.equal(compute.counted.some((request) => request.input.includes(TOKENS.dm)), false, 'DM sketch text is never counted');
    assert.equal(compute.dispatched.some((request) => request.input.includes(TOKENS.dm)), false, 'DM sketch text is never sent');

    const mapRun = await runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'map_thought', prompt: 'What next?', target: { type: 'thought', sketchId: projectSketch.id, thoughtId: projectSketch.thoughtId } });
    assert.equal(await processor.process(mapRun.run.id), 'completed');
    assert.match(compute.dispatched.at(-1)!.input, /Selected map thought: ToF sensor: swipe \+ hold/);
  });

  test('AC-2: denied, stopped-before-read, paused, capped and revoked runs cost zero; a retry key never charges twice', async () => {
    const clientRunId = randomUUID();
    const first = await runs.invoke(human(hubert), thread.id, { clientRunId, kind: 'summarize', prompt: 'Summarize' });
    const again = await runs.invoke(human(hubert), thread.id, { clientRunId, kind: 'summarize', prompt: 'Summarize' });
    assert.equal(again.run.id, first.run.id);
    assert.equal(again.created, false);
    await assert.rejects(runs.invoke(human(hubert), thread.id, { clientRunId, kind: 'summarize', prompt: 'Something else' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_IN_FLIGHT' });

    // Stopped before read, through the API.
    const stopped = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${first.run.id}/stop`), 200) as AssistantRun;
    assert.deepEqual([stopped.status, stopped.cost.state, stopped.cost.chargedMicros], ['stopped', 'released', 0]);
    const dispatchedBefore = compute.dispatched.length;
    assert.equal(await processor.process(first.run.id), 'skipped');
    assert.equal(compute.dispatched.length, dispatchedBefore);

    // Retrying the stopped run twice with the same key creates and charges one run.
    const retryKey = randomUUID();
    const retried = await runs.retry(human(hubert), first.run.id, { clientRunId: retryKey });
    const retriedAgain = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${first.run.id}/retry`, { body: { clientRunId: retryKey } }), 200) as AssistantRun;
    assert.equal(retriedAgain.id, retried.run.id);
    assert.equal(await processor.process(retried.run.id), 'completed');
    assert.equal((await runs.retry(human(hubert), first.run.id, { clientRunId: retryKey })).created, false);
    assert.equal(compute.dispatched.length, dispatchedBefore + 1);
    const charged = await pool.query(`SELECT count(*)::int AS n, sum(charged_micros)::int AS micros FROM personal_runs WHERE retry_of_run_id = $1`, [first.run.id]);
    assert.equal(charged.rows[0].n, 1);
    assert.equal(charged.rows[0].micros, (await row(retried.run.id)).charged_micros);

    // Denied before read: the agent lost its grant.
    const denied = await ask(hubert);
    await revokeAgentGrant('hubert');
    assert.equal(await processor.process(denied.run.id), 'denied');
    await grantAgent('hubert');
    // Paused: queued work ends at once; a paused assistant refuses new work.
    const paused = await ask(hubert);
    assert.equal((await runs.pause(human(hubert))).state, 'paused');
    await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_PAUSED' });
    await runs.resume(human(hubert));
    // Disconnected before dispatch.
    const disconnected = await ask(hubert);
    connections.disconnect(hubert.id);
    assert.equal(await processor.process(disconnected.run.id), 'unavailable');
    connections.connect(hubert.id, hubertConnection);
    // Revoked: the enablement and its consent are removed.
    const revoked = await ask(hubert);
    expectStatus(await hubert.browser.request('DELETE', '/api/v1/personal-assistant'), 204);
    await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_NOT_ENABLED' });
    await enable(hubert, 'hubert', hubertConnection);
    for (const run of [denied, paused, disconnected, revoked]) {
      const stored = await row(run.run.id);
      assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], ['released', 0, null], `${stored.status} costs nothing`);
    }
    assert.deepEqual([(await row(paused.run.id)).status, (await row(revoked.run.id)).status], ['paused', 'revoked']);
    assert.equal(compute.dispatched.length, dispatchedBefore + 1, 'none of them reached the provider');

    // Capped at invoke and at dispatch; the cap counts reservations as well as observed usage.
    const spend = (await runs.status(human(hubert))).today!;
    const used = spend.chargedMicros + spend.reservedMicros;
    const cap = Math.max(10, Math.ceil((used + 60_000) / 10_000));
    let status = await runs.status(human(hubert));
    await runs.update(human(hubert), { dailyCapCents: cap }, status.enablement!.version);
    compute.respond = async () => ({ kind: 'completed', stopReason: 'end_turn', text: 'Fact: long answer [S1]', usage: { inputTokens: 16_000, outputTokens: 1_500 } });
    const heavy = await ask(hubert);
    assert.equal(await processor.process(heavy.run.id), 'completed');
    assert.equal((await row(heavy.run.id)).charged_micros, 47_000, 'the nominal maximum of O-008 §3');
    compute.respond = echo;
    const rowsBefore = await runCount(hubert.id);
    await assert.rejects(ask(hubert), { code: 'PERSONAL_RUN_CAPPED' });
    assert.equal(await runCount(hubert.id), rowsBefore, 'a capped invoke writes nothing');
    assert.equal((await runs.status(human(hubert))).state, 'capped');
    status = await runs.status(human(hubert));
    await runs.update(human(hubert), { dailyCapCents: cap + 20 }, status.enablement!.version);
    const late = await ask(hubert);
    status = await runs.status(human(hubert));
    await runs.update(human(hubert), { dailyCapCents: cap }, status.enablement!.version);
    assert.equal(await processor.process(late.run.id), 'cap_reached');
    assert.deepEqual([(await row(late.run.id)).cost_state, (await row(late.run.id)).charged_micros], ['released', 0]);
    status = await runs.status(human(hubert));
    await runs.update(human(hubert), { dailyCapCents: 1000 }, status.enablement!.version);

    // Stopped during dispatch: the request is aborted, the charge is kept, nothing is committed.
    compute.respond = (_request, signal) => new Promise((resolve) => signal.addEventListener('abort', () =>
      resolve({ kind: 'completed', stopReason: 'end_turn', text: 'Late answer [S1]', usage: { inputTokens: 900, outputTokens: 40 } })));
    const long = await ask(hubert);
    const processing = processor.process(long.run.id);
    await waitFor(async () => (await row(long.run.id)).status === 'dispatching', 'dispatch');
    expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${long.run.id}/stop`), 200);
    assert.equal(await processing, 'stopped');
    compute.respond = echo;
    const stoppedLate = await row(long.run.id);
    assert.deepEqual([stoppedLate.cost_state, stoppedLate.charged_micros, stoppedLate.answer_body], ['observed', 900 * 2 + 40 * 10, null]);

    // A run a crashed worker left dispatching does not block the owner forever; its reservation stays counted.
    const stuck = await ask(hubert);
    await pool.query(`UPDATE personal_runs SET status = 'dispatching', updated_at = now() - interval '20 minutes' WHERE id = $1`, [stuck.run.id]);
    const next = await ask(hubert);
    assert.deepEqual([(await row(stuck.run.id)).status, (await row(stuck.run.id)).cost_state], ['provider_failed', 'unknown']);
    assert.equal(await processor.process(next.run.id), 'completed');
  });

  test('AC-3: once Maurycy connects, his run uses only his connection and cap; Hubert\'s usage does not change', async () => {
    const hubertBefore = (await runs.status(human(hubert))).today!;
    await enable(maurycy, 'maurycy', maurycyConnection);
    const status = expectStatus(await maurycy.browser.request('GET', '/api/v1/personal-assistant'), 200) as PersonalAssistantStatus;
    assert.equal(status.enablement?.ownerUserId, maurycy.id);
    const mine = await ask(maurycy, 'What did the ToF test show?');
    assert.equal(await processor.process(mine.run.id), 'completed');
    const request = compute.dispatched.at(-1)!;
    assert.deepEqual(request.connection, { id: maurycyConnection, keyRef: `test-key-ref-${maurycyConnection}` });
    const stored = await pool.query('SELECT owner_user_id, agent_id, connection_id FROM personal_runs WHERE id = $1', [mine.run.id]);
    assert.deepEqual(stored.rows[0], { owner_user_id: maurycy.id, agent_id: agents.maurycy, connection_id: maurycyConnection });
    assert.deepEqual((await runs.status(human(hubert))).today, hubertBefore);
    assert.ok((await runs.status(human(maurycy))).today!.chargedMicros > 0);
  });

  test('AC-6: revoking the grant or removing the member between read and commit commits nothing', async () => {
    hooks.afterRead = async () => { await revokeAgentGrant('hubert'); };
    const beforeDispatch = await ask(hubert);
    const dispatched = compute.dispatched.length;
    assert.equal(await processor.process(beforeDispatch.run.id), 'denied');
    assert.deepEqual([(await row(beforeDispatch.run.id)).stopped_at_stage, (await row(beforeDispatch.run.id)).charged_micros], ['before_dispatch', 0]);
    assert.equal(compute.dispatched.length, dispatched);
    await grantAgent('hubert');

    hooks.afterRead = undefined;
    hooks.afterDispatch = async () => { await revokeAgentGrant('hubert'); };
    const beforeCommit = await ask(hubert);
    assert.equal(await processor.process(beforeCommit.run.id), 'denied');
    const withheld = await row(beforeCommit.run.id);
    assert.deepEqual([withheld.stopped_at_stage, withheld.cost_state, withheld.answer_body], ['before_commit', 'observed', null]);
    assert.ok(withheld.charged_micros > 0, 'a dispatched request keeps its observed charge');
    await grantAgent('hubert');

    await enable(lee, 'lee', randomUUID());
    hooks.afterDispatch = async () => { await removeMember(ada, ws.id, lee); };
    const leeRun = await ask(lee);
    assert.ok(['denied', 'revoked'].includes(await processor.process(leeRun.run.id)));
    hooks.afterDispatch = undefined;
    assert.equal((await row(leeRun.run.id)).answer_body, null);

    const answers = expectStatus(await kai.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers?limit=100`), 200) as Page<AssistantAnswer>;
    for (const withheldRun of [beforeDispatch, beforeCommit, leeRun]) assert.equal(answers.items.some((answer) => answer.runId === withheldRun.run.id), false);
    const events = await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind = 'project.assistant_answer_committed.v1' AND data->>'runId' = ANY($1)`,
      [[beforeCommit.run.id, leeRun.run.id]]);
    assert.equal(events.rows[0].n, 0);
  });

  test('AC-6: nothing leaves for preflight counting once the grant, a Stop or a pause arrives after the read', async () => {
    const countsFor = (prompt: string) => compute.counted.filter((request) => request.input.includes(`Request: ${prompt}`)).length;
    const dispatched = compute.dispatched.length;
    const cases: [string, (runId: string) => Promise<unknown>, string, () => Promise<unknown>][] = [
      ['grant revoked', () => revokeAgentGrant('hubert'), 'denied', () => grantAgent('hubert')],
      ['stopped', (runId) => runs.stop(human(hubert), runId), 'stopped', async () => undefined],
      ['paused', () => runs.pause(human(hubert)), 'paused', () => runs.resume(human(hubert))],
    ];
    for (const [label, change, status, undo] of cases) {
      const prompt = `Preflight ${label} ${randomUUID()}`;
      const run = await ask(hubert, prompt);
      hooks.afterRead = async () => { await change(run.run.id); };
      await processor.process(run.run.id);
      hooks.afterRead = undefined;
      await undo();
      const stored = await row(run.run.id);
      assert.deepEqual([stored.status, stored.cost_state, stored.charged_micros, stored.answer_body], [status, 'released', 0, null], label);
      assert.equal(countsFor(prompt), 0, `${label}: no count request was sent`);
    }
    assert.equal(compute.dispatched.length, dispatched);

    // Trimming sends one count per attempt: a change between two counts stops the next one.
    const prompt = `Preflight trimming ${randomUUID()}`;
    compute.count = () => 20_000;
    compute.onCount = async (request) => { if (request.input.includes(prompt)) await revokeAgentGrant('hubert'); };
    const trimmed = await ask(hubert, prompt);
    assert.equal(await processor.process(trimmed.run.id), 'denied');
    compute.count = (request) => Math.ceil(request.input.length / 4);
    compute.onCount = null;
    await grantAgent('hubert');
    assert.equal(countsFor(prompt), 1, 'the second count request was never sent');
    const stored = await row(trimmed.run.id);
    assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], ['released', 0, null]);
    assert.equal(compute.dispatched.length, dispatched);
  });

  test('AC-7: only a person with authority accepts an assistant proposal; the result records who drafted it', async () => {
    compute.respond = async (request) => {
      const label = /\[(S\d+)\] Open work item "Camera in low light"/.exec(request.input)![1];
      return { kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: 800, outputTokens: 90 },
        text: `Fact: the camera failed below 5 lux [S1].\n<proposal>${JSON.stringify({ fact: 'Camera fails below 5 lux', interpretation: 'Exposure is too short',
          title: 'Camera fails in low light', finding: 'negative', evidence: 'Low-light test, 20 gestures', finishes: label })}</proposal>` };
    };
    const drafting = await ask(hubert, 'Record the low-light result');
    assert.equal(await processor.process(drafting.run.id), 'completed');
    const run = await runs.get(human(hubert), drafting.run.id);
    const proposalId = run.answer!.proposalId!;
    assert.ok(proposalId);
    const listed = expectStatus(await viewer.browser.request('GET', `/api/v1/projects/${lamp.id}/assistant-proposals`), 200) as Page<AssistantProposal>;
    const proposal = listed.items.find((item) => item.id === proposalId)!;
    assert.deepEqual([proposal.status, proposal.draftedBy.label, proposal.change.finishes?.workId], ['proposed', 'pr-hubert\'s assistant', work.id]);

    const accept = (someone: Person) => someone.browser.request('POST', `/api/v1/assistant-proposals/${proposalId}/accept`, { body: { expectedVersion: 1 } });
    for (const [someone, status] of [[maurycy, 403], [hubert, 403], [viewer, 403], [outsider, 404]] as const) {
      const refused = await accept(someone);
      assert.equal(refused.status, status, `${someone.email}: ${refused.text}`);
    }
    await assert.rejects(proposals.accept(human(hubert), proposalId, {}, 1), { code: 'PROPOSAL_AUTHORITY_REQUIRED' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id = $1', [lamp.id])).rows[0].n, 0);

    const accepted = expectStatus(await accept(kai), 200) as AssistantProposal;
    assert.deepEqual([accepted.status, accepted.decidedBy?.id, accepted.draftedBy.label], ['accepted', kai.id, 'pr-hubert\'s assistant']);
    const result = expectStatus(await viewer.browser.request('GET', `/api/v1/results/${accepted.resultId}`), 200) as WorkResult;
    assert.deepEqual([result.title, result.createdBy.id], ['Camera fails in low light', kai.id]);
    assert.equal((expectStatus(await kai.browser.request('GET', `/api/v1/work/${work.id}`), 200) as WorkItem).status, 'done');
    assert.equal((await accept(kai)).status, 409, 'a decided proposal cannot be accepted again');

    // A truncated answer is shown as truncated and never becomes a proposal.
    compute.respond = async () => ({ kind: 'completed', stopReason: 'max_tokens', usage: { inputTokens: 700, outputTokens: 1_500 },
      text: `Fact: cut off [S1]\n<proposal>${JSON.stringify({ fact: 'f', interpretation: 'i', title: 'Should not be proposed', finding: 'negative', evidence: '', finishes: null })}</proposal>` });
    const truncated = await ask(hubert, 'Record it again');
    assert.equal(await processor.process(truncated.run.id), 'truncated');
    const view = await runs.get(human(hubert), truncated.run.id);
    assert.deepEqual([view.answer?.truncated, view.answer?.proposalId], [true, null]);
    compute.respond = echo;
    // Continuing it is the owner's new, separately charged run with the earlier answer as input.
    const continued = await runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Continue', continuesRunId: truncated.run.id });
    assert.equal(await processor.process(continued.run.id), 'completed');
    assert.match(compute.dispatched.at(-1)!.input, /Your earlier answer, to continue/);
  });

  test('progress: every state change of a run reaches only its owner; others learn of it only from the committed answer', async () => {
    const [own, peer, admin] = await Promise.all([hubert, kai, ada].map((someone) => StreamClient.connect(someone.browser)));
    const run = await ask(hubert, 'Where are we on the sensor?');
    const progressOf = (client: StreamClient) => client.events.filter((event) => event.objectType === 'assistant_run');
    await own.until(() => progressOf(own).find((event) => event.objectId === run.run.id), 8000, 'the owner hears the queued run');
    assert.equal(await processor.process(run.run.id), 'completed');
    await own.until(() => progressOf(own).filter((event) => event.objectId === run.run.id).length >= 4, 8000, 'queued, reading, dispatching and completed');
    for (const other of [peer, admin]) await other.until(() => other.events.find((event) => event.kind === 'project.assistant_answer_committed.v1' && event.createdAt >= run.run.createdAt), 8000, 'the committed answer');
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

  test('a failed preflight count ends the run at zero cost with nothing dispatched', async () => {
    const dispatched = compute.dispatched.length;
    const count = compute.count;
    compute.count = () => { throw new Error('count endpoint down'); };
    try {
      const run = await ask(hubert, 'Count fails');
      assert.equal(await processor.process(run.run.id), 'provider_failed');
      assert.deepEqual(await row(run.run.id), { status: 'provider_failed', cost_state: 'released', charged_micros: 0, reserved_micros: 60_000, answer_body: null, stopped_at_stage: 'before_dispatch' });
      assert.equal(compute.dispatched.length, dispatched);
    } finally { compute.count = count; }
  });
});
