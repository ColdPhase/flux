import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  createPersonalRunProcessor, SYSTEM_PROMPT, TOOL_SYSTEM_PROMPT,
  type PersonalComputeResult, type PersonalTool, type PersonalToolCall, type PersonalToolHost, type PersonalToolSession, type Principal,
} from '@flux/core';
import { PERSONAL_RUN_LIMITS, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, loseSpace, pool } from './support/db.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { FLUX_TOOLS } from './support/provider-tool-fixtures.js';

// The `server` tool loop in the worker (F-027 AST-8.2 and AST-8.3, issue #406): the reservation over
// the turns, the safety bound on steps, the key's daily budget, the rechecks between turns and the model without
// tool calling, driven through the real use cases, the real worker processor and the real database
// with a FAKE provider and a FAKE tool session. No model is called and no `/mcp` route is: the
// worker's MCP client with the run token is the next slice (A6 rest, A2). None of this is a
// provider, billing or compatibility pass.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });

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

const MAX_USAGE = { inputTokens: PERSONAL_RUN_LIMITS.maxToolInputTokens, outputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens };
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
  let agentId: string;

  /** The owner's assistant on a fresh connection (its daily budget, if given, is the only limit). */
  async function useConnection(model: Parameters<FakeConnections['connect']>[2] = {}) {
    await runs.remove(human(owner)).catch(() => undefined);
    const connectionId = randomUUID();
    // Turned on with room for one request; the test's own budget stands for what is left of the day.
    connections.connect(owner.id, connectionId, { ...model, dailyBudgetCents: 1_000 });
    await runs.enable(human(owner), { agentId, connection: connectionId, model: model.model ?? 'claude-sonnet-5' });
    connections.connect(owner.id, connectionId, model);
  }
  const ask = (prompt = 'Tidy the open tasks', useCases = runs) => useCases.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });

  before(async () => {
    owner = await person('pt-owner');
    ws = await createWorkspace(owner, 'Tool loop');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });
  beforeEach(() => {
    compute.dispatched = []; compute.counted = [];
    session = new FakeSession(); opened = 0;
    host = async () => { opened += 1; return session; };
  });

  test('a run reserves when it starts: its turns × the largest request, never above what is left of the key\'s daily budget (#854); a model without tool calling reserves one request', async () => {
    const reserved = async () => {
      compute.respond = async () => ({ kind: 'completed', stopReason: 'end_turn', text: 'Fact: ok [S1].', usage: { inputTokens: 100, outputTokens: 10 } });
      const started = await ask('Reserve');
      assert.equal((await row(started.run.id)).reserved_micros, 0, 'a request waiting its turn holds nothing');
      assert.equal(await processor.process(started.run.id), 'completed');
      return (await row(started.run.id)).reserved_micros;
    };
    await useConnection({ dailyBudgetCents: 50 });
    assert.equal(await reserved(), 500_000, '200 × (64,000 × $2/M + 4,000 × $10/M) is held to what is left of the $0.50 budget');
    await useConnection({});
    assert.equal(await reserved(), 10_000_000, 'and to the $10 a fresh key has left today');
    await useConnection({ toolCalling: false });
    assert.equal(await reserved(), 104_000, 'a model marked without tool calling is one request (32,000 × $2/M + 4,000 × $10/M)');
    await useConnection({ provider: 'openai', model: 'gpt-6-astra' });
    assert.equal(await reserved(), 104_000, 'so is one Flux\'s table lists as needing the Responses API');
    // Not even one request fits $0.10: the request waits for the key's next day instead of being refused (#854).
    await useConnection({ dailyBudgetCents: 10 });
    const paused = await ask('Too little left');
    assert.deepEqual([paused.run.status, paused.run.endReason, !!paused.run.resumesAt], ['queued', 'budget', true]);
    await runs.stop(human(owner), paused.run.id);
  });

  test('AST-8.2: a fake provider that keeps calling tools stops at the key\'s daily budget (#854); the changes made stay, the cost is never above the reservation', async () => {
    await useConnection({ dailyBudgetCents: 60 }); // reservation 600,000 = 3 largest requests of 168,000 and a rest
    compute.respond = async () => toolUse(compute.dispatched.length, MAX_USAGE);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'cap_reached');
    const stored = await row(started.run.id);
    assert.equal(stored.reserved_micros, 600_000);
    assert.equal(compute.dispatched.length, 3, 'a fourth request could have cost more than is left of the budget');
    assert.deepEqual(session.changes.map((call) => call.id), ['call-1', 'call-2'], 'the calls of the first two turns were made; the last turn\'s was not');
    assert.deepEqual([stored.status, stored.stopped_at_stage, stored.cost_state, stored.charged_micros], ['cap_reached', 'before_dispatch', 'observed', 3 * 168_000]);
    assert.equal((await pool.query('SELECT end_reason FROM personal_runs WHERE id = $1', [started.run.id])).rows[0].end_reason, 'budget');
    assert.ok(stored.charged_micros <= stored.reserved_micros, 'never above the reservation');
    assert.deepEqual([stored.input_tokens, stored.output_tokens], [3 * 64_000, 3 * 4_000], 'the usage of every request is kept, summed');
    assert.equal(stored.answer_body, null, 'a run that hit its limit posts nothing');
    assert.equal(session.closed, 1);
    // Each request carried the tools and the earlier turns with their results.
    assert.deepEqual(compute.dispatched[0]!.tools, FLUX_TOOLS);
    assert.equal(compute.dispatched[0]!.system, TOOL_SYSTEM_PROMPT);
    assert.deepEqual(compute.dispatched[2]!.turns!.map((turn) => turn.results[0]!.content), ['done call-1', 'done call-2']);
    assert.deepEqual(compute.dispatched[2]!.turns![0]!.replay, { turn: 1 }, 'the provider\'s own assistant message goes back unchanged');
  });

  test('AST-8.2: a fake provider that keeps calling tools stops at the safety bound on steps (#843: nobody meets it in normal use)', async () => {
    await useConnection({});
    compute.respond = async () => toolUse(compute.dispatched.length);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'cap_reached');
    const stored = await row(started.run.id);
    assert.equal(compute.dispatched.length, PERSONAL_RUN_LIMITS.maxTurns);
    assert.equal(session.changes.length, PERSONAL_RUN_LIMITS.maxTurns - 1);
    assert.deepEqual([stored.status, stored.cost_state, stored.charged_micros], ['cap_reached', 'observed', PERSONAL_RUN_LIMITS.maxTurns * 2_500]);
    assert.equal((await pool.query('SELECT end_reason FROM personal_runs WHERE id = $1', [started.run.id])).rows[0].end_reason, 'max_turns');
    assert.equal(session.closed, 1);
  });

  test('an API-key answer is redacted like a runtime answer: token-shaped strings never reach the conversation (#484)', async () => {
    await useConnection({});
    const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrSt';
    for (const [text, redacted] of [[`Fact: the key is ${secret} and Bearer abc.def-123 [S1].`, true], ['Fact: nothing secret here [S1].', false]] as const) {
      compute.respond = async () => ({ kind: 'completed', stopReason: 'end_turn', text, usage: { inputTokens: 500, outputTokens: 20 } });
      const started = await ask();
      assert.equal(await processor.process(started.run.id), 'completed');
      const stored = (await pool.query('SELECT answer_body, answer_redacted FROM personal_runs WHERE id = $1', [started.run.id])).rows[0] as { answer_body: string; answer_redacted: boolean };
      assert.equal(stored.answer_redacted, redacted);
      assert.ok(!stored.answer_body.includes(secret) && !stored.answer_body.includes('abc.def-123'), 'the secret is not stored');
      if (redacted) assert.ok(stored.answer_body.includes('[removed: looked like a secret]'));
    }
  });

  test('a run that ends in the model\'s answer commits it, charges the sum of its requests and closes its tools once', async () => {
    await useConnection({});
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
      await useConnection(model);
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
    await useConnection({ toolCalling: false });
    compute.respond = async () => toolUse(1);
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'provider_failed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], ['observed', 2_500, null], 'it was billed, so the charge is kept; the half answer is withheld');
    assert.equal(compute.dispatched.length, 1);
    assert.equal(session.changes.length, 0);
  });

  test('no tools to open, an empty tool list or a model without tools is one request, as before; a host that cannot open them ends the run unavailable at zero cost', async () => {
    await useConnection({});
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
    await useConnection({});
    compute.respond = async () => toolUse(compute.dispatched.length);
    let restore: (() => Promise<void>) | null = null;
    session.onCall = async () => {
      // The owner no longer has the space: their assistant loses it with them (F-036 AG-3).
      restore = await loseSpace(place.id, owner.id);
    };
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'denied');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.stopped_at_stage, stored.cost_state, stored.charged_micros, stored.answer_body], ['before_dispatch', 'observed', 2_500, null]);
    assert.equal(compute.dispatched.length, 1, 'no request after the revocation');
    assert.equal(session.changes.length, 1);
    await restore!();
  });

  test('Stop during a call ends the run stopped: the charge so far is kept, no further request is sent', async () => {
    await useConnection({});
    compute.respond = async () => toolUse(compute.dispatched.length);
    const started = await ask();
    session.onCall = async () => { await runs.stop(human(owner), started.run.id); };
    assert.equal(await processor.process(started.run.id), 'stopped');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.cost_state, stored.charged_micros, stored.answer_body], ['observed', 2_500, null]);
    assert.equal(compute.dispatched.length, 1);
  });

  test('a request outside its token limits makes the run\'s cost unknown: the most it could have cost stays counted, nothing is posted, what ran stays', async () => {
    await useConnection({});
    compute.respond = async () => (compute.dispatched.length === 1 ? toolUse(1)
      : { kind: 'completed', stopReason: 'end_turn', text: 'Fact: ok [S1].', usage: { inputTokens: 64_001, outputTokens: 10 } });
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'provider_failed');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.cost_state, stored.charged_micros, stored.input_tokens, stored.answer_body], ['unknown', 0, null, null]);
    assert.equal(stored.reserved_micros, 2_500 + 168_000, 'the first request and the largest the second could have cost');
    assert.equal(session.changes.length, 1);
    const status = await runs.status(human(owner));
    assert.ok(status.today!.chargedMicros >= 170_500, 'the key\'s daily budget still counts it');
  });

  test('#854: a request that waited overnight counts on the day it runs: three of them spend no more than one day\'s budget, and the spend shows', async () => {
    await useConnection({ dailyBudgetCents: 20 });
    compute.respond = async () => ({ kind: 'completed', stopReason: 'end_turn', text: 'Fact: ok [S1].', usage: MAX_USAGE });
    const asked = [(await ask('First')).run.id, (await ask('Second')).run.id, (await ask('Third')).run.id];
    await pool.query(`UPDATE personal_runs SET created_at = now() - interval '1 day', reserved_at = now() - interval '1 day',
      resume_at = now() - interval '1 second', end_reason = 'budget' WHERE id = ANY($1::uuid[])`, [asked]);
    assert.equal(await processor.process(asked[0]!), 'completed');
    assert.equal(await processor.process(asked[1]!), 'skipped', 'not enough is left of today for a second largest request');
    assert.equal(await processor.process(asked[2]!), 'skipped');
    assert.equal((await runs.status(human(owner))).today!.chargedMicros, 168_000, 'the spend of a request asked yesterday shows today');
    const { rows: [waiting] } = await pool.query('SELECT status, end_reason FROM personal_runs WHERE id = $1', [asked[1]]);
    assert.deepEqual([waiting.status, waiting.end_reason], ['queued', 'budget']);
    for (const id of asked.slice(1)) await runs.stop(human(owner), id);
  });

  test('#854: choosing a model on another connection does not touch a request already sent; it finishes on its own key', async () => {
    await useConnection({});
    const { connectionId } = (await pool.query('SELECT connection_id AS "connectionId" FROM personal_run_enablements WHERE owner_user_id = $1', [owner.id])).rows[0];
    const other = randomUUID();
    connections.connect(owner.id, other, {});
    compute.respond = async () => {
      await runs.chooseModel(human(owner), { connection: other, model: 'claude-sonnet-5' });
      return { kind: 'completed', stopReason: 'end_turn', text: 'Fact: finished [S1].', usage: { inputTokens: 100, outputTokens: 10 } };
    };
    const sent = await ask('Finish this');
    assert.equal(await processor.process(sent.run.id), 'completed', 'the owner pays for this request, so it answers');
    assert.equal((await pool.query('SELECT connection_id FROM personal_runs WHERE id = $1', [sent.run.id])).rows[0].connection_id, connectionId);
  });

  test('CA-3: the provider\'s API credits ran out: one end of its own, nothing billed, nothing switches', async () => {
    await useConnection({});
    compute.respond = async () => ({ kind: 'failed', reason: 'no_credits', billed: 'none' });
    const started = await ask('When credits are out');
    assert.equal(await processor.process(started.run.id), 'provider_failed');
    const { rows: [ended] } = await pool.query('SELECT end_reason, cost_state FROM personal_runs WHERE id = $1', [started.run.id]);
    assert.deepEqual([ended.end_reason, ended.cost_state], ['credits', 'released']);
  });

  test('#854: a request that may have been billed never uses up the key\'s day: the rest of the reservation goes back and the next request runs', async () => {
    await useConnection({ dailyBudgetCents: 100 });
    compute.respond = async () => ({ kind: 'failed', reason: 'provider_error', billed: 'unknown' });
    const lost = await ask();
    assert.equal(await processor.process(lost.run.id), 'provider_failed');
    const stored = await row(lost.run.id);
    assert.deepEqual([stored.cost_state, stored.reserved_micros], ['unknown', 168_000], 'the largest possible request, not the run\'s $1');
    let during: { chargedMicros: number; reservedMicros: number } | null = null;
    compute.respond = async () => {
      during = (await runs.status(human(owner))).today;
      return { kind: 'completed', stopReason: 'end_turn', text: 'Fact: ok [S1].', usage: { inputTokens: 100, outputTokens: 10 } };
    };
    const next = await ask();
    assert.equal(await processor.process(next.run.id), 'completed');
    assert.equal((await row(next.run.id)).reserved_micros, 832_000, 'what is left of the $1 budget');
    assert.deepEqual([during!.chargedMicros, during!.reservedMicros], [168_000, 832_000], 'what a working run holds is not shown as spent');
  });

  test('a request that fails after the first turn keeps the earlier charge when nothing was sent, and stays unknown when it may have been billed', async () => {
    await useConnection({});
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
