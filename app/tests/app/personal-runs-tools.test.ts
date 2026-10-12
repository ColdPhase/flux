import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  createPersonalRunProcessor, SYSTEM_PROMPT, TOOL_SYSTEM_PROMPT,
  type PersonalComputeResult, type PersonalTool, type PersonalToolCall, type PersonalToolHost, type PersonalToolSession, type Principal,
} from '@flux/core';
import { PERSONAL_RUN_CONSENT_VERSION, PERSONAL_RUN_LIMITS, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { FLUX_TOOLS } from './support/provider-tool-fixtures.js';

// The `server` tool loop in the worker (F-027 AST-8.2 and AST-8.3, issue #406): the reservation over
// the turns, the turn cap, the money reservation, the rechecks between turns and the model without
// tool calling, driven through the real use cases, the real worker processor and the real database
// with a FAKE provider and a FAKE tool session. No model is called and no `/mcp` route is: the
// worker's MCP client with the run token is the next slice (A6 rest, A2). None of this is a
// provider, billing or compatibility pass.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true, toolTurns: PERSONAL_RUN_LIMITS.maxTurns });
const singleRequestRuns = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });

class FakeSession implements PersonalToolSession {
  tools: readonly PersonalTool[] = FLUX_TOOLS;
  /** Calls that were made, in order: the "committed changes" of the run. */
  changes: PersonalToolCall[] = [];
  closed = 0;
  onCall: (call: PersonalToolCall) => Promise<void> = async () => undefined;
  async call(call: PersonalToolCall) {
    this.changes.push(call);
    await this.onCall(call);
    return { content: `done ${call.id}`, isError: false };
  }
  async close() { this.closed += 1; }
}

let session = new FakeSession();
let opened = 0;
let host: PersonalToolHost = async () => { opened += 1; return session; };
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20, tools: (run, connection) => host(run, connection) });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

const MAX_USAGE = { inputTokens: PERSONAL_RUN_LIMITS.maxInputTokens, outputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens };
const toolUse = (turn: number, usage = { inputTokens: 1_000, outputTokens: 50 }): PersonalComputeResult => ({
  kind: 'completed', text: `step ${turn}`, stopReason: 'tool_use', usage, replay: { turn },
  toolCalls: [{ id: `call-${turn}`, name: 'flux_update_work', input: { id: 'w1', title: `step ${turn}` } }],
});

async function row(runId: string) {
  const result = await pool.query(`SELECT status, cost_state, charged_micros, reserved_micros, input_tokens, output_tokens, answer_body, stopped_at_stage
    FROM personal_runs WHERE id = $1`, [runId]);
  return result.rows[0] as { status: string; cost_state: string; charged_micros: number; reserved_micros: number; input_tokens: number | null;
    output_tokens: number | null; answer_body: string | null; stopped_at_stage: string | null };
}

describe('the server tool loop in the worker (AST-8.2, AST-8.3; fake provider and fake tools, no provider pass)', () => {
  let owner: Person; let ws: Workspace; let place: Project; let thread: Conversation;
  let agentId: string; let grantId: string;

  /** The owner's assistant on a fresh connection with these per-run and daily ceilings. */
  async function useConnection(model: Parameters<FakeConnections['connect']>[2] = {}, perRunCents = 50) {
    await runs.remove(human(owner)).catch(() => undefined);
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId, model);
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents, dailyCapCents: 1_000 });
  }
  const ask = (prompt = 'Tidy the open tasks', useCases = runs) => useCases.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });

  before(async () => {
    owner = await person('pt-owner');
    ws = await createWorkspace(owner, 'Tool loop');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    grantId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });
  beforeEach(() => {
    compute.dispatched = []; compute.counted = [];
    session = new FakeSession(); opened = 0;
    host = async () => { opened += 1; return session; };
  });

  test('a run reserves its turns × the largest request, never above the per-run ceiling; a model without tool calling reserves one request', async () => {
    const reserved = async (useCases = runs) => {
      const started = await ask('Reserve', useCases);
      await runs.stop(human(owner), started.run.id); // queued: ends at zero cost, nothing is sent
      return (await row(started.run.id)).reserved_micros;
    };
    await useConnection({}, 50);
    assert.equal(await reserved(), 470_000, '10 × (16,000 × $2/M + 1,500 × $10/M) fits the $0.50 ceiling');
    await useConnection({}, 20);
    assert.equal(await reserved(), 200_000, 'capped by the owner\'s per-run ceiling');
    await useConnection({}, 6);
    assert.equal(await reserved(), 60_000, 'the $0.06 default ceiling');
    assert.equal(await reserved(singleRequestRuns), 47_000, 'a worker without the tool loop reserves the single request of O-008');
    await useConnection({ toolCalling: false }, 50);
    assert.equal(await reserved(), 47_000, 'a model marked without tool calling is one request');
    await useConnection({ provider: 'openai', model: 'gpt-6-astra' }, 50);
    assert.equal(await reserved(), 47_000, 'so is one Flux\'s table lists as needing the Responses API');
    assert.equal(compute.dispatched.length, 0);
  });

  test('AST-8.2: a fake provider that keeps calling tools stops at the money reservation; the changes made stay, the cost is never above the reservation', async () => {
    await useConnection({}, 20); // reservation 200,000 = 4 maximum requests of 47,000 and a rest
    compute.respond = async () => toolUse(compute.dispatched.length, MAX_USAGE);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'cap_reached');
    const stored = await row(started.run.id);
    assert.equal(stored.reserved_micros, 200_000);
    assert.equal(compute.dispatched.length, 4, 'a fifth request could have cost more than is left');
    assert.deepEqual(session.changes.map((call) => call.id), ['call-1', 'call-2', 'call-3'], 'the calls of the first three turns were made; the last turn\'s was not');
    assert.deepEqual([stored.status, stored.stopped_at_stage, stored.cost_state, stored.charged_micros], ['cap_reached', 'before_dispatch', 'observed', 4 * 47_000]);
    assert.ok(stored.charged_micros <= stored.reserved_micros, 'never above the reservation');
    assert.deepEqual([stored.input_tokens, stored.output_tokens], [4 * 16_000, 4 * 1_500], 'the usage of every request is kept, summed');
    assert.equal(stored.answer_body, null, 'a run that hit its limit posts nothing');
    assert.equal(session.closed, 1);
    // Each request carried the tools and the earlier turns with their results.
    assert.deepEqual(compute.dispatched[0]!.tools, FLUX_TOOLS);
    assert.equal(compute.dispatched[0]!.system, TOOL_SYSTEM_PROMPT);
    assert.deepEqual(compute.dispatched[3]!.turns!.map((turn) => turn.results[0]!.content), ['done call-1', 'done call-2', 'done call-3']);
    assert.deepEqual(compute.dispatched[3]!.turns![0]!.replay, { turn: 1 }, 'the provider\'s own assistant message goes back unchanged');
  });

  test('AST-8.2: a fake provider that keeps calling tools stops at the turn cap', async () => {
    await useConnection({}, 50);
    compute.respond = async () => toolUse(compute.dispatched.length);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'cap_reached');
    const stored = await row(started.run.id);
    assert.equal(compute.dispatched.length, PERSONAL_RUN_LIMITS.maxTurns);
    assert.equal(session.changes.length, PERSONAL_RUN_LIMITS.maxTurns - 1);
    assert.deepEqual([stored.status, stored.cost_state, stored.charged_micros], ['cap_reached', 'observed', PERSONAL_RUN_LIMITS.maxTurns * 2_500]);
    assert.equal(session.closed, 1);
  });

  test('a run that ends in the model\'s answer commits it, charges the sum of its requests and closes its tools once', async () => {
    await useConnection({}, 50);
    compute.respond = async () => (compute.dispatched.length === 1 ? toolUse(1)
      : { kind: 'completed', stopReason: 'end_turn', text: 'Fact: I renamed the task [S1].', usage: { inputTokens: 1_500, outputTokens: 40 } });
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.cost_state, stored.charged_micros], ['completed', 'observed', 2_500 + (1_500 * 2 + 40 * 10)]);
    assert.deepEqual([stored.input_tokens, stored.output_tokens], [2_500, 90]);
    assert.match(stored.answer_body ?? '', /I renamed the task \[1\]/);
    assert.equal(session.closed, 1);
    assert.equal(opened, 1);
  });

  test('AST-8.3: a model marked without tool support gets one request with no tools and cannot change anything', async () => {
    for (const model of [{ toolCalling: false }, { provider: 'openai' as const, model: 'gpt-6-astra' }]) {
      await useConnection(model, 50);
      compute.dispatched = [];
      compute.respond = async () => ({ kind: 'completed', stopReason: 'end_turn', text: 'Fact: nothing changed [S1].', usage: { inputTokens: 900, outputTokens: 30 } });
      const started = await ask();
      assert.equal(await processor.process(started.run.id), 'completed', JSON.stringify(model));
      assert.equal(compute.dispatched.length, 1, 'one request');
      assert.equal('tools' in compute.dispatched[0]!, false, 'no tools on the request');
      assert.equal('turns' in compute.dispatched[0]!, false);
      assert.equal(compute.dispatched[0]!.system, SYSTEM_PROMPT, 'the brief of O-008, without the tool paragraph');
      assert.equal(opened, 0, 'the run\'s tools were never even opened');
      assert.equal(session.changes.length, 0);
      assert.equal((await row(started.run.id)).charged_micros, 900 * 2 + 30 * 10);
    }
  });

  test('AST-8.3: even a provider that answers with a tool call to a request that offered none changes nothing and posts nothing', async () => {
    await useConnection({ toolCalling: false }, 50);
    compute.respond = async () => toolUse(1);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'provider_failed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], ['observed', 2_500, null], 'it was billed, so the charge is kept; the half answer is withheld');
    assert.equal(compute.dispatched.length, 1);
    assert.equal(session.changes.length, 0);
  });

  test('no tools to open, an empty tool list or a model without tools is one request, as before; a host that cannot open them ends the run unavailable at zero cost', async () => {
    await useConnection({}, 50);
    compute.respond = async () => ({ kind: 'completed', stopReason: 'end_turn', text: 'Fact: ok [S1].', usage: { inputTokens: 500, outputTokens: 20 } });
    host = async () => null;
    const none = await ask();
    assert.equal(await processor.process(none.run.id), 'completed');
    assert.equal('tools' in compute.dispatched[0]!, false);
    compute.dispatched = [];
    const empty = new FakeSession();
    empty.tools = [];
    host = async () => empty;
    const emptyRun = await ask();
    assert.equal(await processor.process(emptyRun.run.id), 'completed');
    assert.equal('tools' in compute.dispatched[0]!, false);
    assert.equal(empty.closed, 1, 'a session with no tools is still closed');
    compute.dispatched = [];
    host = async () => { throw new Error('no run token'); };
    const refused = await ask();
    assert.equal(await processor.process(refused.run.id), 'unavailable');
    assert.deepEqual([(await row(refused.run.id)).cost_state, (await row(refused.run.id)).charged_micros], ['released', 0]);
    assert.equal(compute.dispatched.length, 0, 'the run does not quietly become another run');
  });

  test('access revoked between two turns ends the run before the next request, with the first turn charged and its changes kept', async () => {
    await useConnection({}, 50);
    compute.respond = async () => toolUse(compute.dispatched.length);
    session.onCall = async () => {
      expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${place.id}/grants/${grantId}`), 204, 'revoke the agent grant');
    };
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'denied');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.stopped_at_stage, stored.cost_state, stored.charged_micros, stored.answer_body], ['before_dispatch', 'observed', 2_500, null]);
    assert.equal(compute.dispatched.length, 1, 'no request after the revocation');
    assert.equal(session.changes.length, 1);
    grantId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201) as { id: string }).id;
  });

  test('Stop during a call ends the run stopped: the charge so far is kept, no further request is sent', async () => {
    await useConnection({}, 50);
    compute.respond = async () => toolUse(compute.dispatched.length);
    const started = await ask();
    session.onCall = async () => { await runs.stop(human(owner), started.run.id); };
    assert.equal(await processor.process(started.run.id), 'stopped');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], ['observed', 2_500, null]);
    assert.equal(compute.dispatched.length, 1);
  });

  test('a request outside its token limits makes the run\'s cost unknown: the whole reservation stays counted, nothing is posted, what ran stays', async () => {
    await useConnection({}, 50);
    compute.respond = async () => (compute.dispatched.length === 1 ? toolUse(1)
      : { kind: 'completed', stopReason: 'end_turn', text: 'Fact: ok [S1].', usage: { inputTokens: 16_001, outputTokens: 10 } });
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'provider_failed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.cost_state, stored.charged_micros, stored.input_tokens, stored.answer_body], ['unknown', 0, null, null]);
    assert.equal(stored.reserved_micros, 470_000);
    assert.equal(session.changes.length, 1);
    const status = await runs.status(human(owner));
    assert.ok(status.today!.reservedMicros >= 470_000, 'the daily cap still counts the whole reservation');
  });

  test('a request that fails after the first turn keeps the earlier charge when nothing was sent, and the whole reservation when it may have been billed', async () => {
    await useConnection({}, 50);
    for (const [billed, state, charged] of [['none', 'observed', 2_500], ['unknown', 'unknown', 0]] as const) {
      compute.dispatched = [];
      session = new FakeSession();
      compute.respond = async () => (compute.dispatched.length === 1 ? toolUse(1) : { kind: 'failed', reason: 'rate_limited', billed });
      const started = await ask();
      assert.equal(await processor.process(started.run.id), 'provider_failed', billed);
      const stored = await row(started.run.id);
      assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], [state, charged, null], billed);
      assert.equal(session.closed, 1);
    }
  });
});
