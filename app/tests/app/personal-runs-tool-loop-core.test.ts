import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PERSONAL_RUN_LIMITS, tablePrice } from '@flux/contracts';
import {
  connectionCallsTools, emptyAccount, nextRequestFits, reconcileRequest, runReservationMicros, runToolLoop, toolRunReservationMicros,
  type Gate, type LoopOptions, type PersonalCompute, type PersonalComputeRequest, type PersonalComputeResult, type PersonalToolCall, type PersonalToolSession,
} from '@flux/core';
import { FLUX_TOOLS } from './support/provider-tool-fixtures.js';

// The pure rules of the `server` tool loop (F-027 AST-8, PROV-3 revised 2026-10-09): the reservation
// over the turns, the per-request reconciliation and the loop's limits, with a fake provider and a
// fake tool session. No database, no provider, no key.

const SONNET = tablePrice('anthropic', 'claude-sonnet-5')!;
const ONE = runReservationMicros(SONNET)!; // 16,000 × $2/M + 1,500 × $10/M
const MAX_USAGE = { inputTokens: PERSONAL_RUN_LIMITS.maxInputTokens, outputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens };

const request: PersonalComputeRequest = {
  connection: { id: 'c1', keyRef: 'k', provider: 'anthropic', baseUrl: null }, model: 'claude-sonnet-5', maxTokens: 1_500, effort: 'low',
  system: 'brief', input: 'Request: tidy the tasks', tools: FLUX_TOOLS,
};
const toolUse = (id: string, usage: { inputTokens: number; outputTokens: number } = { inputTokens: 1_000, outputTokens: 50 }, extra: Partial<PersonalToolCall> = {}): PersonalComputeResult => ({
  kind: 'completed', text: `calling ${id}`, stopReason: 'tool_use', usage, replay: [{ type: 'tool_use', id }],
  toolCalls: [{ id, name: 'flux_update_work', input: { id: 'w1', title: `t-${id}` }, ...extra }],
});
const answer = (usage = { inputTokens: 1_200, outputTokens: 80 }): PersonalComputeResult => ({ kind: 'completed', text: 'Fact: done [S1]', stopReason: 'end_turn', usage });

class FakeProvider implements PersonalCompute {
  enabled = true;
  sent: PersonalComputeRequest[] = [];
  counted = 0;
  constructor(private readonly respond: (turn: number, request: PersonalComputeRequest) => PersonalComputeResult | Promise<PersonalComputeResult>) {}
  async dispatch(next: PersonalComputeRequest) { this.sent.push(next); return this.respond(this.sent.length, next); }
}

class FakeSession implements PersonalToolSession {
  readonly tools = FLUX_TOOLS;
  calls: PersonalToolCall[] = [];
  closed = 0;
  constructor(private readonly reply: (call: PersonalToolCall) => { content: string; isError: boolean } | Promise<{ content: string; isError: boolean }> = () => ({ content: 'ok', isError: false })) {}
  async call(call: PersonalToolCall) { this.calls.push(call); return this.reply(call); }
  async close() { this.closed += 1; }
}

const go: Gate = async () => null;
function loop(compute: PersonalCompute, session: PersonalToolSession, overrides: Partial<LoopOptions> = {}) {
  return runToolLoop({
    compute, session, first: request, price: SONNET, reservedMicros: ONE * 10, maxTurns: PERSONAL_RUN_LIMITS.maxTurns, deadline: Number.MAX_SAFE_INTEGER, now: () => 0,
    gate: go, signal: new AbortController().signal, ...overrides,
  });
}

describe('the reservation over the turns (AST-8, PROV-3)', () => {
  test('turns × the largest request, never above the per-run ceiling and never below one request', () => {
    assert.equal(ONE, 47_000);
    assert.equal(toolRunReservationMicros(SONNET, 500_000, 10), 470_000, '10 × $0.047 fits the $0.50 ceiling');
    assert.equal(toolRunReservationMicros(SONNET, 200_000, 10), 200_000, 'capped by the owner\'s per-run ceiling');
    assert.equal(toolRunReservationMicros(SONNET, 60_000, 10), 60_000, 'the $0.06 default ceiling');
    assert.equal(toolRunReservationMicros(SONNET, 500_000, 1), ONE, 'one turn is today\'s single request');
    assert.equal(toolRunReservationMicros(SONNET, 20_000, 10), ONE, 'a ceiling below one request still reserves one (the connection is refused before)');
    assert.equal(toolRunReservationMicros(null, 500_000), null, 'no price, no reservation');
    assert.equal(toolRunReservationMicros({ inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 }, 500_000), 0, 'a free self-hosted model reserves nothing');
  });

  test('a model the owner marked, or Flux\'s table lists, without tool calling is not offered tools', () => {
    assert.equal(connectionCallsTools({ provider: 'anthropic', model: 'claude-sonnet-5' }), true);
    assert.equal(connectionCallsTools({ provider: 'anthropic', model: 'claude-sonnet-5', toolCalling: true }), true);
    assert.equal(connectionCallsTools({ provider: 'anthropic', model: 'claude-sonnet-5', toolCalling: false }), false, 'the owner\'s mark');
    assert.equal(connectionCallsTools({ provider: 'openai', model: 'gpt-6-astra' }), false, 'dated table: needs the Responses API');
    assert.equal(connectionCallsTools({ provider: 'openai', model: 'gpt-5.4' }), true);
  });
});

describe('per-request reconciliation (PROV-3)', () => {
  test('each request is charged at the connection price or as the provider reported it, and the sum stays inside the reservation', () => {
    const account = emptyAccount();
    assert.equal(reconcileRequest(account, { inputTokens: 1_000, outputTokens: 50 }, SONNET, 10_000), true);
    assert.deepEqual(account, { micros: 2_500, inputTokens: 1_000, outputTokens: 50, requests: 1, unknown: false });
    assert.equal(reconcileRequest(account, { inputTokens: 1, outputTokens: 1, reportedCostMicros: 7 }, SONNET, 10_000), true, 'a reported cost replaces the token estimate');
    assert.equal(account.micros, 2_507);
    assert.equal(account.requests, 2);
  });

  test('a request outside its token limits, or one that would take the run above its reservation, is a lost response', () => {
    for (const usage of [{ inputTokens: 16_001, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1_501 }, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.5, outputTokens: 0 }]) {
      const account = emptyAccount();
      assert.equal(reconcileRequest(account, usage, SONNET, 1_000_000), false, JSON.stringify(usage));
      assert.deepEqual(account, { ...emptyAccount(), unknown: true }, 'nothing of it is stored');
    }
    const account = emptyAccount();
    assert.equal(reconcileRequest(account, MAX_USAGE, SONNET, ONE), true);
    assert.equal(reconcileRequest(account, { inputTokens: 1, outputTokens: 0, reportedCostMicros: 1 }, SONNET, ONE), false, 'one micro above the reservation');
    assert.equal(account.micros, ONE, 'the charge never exceeds the reservation');
    assert.equal(account.unknown, true);
  });

  test('the next request fits only while the largest possible request still fits what is left', () => {
    const account = emptyAccount();
    assert.equal(nextRequestFits(account, SONNET, ONE), true);
    account.micros = 1;
    assert.equal(nextRequestFits(account, SONNET, ONE), false);
    account.micros = 2 * ONE;
    assert.equal(nextRequestFits(account, SONNET, 3 * ONE), true);
    assert.equal(nextRequestFits(account, SONNET, 3 * ONE - 1), false);
  });
});

describe('the bounded loop', () => {
  test('a model that stops asking for tools ends the run with its answer; every request was reconciled by itself', async () => {
    const provider = new FakeProvider((turn) => (turn < 3 ? toolUse(`c${turn}`) : answer()));
    const session = new FakeSession();
    const result = await loop(provider, session);
    assert.equal(result.end.kind, 'answer');
    assert.equal(result.turns, 3);
    assert.deepEqual(session.calls.map((call) => call.id), ['c1', 'c2']);
    assert.deepEqual(result.account, { micros: 2 * (1_000 * 2 + 50 * 10) + (1_200 * 2 + 80 * 10), inputTokens: 3_200, outputTokens: 180, requests: 3, unknown: false });
    // The second request carries the first turn with its result; the third carries both.
    assert.equal(provider.sent[0]!.turns, undefined);
    assert.deepEqual(provider.sent[1]!.turns!.map((turn) => turn.results), [[{ callId: 'c1', content: 'ok', isError: false }]]);
    assert.equal(provider.sent[2]!.turns!.length, 2);
    assert.deepEqual(provider.sent[2]!.tools, FLUX_TOOLS, 'the same tools every turn');
  });

  test('a fake provider that keeps calling tools stops at the turn cap; what it asked for in the last turn is not run (AST-8.2)', async () => {
    const provider = new FakeProvider((turn) => toolUse(`c${turn}`));
    const session = new FakeSession();
    const result = await loop(provider, session, { maxTurns: 4 });
    assert.deepEqual(result.end, { kind: 'limit', limit: 'turns' });
    assert.equal(provider.sent.length, 4, 'never more requests than the cap');
    assert.deepEqual(session.calls.map((call) => call.id), ['c1', 'c2', 'c3'], 'the changes of the turns before the cap stay made; the last turn\'s call is not run');
    assert.equal(result.account.requests, 4);
    assert.ok(result.account.micros <= ONE * 10);
  });

  test('it stops at the money reservation when the next request could cost more than is left; the cost is never above the reservation (AST-8.2)', async () => {
    const reserved = Math.floor(ONE * 2.5);
    const provider = new FakeProvider((turn) => toolUse(`c${turn}`, MAX_USAGE));
    const session = new FakeSession();
    const result = await loop(provider, session, { reservedMicros: reserved });
    assert.deepEqual(result.end, { kind: 'limit', limit: 'money' });
    assert.equal(provider.sent.length, 2, 'two maximum requests fit 2.5, a third could not');
    assert.deepEqual(session.calls.map((call) => call.id), ['c1'], 'the second turn\'s call was not run: its result could not be sent');
    assert.equal(result.account.micros, 2 * ONE);
    assert.ok(result.account.micros <= reserved);
    assert.equal(result.account.unknown, false);
  });

  test('a request whose reported cost is above what is left of the reservation ends the run as a lost response, with nothing run for it', async () => {
    // The check before the second request stops a run whose next largest request cannot fit.
    const stopped = await loop(new FakeProvider((turn) => toolUse(`c${turn}`, MAX_USAGE)), new FakeSession(), { reservedMicros: ONE + 1_000 });
    assert.deepEqual(stopped.end, { kind: 'limit', limit: 'money' });
    // A provider that reports a cost above the reservation (usage.cost) cannot take the run past it.
    const session = new FakeSession();
    const lax = await loop(new FakeProvider((turn) => (turn === 1 ? toolUse('a', { inputTokens: 100, outputTokens: 10 })
      : { ...toolUse('b', { inputTokens: 100, outputTokens: 10 }), usage: { inputTokens: 100, outputTokens: 10, reportedCostMicros: 60_000 } })), session, { reservedMicros: ONE + 300 });
    assert.deepEqual(lax.end, { kind: 'lost' });
    assert.equal(lax.account.unknown, true);
    assert.equal(lax.account.micros, 300, 'only the first request was reconciled');
    assert.deepEqual(session.calls.map((call) => call.id), ['a'], 'nothing the lost response asked for is run');
  });

  test('a request outside its token limits is lost: its numbers are not kept and nothing it asked for runs', async () => {
    const session = new FakeSession();
    const result = await loop(new FakeProvider(() => toolUse('c1', { inputTokens: 16_001, outputTokens: 10 })), session);
    assert.deepEqual(result.end, { kind: 'lost' });
    assert.equal(session.calls.length, 0);
    assert.deepEqual(result.account, { ...emptyAccount(), unknown: true });
  });

  test('a failed request keeps what the earlier ones cost; only one that may have been billed makes the cost unknown', async () => {
    const failing = (billed: 'none' | 'unknown') => new FakeProvider((turn) => (turn === 1 ? toolUse('c1') : { kind: 'failed', reason: 'rate_limited', billed }));
    const free = await loop(failing('none'), new FakeSession());
    assert.equal(free.end.kind, 'failed');
    assert.deepEqual([free.account.micros, free.account.unknown], [2_500, false]);
    const lost = await loop(failing('unknown'), new FakeSession());
    assert.equal(lost.account.unknown, true);
    const thrown = await loop(new FakeProvider(() => { throw new Error('adapter bug'); }), new FakeSession());
    assert.deepEqual(thrown.end, { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'unknown' } });
    assert.equal(thrown.account.unknown, true);
  });

  test('the standing gate runs before the calls of a turn and before the next request; a refusal ends the run with the earlier turns kept', async () => {
    const provider = new FakeProvider((turn) => toolUse(`c${turn}`));
    const session = new FakeSession();
    let checks = 0;
    const result = await loop(provider, session, { gate: async () => { checks += 1; return checks === 2 ? { status: 'revoked' } : null; } });
    assert.deepEqual(result.end, { kind: 'halted', status: 'revoked' });
    assert.equal(provider.sent.length, 1, 'no second request after the refusal');
    assert.deepEqual(session.calls.map((call) => call.id), ['c1'], 'the call made before the refusal stays made');
    const before = await loop(new FakeProvider(() => toolUse('x')), new FakeSession(), { gate: async () => ({ status: 'stopped' }) });
    assert.deepEqual(before.end, { kind: 'halted', status: 'stopped' });
    assert.equal(before.account.requests, 1);
  });

  test('a call the provider could not state as JSON, or outside the offered tools, is never sent to the session', async () => {
    const calls: PersonalComputeResult = { kind: 'completed', text: '', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [
        { id: 'bad', name: 'flux_update_work', input: {}, invalid: true },
        { id: 'rogue', name: 'flux_delete_everything', input: {} },
        { id: 'good', name: 'flux_list_work', input: { projectId: 'p' } },
      ] };
    const provider = new FakeProvider((turn) => (turn === 1 ? calls : answer()));
    const session = new FakeSession();
    const result = await loop(provider, session);
    assert.equal(result.end.kind, 'answer');
    assert.deepEqual(session.calls.map((call) => call.id), ['good']);
    assert.deepEqual(provider.sent[1]!.turns![0]!.results.map((item) => [item.callId, item.isError]), [['bad', true], ['rogue', true], ['good', false]], 'every call is answered, in order');
  });

  test('a session that throws answers with an error result and the loop goes on', async () => {
    const provider = new FakeProvider((turn) => (turn === 1 ? toolUse('c1') : answer()));
    const result = await loop(provider, new FakeSession(() => { throw new Error('route down'); }));
    assert.equal(result.end.kind, 'answer');
    assert.deepEqual(provider.sent[1]!.turns![0]!.results, [{ callId: 'c1', content: 'The call failed.', isError: true }]);
  });

  test('a result that would take the next request over the input bound ends the run before it is sent', async () => {
    const provider = new FakeProvider((turn) => toolUse(`c${turn}`));
    const huge = 'x'.repeat(PERSONAL_RUN_LIMITS.maxInputTokens);
    const session = new FakeSession(() => ({ content: huge, isError: false }));
    const result = await loop(provider, session);
    assert.deepEqual(result.end, { kind: 'limit', limit: 'input' });
    assert.equal(provider.sent.length, 1);
    assert.equal(session.calls.length, 1, 'the call was made; its result could not be sent');
  });

  test('a provider token count may only raise the estimate: a count over the bound ends the run, a failed count ends it without a request', async () => {
    const counting = (count: () => Promise<number | null>): PersonalCompute => {
      const provider = new FakeProvider((turn) => (turn === 1 ? toolUse('c1') : answer()));
      return { enabled: true, dispatch: (next) => provider.dispatch(next), countInputTokens: async () => count() };
    };
    assert.deepEqual((await loop(counting(async () => PERSONAL_RUN_LIMITS.maxInputTokens + 1), new FakeSession())).end, { kind: 'limit', limit: 'input' });
    const failed = await loop(counting(async () => { throw new Error('count down'); }), new FakeSession());
    assert.deepEqual(failed.end, { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'none' } });
    assert.equal(failed.account.unknown, false, 'a count sends nothing to bill');
    assert.equal((await loop(counting(async () => 12), new FakeSession())).end.kind, 'answer');
  });

  test('the clock ends the run before another request starts', async () => {
    let time = 0;
    const provider = new FakeProvider((turn) => { time += 100_000; return toolUse(`c${turn}`); });
    const result = await loop(provider, new FakeSession(), { deadline: 250_000, now: () => time });
    assert.deepEqual(result.end, { kind: 'limit', limit: 'time' });
    assert.equal(provider.sent.length, 3);
  });

  test('the clock is read again at the dispatch boundary: a deadline crossed during a tool call, the gate or the input count ends the run before the next request', async () => {
    const DEADLINE = 10;
    /** One run on a fake clock; `cross` moves the clock past the deadline at the chosen point. */
    async function run(cross: 'never' | 'call' | 'gate' | 'count') {
      let time = 0;
      let gates = 0;
      const provider = new FakeProvider((turn) => (turn === 1 ? toolUse('c1') : answer()));
      const compute: PersonalCompute = {
        enabled: true, dispatch: (next) => provider.dispatch(next),
        countInputTokens: async () => { if (cross === 'count') time = DEADLINE + 1; return 12; },
      };
      const session = new FakeSession(() => { if (cross === 'call') time = DEADLINE + 1; return { content: 'ok', isError: false }; });
      const gate: Gate = async () => { gates += 1; if (cross === 'gate' && gates === 2) time = DEADLINE + 1; return null; };
      const result = await loop(compute, session, { deadline: DEADLINE, now: () => time, gate });
      return { result, session, sent: provider.sent.length };
    }
    // Within the deadline the run goes on: the control.
    const control = await run('never');
    assert.equal(control.result.end.kind, 'answer');
    assert.equal(control.sent, 2);
    for (const point of ['call', 'gate', 'count'] as const) {
      const crossed = await run(point);
      assert.deepEqual(crossed.result.end, { kind: 'limit', limit: 'time' }, `crossed during the ${point}`);
      assert.equal(crossed.sent, 1, `no request starts after the deadline (${point})`);
      assert.deepEqual(crossed.session.calls.map((call) => call.id), ['c1'], 'the call already made stays made');
    }
  });

  test('Stop during a call ends the loop without another request', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider(() => toolUse('c1'));
    const session = new FakeSession(() => { controller.abort(); return { content: 'ok', isError: false }; });
    const result = await loop(provider, session, { signal: controller.signal });
    assert.deepEqual(result.end, { kind: 'failed', result: { kind: 'failed', reason: 'aborted', billed: 'none' } });
    assert.equal(provider.sent.length, 1);
  });
});
