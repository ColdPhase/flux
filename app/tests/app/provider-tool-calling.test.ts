import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PERSONAL_RUN_LIMITS } from '@flux/contracts';
import type { PersonalCompute, PersonalComputeRequest, PersonalTurn } from '@flux/core';
import { BRIEF } from './support/brief.js';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import { FAKE_PRICE } from './support/personal-runs.js';
import {
  ANTHROPIC_DUPLICATE_IDS, ANTHROPIC_FINAL, ANTHROPIC_TOOL_USE, ANTHROPIC_TWO_CALLS, ANTHROPIC_TOOL_USE_TRUNCATED, ANTHROPIC_TOOL_USE_WITH_THINKING, CHAT_FINAL, CHAT_TOOL_CALLS,
  CHAT_TOOL_CALLS_TRUNCATED, CHAT_TWO_CALLS, FLUX_TOOLS, PROJECT_ID, RESPONSES_FINAL, RESPONSES_TOOL_CALLS, TOOL_WIRE_CASES, type ToolWireCase,
} from './support/provider-tool-fixtures.js';

// Tool calling in each provider adapter (F-027 AST-8.1, issue #406): the Flux tools written in each wire format, the tool calls read back,
// and the results sent in the next request. Since #1441 an API-key agent runs in pi in the agent runtime and no worker loop drives these
// turns; the adapters stay (`flux_web_search` and a tool-calling probe use them). Every test runs against a LOCAL MOCK HTTP server in this
// process that answers with the documented-shape fixtures of `support/provider-tool-fixtures.ts`. No real provider is called and no key
// exists: the "key" is a fixed test string. These tests prove what the adapters send and how they map answers; they are not a provider,
// billing or compatibility pass. The loopback mock is reached only because this suite's endpoint policy allows 127.0.0.1.

const KEY = 'test-only-not-a-key-tool-7f3a';
const KEY_REF = 'key-ref-of-owner';
const INPUT = BRIEF.request;
const TOOL_SYSTEM_PROMPT = BRIEF.system;

interface WireMessage { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { function: { arguments: string } }[] }
interface Body { tools?: unknown; messages: WireMessage[]; input?: unknown[]; system?: unknown; model?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown; max_output_tokens?: unknown; [field: string]: unknown }
interface Seen { path: string; headers: IncomingMessage['headers']; body: Body }

let seen: Seen[] = [];
let script: { status?: number; body: unknown }[] = [];
let origin = '';
const server = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    seen.push({ path: request.url ?? '', headers: request.headers, body: raw ? JSON.parse(raw) : {} });
    const next = script.shift();
    response.writeHead(next?.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(next?.body ?? { error: 'nothing scripted' }));
  });
});

const resolved: string[] = [];
function compute(): PersonalCompute {
  return providerPersonalCompute({
    enabled: true, timeoutMs: 2_000, policy: parsePrivateTargets('127.0.0.1'),
    baseUrls: { anthropic: origin, openai: `${origin}/v1`, openrouter: `${origin}/v1`, gemini: `${origin}/v1` },
    resolveKey: async (keyRef) => { resolved.push(keyRef); return keyRef === KEY_REF ? KEY : null; },
  });
}

function requestFor(wire: Pick<ToolWireCase, 'provider' | 'model'>, overrides: Partial<PersonalComputeRequest> = {}): PersonalComputeRequest {
  return {
    connection: { id: 'connection-1', keyRef: KEY_REF, provider: wire.provider, baseUrl: wire.provider === 'openai_compatible' ? `${origin}/v1` : null },
    model: wire.model, maxTokens: PERSONAL_RUN_LIMITS.maxOutputTokens, effort: PERSONAL_RUN_LIMITS.effort,
    system: TOOL_SYSTEM_PROMPT, input: INPUT, tools: FLUX_TOOLS, ...overrides,
  };
}

const live = new AbortController().signal;
const LISTED = '[{"id":"w1","title":"Camera in low light"}]';
const anthropic = TOOL_WIRE_CASES[0]!;
/** OpenAI itself, on the Responses API (#954). */
const openai = TOOL_WIRE_CASES[1]!;
/** A Chat Completions server (OpenRouter, Gemini's compatible endpoint and self-hosted servers speak it). */
const chat = TOOL_WIRE_CASES.find((wire) => wire.provider === 'openai_compatible')!;

/** The tool definitions as each wire format must carry them. */
const toolsOnWire = (wire: ToolWireCase['wire']) => wire === 'anthropic'
  ? FLUX_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
  : wire === 'responses' ? FLUX_TOOLS.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }))
    : FLUX_TOOLS.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
const pathOf = (wire: ToolWireCase['wire']) => (wire === 'anthropic' ? '/v1/messages' : wire === 'responses' ? '/v1/responses' : '/v1/chat/completions');

describe('tool calling on every provider wire format (AST-8.1; local mock, documented-shape fixtures, no provider pass)', () => {
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => { seen = []; script = []; resolved.length = 0; });

  for (const wire of TOOL_WIRE_CASES) {
    describe(wire.name, () => {
      test('the Flux tools go out in this wire format and the tool call comes back as a neutral call', async () => {
        script = [{ body: wire.toolCalls }];
        const result = await compute().dispatch(requestFor(wire), live);
        assert.equal(seen.length, 1, 'one request is one turn');
        const [sent] = seen;
        assert.equal(sent!.path, pathOf(wire.wire));
        assert.equal(sent!.headers.authorization, `Bearer ${KEY}`);
        assert.deepEqual(sent!.body.tools, toolsOnWire(wire.wire));
        assert.equal(sent!.body.tool_choice, undefined, 'the model chooses (auto); a forced choice is refused by some current models');
        for (const hosted of ['web_search_options', 'plugins', 'stream']) assert.equal(sent!.body[hosted], undefined, `no ${hosted}`);
        assert.equal(sent!.body.model, wire.model);
        assert.equal(sent!.body.max_tokens ?? sent!.body.max_completion_tokens ?? sent!.body.max_output_tokens, PERSONAL_RUN_LIMITS.maxOutputTokens);
        assert.equal(result.kind, 'completed');
        if (result.kind !== 'completed') return;
        assert.equal(result.stopReason, 'tool_use');
        assert.deepEqual(result.toolCalls, [{
          id: wire.wire === 'anthropic' ? 'toolu_01A09q90qw90lq917835lq9' : result.toolCalls![0]!.id, name: 'flux_list_work', input: { projectId: PROJECT_ID },
        }]);
        assert.deepEqual(result.usage, { inputTokens: wire.inputTokens, outputTokens: wire.outputTokens, ...(wire.reportedCostMicros ? { reportedCostMicros: wire.reportedCostMicros } : {}) },
          'the usage of every request is reported by itself');
        assert.deepEqual(result.replay, wire.assistantMessage, 'the provider\'s own assistant message is kept for the next request');
        assert.equal(JSON.stringify(result).includes(KEY), false, 'the key never appears in the result');
      });

      test('the result goes back in the next request: the assistant message unchanged, then one result per call; the tools are sent again', async () => {
        script = [{ body: wire.toolCalls }, { body: wire.final }];
        const adapter = compute();
        const first = await adapter.dispatch(requestFor(wire), live);
        assert.equal(first.kind, 'completed');
        if (first.kind !== 'completed') return;
        const turn: PersonalTurn = { text: first.text, calls: first.toolCalls!, results: [{ callId: first.toolCalls![0]!.id, content: LISTED, isError: false }], replay: first.replay };
        const second = await adapter.dispatch(requestFor(wire, { turns: [turn] }), live);
        assert.equal(second.kind, 'completed');
        if (second.kind !== 'completed') return;
        assert.equal(second.stopReason, 'end_turn');
        assert.equal(second.text, 'Fact: one item is open: Camera in low light [S1].');
        assert.equal(second.toolCalls, undefined);
        assert.equal(seen.length, 2);
        const body = seen[1]!.body;
        assert.deepEqual(body.tools, toolsOnWire(wire.wire), 'the tools are part of every request');
        const id = first.toolCalls![0]!.id;
        if (wire.wire === 'anthropic') {
          assert.deepEqual(body.messages, [
            { role: 'user', content: INPUT },
            { role: 'assistant', content: wire.assistantMessage },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: LISTED }] },
          ], 'tool_result blocks answer the tool_use ids in one user message');
          assert.equal(body.system, TOOL_SYSTEM_PROMPT);
        } else if (wire.wire === 'responses') {
          assert.deepEqual(body.input, [
            { role: 'user', content: INPUT },
            ...(wire.assistantMessage as unknown[]),
            { type: 'function_call_output', call_id: id, output: LISTED },
          ], 'the model\'s function call goes back as it wrote it, without item ids (nothing is stored at OpenAI), then one output per call');
          assert.deepEqual([body.instructions, body.store, body.include], [TOOL_SYSTEM_PROMPT, false, undefined], 'no encrypted reasoning is asked for (#1073)');
          assert.ok(!JSON.stringify(body.input).includes('rs_67ccd2bf17f0') && !JSON.stringify(body.input).includes('fc_12345xyz'), 'no reasoning item and no item id go back');
        } else {
          assert.deepEqual(body.messages, [
            { role: 'system', content: TOOL_SYSTEM_PROMPT },
            { role: 'user', content: INPUT },
            { ...(wire.assistantMessage as object), role: 'assistant' },
            { role: 'tool', tool_call_id: id, content: LISTED },
          ]);
        }
      });

      test('a run\'s last request offers the tools but none to call, and Flux\'s words follow the results (#1410)', async () => {
        script = [{ body: wire.toolCalls }, { body: wire.final }];
        const adapter = compute();
        const first = await adapter.dispatch(requestFor(wire), live);
        if (first.kind !== 'completed') return assert.fail('the first turn completes');
        const turn: PersonalTurn = { text: first.text, calls: first.toolCalls!, results: [{ callId: first.toolCalls![0]!.id, content: LISTED, isError: false }], replay: first.replay };
        const NOTE = 'Flux: answer now from what you found.';
        await adapter.dispatch(requestFor(wire, { turns: [turn], answerNow: NOTE }), live);
        const body = seen[1]!.body;
        assert.deepEqual(body.tools, toolsOnWire(wire.wire), 'the tools stay: the earlier calls need them');
        const id = first.toolCalls![0]!.id;
        if (wire.wire === 'anthropic') {
          assert.deepEqual(body.tool_choice, { type: 'none' });
          assert.deepEqual(body.messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: LISTED }, { type: 'text', text: NOTE }] });
        } else if (wire.wire === 'responses') {
          assert.equal(body.tool_choice, 'none');
          assert.deepEqual(body.input!.slice(-2), [{ type: 'function_call_output', call_id: id, output: LISTED }, { role: 'user', content: NOTE }]);
        } else {
          assert.equal(body.tool_choice, 'none');
          assert.deepEqual(body.messages.slice(-2), [{ role: 'tool', tool_call_id: id, content: LISTED }, { role: 'user', content: NOTE }]);
        }
      });

      test('a refused or failed tool call goes back as an error result in this wire format', async () => {
        script = [{ body: wire.toolCalls }, { body: wire.final }];
        const adapter = compute();
        const first = await adapter.dispatch(requestFor(wire), live);
        if (first.kind !== 'completed') throw new Error('expected a completed request');
        const id = first.toolCalls![0]!.id;
        await adapter.dispatch(requestFor(wire, { turns: [{ text: '', calls: first.toolCalls!, replay: first.replay, results: [{ callId: id, content: 'Refused: the Wiki switch is off.', isError: true }] }] }), live);
        const last = wire.wire === 'responses' ? seen[1]!.body.input!.at(-1) : seen[1]!.body.messages.at(-1);
        if (wire.wire === 'anthropic') assert.deepEqual(last, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Refused: the Wiki switch is off.', is_error: true }] });
        else if (wire.wire === 'responses') assert.deepEqual(last, { type: 'function_call_output', call_id: id, output: 'Error: Refused: the Wiki switch is off.' });
        else assert.deepEqual(last, { role: 'tool', tool_call_id: id, content: 'Error: Refused: the Wiki switch is off.' });
      });

      test('without tools the request has no tools on the wire, and a stray tool call in the answer is not a call (the no-tools shape)', async () => {
        script = [{ body: wire.toolCalls }];
        const result = await compute().dispatch(requestFor(wire, { tools: undefined, system: 'Plain brief' }), live);
        const body = seen[0]!.body;
        for (const field of ['tools', 'tool_choice', 'include', 'max_tool_calls']) assert.equal(field in body, false, `no ${field}`);
        assert.equal(result.kind, 'completed');
        if (result.kind !== 'completed') return;
        assert.equal(result.toolCalls, undefined, 'a model that was offered nothing cannot act');
        assert.notEqual(result.stopReason, 'tool_use');
        assert.equal(result.replay, undefined);
        const empty = requestFor(wire, { tools: [], system: 'Plain brief' });
        script = [{ body: wire.final }];
        await compute().dispatch(empty, live);
        assert.equal('tools' in seen[1]!.body, false, 'an empty list is not sent either');
      });
    });
  }

  describe('rules of the wire formats', () => {
    test('Anthropic: a thinking block is sent back with its signature unchanged; without a replay the message is rebuilt', async () => {
      script = [{ body: ANTHROPIC_TOOL_USE_WITH_THINKING }, { body: ANTHROPIC_FINAL }, { body: ANTHROPIC_FINAL }];
      const adapter = compute();
      const first = await adapter.dispatch(requestFor(anthropic), live);
      if (first.kind !== 'completed') throw new Error('expected a completed request');
      assert.deepEqual(first.replay, ANTHROPIC_TOOL_USE_WITH_THINKING.content);
      const results = [{ callId: first.toolCalls![0]!.id, content: LISTED, isError: false }];
      await adapter.dispatch(requestFor(anthropic, { turns: [{ text: first.text, calls: first.toolCalls!, results, replay: first.replay }] }), live);
      assert.deepEqual(seen[1]!.body.messages[1], { role: 'assistant', content: ANTHROPIC_TOOL_USE_WITH_THINKING.content });
      await adapter.dispatch(requestFor(anthropic, { turns: [{ text: "I'll look at the open work first.", calls: first.toolCalls!, results }] }), live);
      assert.deepEqual(seen[2]!.body.messages[1], { role: 'assistant', content: [
        { type: 'text', text: "I'll look at the open work first." },
        { type: 'tool_use', id: 'toolu_01A09q90qw90lq917835lq9', name: 'flux_list_work', input: { projectId: PROJECT_ID } },
      ] });
    });

    test('Responses: without a replay the turn is rebuilt as function_call items with JSON-string arguments (#954)', async () => {
      script = [{ body: RESPONSES_FINAL }];
      const call = { id: 'call_1', name: 'flux_list_work', input: { projectId: PROJECT_ID } };
      await compute().dispatch(requestFor(openai, { turns: [{ text: 'Looking.', calls: [call], results: [{ callId: 'call_1', content: LISTED, isError: false }] }] }), live);
      assert.deepEqual(seen[0]!.body.input!.slice(1), [
        { role: 'assistant', content: 'Looking.' },
        { type: 'function_call', call_id: 'call_1', name: 'flux_list_work', arguments: JSON.stringify({ projectId: PROJECT_ID }) },
        { type: 'function_call_output', call_id: 'call_1', output: LISTED },
      ]);
    });

    test('Responses: a cut-off answer, a refusal and a repeated call id are never calls (#954)', async () => {
      const cut = { ...RESPONSES_TOOL_CALLS, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
      const refusal = { ...RESPONSES_FINAL, output: [{ id: 'msg_r', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }] };
      const repeated = { ...RESPONSES_TOOL_CALLS, output: [RESPONSES_TOOL_CALLS.output[1], RESPONSES_TOOL_CALLS.output[1]] };
      script = [{ body: cut }, { body: refusal }, { body: repeated }];
      const one = await compute().dispatch(requestFor(openai), live);
      assert.deepEqual(one.kind === 'completed' && [one.stopReason, one.toolCalls], ['max_tokens', undefined]);
      const two = await compute().dispatch(requestFor(openai), live);
      assert.deepEqual(two.kind === 'completed' && [two.stopReason, two.text, two.toolCalls], ['refusal', '', undefined]);
      assert.deepEqual(await compute().dispatch(requestFor(openai), live), { kind: 'failed', reason: 'provider_error', billed: 'unknown' });
    });

    test('Chat: without a replay the assistant message is rebuilt with JSON-string arguments', async () => {
      script = [{ body: CHAT_FINAL }];
      const call = { id: 'call_1', name: 'flux_list_work', input: { projectId: PROJECT_ID } };
      await compute().dispatch(requestFor(chat, { turns: [{ text: '', calls: [call], results: [{ callId: 'call_1', content: LISTED, isError: false }] }] }), live);
      assert.deepEqual(seen[0]!.body.messages.slice(2), [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'flux_list_work', arguments: JSON.stringify({ projectId: PROJECT_ID }) } }] },
        { role: 'tool', tool_call_id: 'call_1', content: LISTED },
      ]);
    });

    test('Chat: several calls come back in order, arguments that are not a JSON object are marked invalid, and every call gets one result in call order', async () => {
      script = [{ body: CHAT_TWO_CALLS }, { body: CHAT_FINAL }];
      const adapter = compute();
      const first = await adapter.dispatch(requestFor(chat), live);
      if (first.kind !== 'completed') throw new Error('expected a completed request');
      assert.deepEqual(first.toolCalls, [
        { id: 'call_a', name: 'flux_list_work', input: { projectId: PROJECT_ID } },
        { id: 'call_b', name: 'flux_list_work', input: {}, invalid: true },
      ]);
      // The results are given out of order on purpose: the wire carries them in the order of the calls.
      const results = [{ callId: 'call_b', content: 'The arguments were not a JSON object. Nothing was run.', isError: true }, { callId: 'call_a', content: LISTED, isError: false }];
      await adapter.dispatch(requestFor(chat, { turns: [{ text: first.text, calls: first.toolCalls!, results, replay: first.replay }] }), live);
      const messages = seen[1]!.body.messages;
      assert.deepEqual(messages.slice(3).map((message) => [message.role, message.tool_call_id]), [['tool', 'call_a'], ['tool', 'call_b']]);
      assert.equal(messages[2]!.tool_calls![1]!.function.arguments, '{"projectId": ', 'the model\'s own message is sent back as it was');
    });

    test('an answer cut off inside a tool call is truncated text, never a call, on both formats', async () => {
      script = [{ body: ANTHROPIC_TOOL_USE_TRUNCATED }, { body: CHAT_TOOL_CALLS_TRUNCATED }];
      const cut = await compute().dispatch(requestFor(anthropic), live);
      assert.equal(cut.kind === 'completed' && cut.stopReason, 'max_tokens');
      assert.equal(cut.kind === 'completed' && cut.toolCalls, undefined);
      const length = await compute().dispatch(requestFor(chat), live);
      assert.equal(length.kind === 'completed' && length.stopReason, 'max_tokens');
      assert.equal(length.kind === 'completed' && length.toolCalls, undefined);
    });

    test('a tool call without an id or name is a malformed answer: the request failed, its charge is unknown', async () => {
      const broken = { ...CHAT_TOOL_CALLS, choices: [{ ...CHAT_TOOL_CALLS.choices[0]!, message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { arguments: '{}' } }] } }] };
      script = [{ body: broken }, { body: { ...ANTHROPIC_TOOL_USE, content: [{ type: 'tool_use', name: 'flux_list_work', input: {} }] } }];
      assert.deepEqual(await compute().dispatch(requestFor(chat), live), { kind: 'failed', reason: 'provider_error', billed: 'unknown' });
      assert.deepEqual(await compute().dispatch(requestFor(anthropic), live), { kind: 'failed', reason: 'provider_error', billed: 'unknown' });
    });

    test('Anthropic: several calls with their own ids come back in order and are answered in that order', async () => {
      script = [{ body: ANTHROPIC_TWO_CALLS }, { body: ANTHROPIC_FINAL }];
      const adapter = compute();
      const first = await adapter.dispatch(requestFor(anthropic), live);
      if (first.kind !== 'completed') throw new Error('expected a completed request');
      assert.deepEqual(first.toolCalls?.map((call) => call.id), ['toolu_01first', 'toolu_02second']);
      const results = [{ callId: 'toolu_02second', content: 'renamed', isError: false }, { callId: 'toolu_01first', content: LISTED, isError: false }];
      await adapter.dispatch(requestFor(anthropic, { turns: [{ text: '', calls: first.toolCalls!, results, replay: first.replay }] }), live);
      assert.deepEqual((seen[1]!.body.messages[2]!.content as { tool_use_id: string }[]).map((block) => block.tool_use_id), ['toolu_01first', 'toolu_02second']);
    });

    test('Anthropic: two tool_use blocks with one id are a malformed answer, refused before any call is returned (as Chat Completions refuses them)', async () => {
      script = [{ body: ANTHROPIC_DUPLICATE_IDS }];
      assert.deepEqual(await compute().dispatch(requestFor(anthropic), live), { kind: 'failed', reason: 'provider_error', billed: 'unknown' });
    });

    test('Anthropic: the token count carries the tools and the earlier turns, so the preflight bound is not understated', async () => {
      script = [{ body: ANTHROPIC_TOOL_USE }, { body: { input_tokens: 2_222 } }];
      const adapter = compute();
      const first = await adapter.dispatch(requestFor(anthropic), live);
      if (first.kind !== 'completed') throw new Error('expected a completed request');
      const turn = { text: first.text, calls: first.toolCalls!, results: [{ callId: first.toolCalls![0]!.id, content: LISTED, isError: false }], replay: first.replay };
      assert.equal(await adapter.countInputTokens!(requestFor(anthropic, { turns: [turn] })), 2_222);
      assert.equal(seen[1]!.path, '/v1/messages/count_tokens');
      assert.deepEqual(seen[1]!.body.tools, toolsOnWire('anthropic'));
      assert.equal(seen[1]!.body.messages.length, 3);
      assert.equal((seen[1]!.body.messages[2]!.content as { type: string }[])[0]!.type, 'tool_result');
    });
  });

  describe('what is refused before a key is even resolved', () => {
    const turnOf = (callIds: string[], resultIds: string[]): PersonalTurn => ({
      text: '', calls: callIds.map((id) => ({ id, name: 'flux_list_work', input: {} })), results: resultIds.map((callId) => ({ callId, content: 'x', isError: false })),
    });
    const refused: [string, Partial<PersonalComputeRequest>][] = [
      ['a tool name outside the shared pattern', { tools: [{ ...FLUX_TOOLS[0]!, name: 'flux list work' }] }],
      ['a repeated tool name', { tools: [FLUX_TOOLS[0]!, FLUX_TOOLS[0]!] }],
      ['a tool schema that is not an object schema', { tools: [{ ...FLUX_TOOLS[0]!, inputSchema: { type: 'string' } }] }],
      ['more tools than the bound', { tools: Array.from({ length: 65 }, (_, index) => ({ ...FLUX_TOOLS[0]!, name: `tool_${index}` })) }],
      ['a turn whose call has no result', { turns: [turnOf(['a', 'b'], ['a'])] }],
      ['a turn with a result for a call it did not make', { turns: [turnOf(['a'], ['a', 'z'])] }],
      ['a turn that repeats a call id', { turns: [turnOf(['a', 'a'], ['a', 'a'])] }],
      ['earlier turns without tools', { tools: undefined, turns: [turnOf(['a'], ['a'])] }],
      ['more earlier turns than the turn cap allows', { turns: Array.from({ length: PERSONAL_RUN_LIMITS.maxTurns }, (_, index) => turnOf([`c${index}`], [`c${index}`])) }],
    ];
    for (const [name, overrides] of refused) {
      for (const wire of [anthropic, openai]) {
        test(`${wire.name}: ${name}`, async () => {
          assert.deepEqual(await compute().dispatch(requestFor(wire, overrides), live), { kind: 'failed', reason: 'provider_error', billed: 'none' }, 'never sent, so free');
          if (wire.wire === 'anthropic') await assert.rejects(compute().countInputTokens!(requestFor(wire, overrides)));
          assert.equal(seen.length, 0, 'no request reached the provider');
          assert.deepEqual(resolved, [], 'no key was resolved');
        });
      }
    }

    test('OpenAI GPT-6 Astra, which needs the Responses API for tool calling, calls tools now that Flux speaks it (#954)', async () => {
      const astra = { provider: 'openai' as const, model: 'gpt-6-astra' };
      script = [{ body: RESPONSES_TOOL_CALLS }];
      const result = await compute().dispatch(requestFor(astra), live);
      assert.deepEqual(result.kind === 'completed' && [result.stopReason, result.toolCalls?.map((call) => call.name)], ['tool_use', ['flux_list_work']]);
      assert.equal(seen[0]!.path, '/v1/responses');
    });

    test('web search is never offered to a provider without one, and such a request is never sent and costs nothing (#954, #1441)', async () => {
      // A search alone is `flux_web_search`'s request (#1441, web-search.test.ts and key-search-adapters.test.ts): allowed where the provider has one.
      assert.deepEqual(await compute().dispatch(requestFor(chat, { webSearch: true }), live), { kind: 'failed', reason: 'provider_error', billed: 'none' });
      assert.equal(seen.length, 0, 'nothing was sent');
    });
  });
});
