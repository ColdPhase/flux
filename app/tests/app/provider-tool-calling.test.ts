import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PERSONAL_RUN_LIMITS } from '@flux/contracts';
import { TOOL_SYSTEM_PROMPT, type PersonalCompute, type PersonalComputeRequest, type PersonalTurn } from '@flux/core';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import {
  ANTHROPIC_FINAL, ANTHROPIC_TOOL_USE, ANTHROPIC_TOOL_USE_TRUNCATED, ANTHROPIC_TOOL_USE_WITH_THINKING, CHAT_FINAL, CHAT_TOOL_CALLS,
  CHAT_TOOL_CALLS_TRUNCATED, CHAT_TWO_CALLS, FLUX_TOOLS, PROJECT_ID, TOOL_WIRE_CASES, type ToolWireCase,
} from './support/provider-tool-fixtures.js';

// Tool calling in each provider adapter (F-027 AST-8.1, issue #406): the Flux tools written in each
// wire format, the tool calls read back, and the results sent in the next request. Every test runs
// against a LOCAL MOCK HTTP server in this process that answers with the documented-shape fixtures
// of `support/provider-tool-fixtures.ts`. No real provider is called and no key exists: the "key"
// is a fixed test string. These tests prove what the adapters send and how they map answers; they
// are not a provider, billing or compatibility pass. The loopback mock is reached only because this
// suite's endpoint policy allows 127.0.0.1.

const KEY = 'test-only-not-a-key-tool-7f3a';
const KEY_REF = 'key-ref-of-owner';
const INPUT = 'Task: Answer the request.\nRequest: What is open?\n\nSources:\n[S1] Message 1 by Kai: Camera fails below 5 lux';

interface WireMessage { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { function: { arguments: string } }[] }
interface Body { tools?: unknown; messages: WireMessage[]; system?: unknown; model?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown; [field: string]: unknown }
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
const openai = TOOL_WIRE_CASES[1]!;

/** The tool definitions as each wire format must carry them. */
const toolsOnWire = (wire: ToolWireCase['wire']) => wire === 'anthropic'
  ? FLUX_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
  : FLUX_TOOLS.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));

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
        assert.equal(sent!.path, wire.wire === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
        assert.equal(sent!.headers[wire.wire === 'anthropic' ? 'x-api-key' : 'authorization'], wire.wire === 'anthropic' ? KEY : `Bearer ${KEY}`);
        assert.deepEqual(sent!.body.tools, toolsOnWire(wire.wire));
        assert.equal(sent!.body.tool_choice, undefined, 'the model chooses (auto); a forced choice is refused by some current models');
        for (const hosted of ['web_search_options', 'plugins', 'stream']) assert.equal(sent!.body[hosted], undefined, `no ${hosted}`);
        assert.equal(sent!.body.model, wire.model);
        assert.equal(sent!.body.max_tokens ?? sent!.body.max_completion_tokens, 1_500);
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
        } else {
          assert.deepEqual(body.messages, [
            { role: 'system', content: TOOL_SYSTEM_PROMPT },
            { role: 'user', content: INPUT },
            { ...(wire.assistantMessage as object), role: 'assistant' },
            { role: 'tool', tool_call_id: id, content: LISTED },
          ]);
        }
      });

      test('a refused or failed tool call goes back as an error result in this wire format', async () => {
        script = [{ body: wire.toolCalls }, { body: wire.final }];
        const adapter = compute();
        const first = await adapter.dispatch(requestFor(wire), live);
        if (first.kind !== 'completed') throw new Error('expected a completed request');
        const id = first.toolCalls![0]!.id;
        await adapter.dispatch(requestFor(wire, { turns: [{ text: '', calls: first.toolCalls!, replay: first.replay, results: [{ callId: id, content: 'Refused: the Wiki switch is off.', isError: true }] }] }), live);
        const last = seen[1]!.body.messages.at(-1);
        if (wire.wire === 'anthropic') assert.deepEqual(last, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Refused: the Wiki switch is off.', is_error: true }] });
        else assert.deepEqual(last, { role: 'tool', tool_call_id: id, content: 'Error: Refused: the Wiki switch is off.' });
      });

      test('without tools the request has no tools on the wire, and a stray tool call in the answer is not a call (the no-tools shape)', async () => {
        script = [{ body: wire.toolCalls }];
        const result = await compute().dispatch(requestFor(wire, { tools: undefined, system: 'Plain brief' }), live);
        const body = seen[0]!.body;
        for (const field of ['tools', 'tool_choice']) assert.equal(field in body, false, `no ${field}`);
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

    test('Chat: without a replay the assistant message is rebuilt with JSON-string arguments', async () => {
      script = [{ body: CHAT_FINAL }];
      const call = { id: 'call_1', name: 'flux_list_work', input: { projectId: PROJECT_ID } };
      await compute().dispatch(requestFor(openai, { turns: [{ text: '', calls: [call], results: [{ callId: 'call_1', content: LISTED, isError: false }] }] }), live);
      assert.deepEqual(seen[0]!.body.messages.slice(2), [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'flux_list_work', arguments: JSON.stringify({ projectId: PROJECT_ID }) } }] },
        { role: 'tool', tool_call_id: 'call_1', content: LISTED },
      ]);
    });

    test('Chat: several calls come back in order, arguments that are not a JSON object are marked invalid, and every call gets one result in call order', async () => {
      script = [{ body: CHAT_TWO_CALLS }, { body: CHAT_FINAL }];
      const adapter = compute();
      const first = await adapter.dispatch(requestFor(openai), live);
      if (first.kind !== 'completed') throw new Error('expected a completed request');
      assert.deepEqual(first.toolCalls, [
        { id: 'call_a', name: 'flux_list_work', input: { projectId: PROJECT_ID } },
        { id: 'call_b', name: 'flux_list_work', input: {}, invalid: true },
      ]);
      // The results are given out of order on purpose: the wire carries them in the order of the calls.
      const results = [{ callId: 'call_b', content: 'The arguments were not a JSON object. Nothing was run.', isError: true }, { callId: 'call_a', content: LISTED, isError: false }];
      await adapter.dispatch(requestFor(openai, { turns: [{ text: first.text, calls: first.toolCalls!, results, replay: first.replay }] }), live);
      const messages = seen[1]!.body.messages;
      assert.deepEqual(messages.slice(3).map((message) => [message.role, message.tool_call_id]), [['tool', 'call_a'], ['tool', 'call_b']]);
      assert.equal(messages[2]!.tool_calls![1]!.function.arguments, '{"projectId": ', 'the model\'s own message is sent back as it was');
    });

    test('an answer cut off inside a tool call is truncated text, never a call, on both formats', async () => {
      script = [{ body: ANTHROPIC_TOOL_USE_TRUNCATED }, { body: CHAT_TOOL_CALLS_TRUNCATED }];
      const cut = await compute().dispatch(requestFor(anthropic), live);
      assert.equal(cut.kind === 'completed' && cut.stopReason, 'max_tokens');
      assert.equal(cut.kind === 'completed' && cut.toolCalls, undefined);
      const length = await compute().dispatch(requestFor(openai), live);
      assert.equal(length.kind === 'completed' && length.stopReason, 'max_tokens');
      assert.equal(length.kind === 'completed' && length.toolCalls, undefined);
    });

    test('a tool call without an id or name is a malformed answer: the request failed, its charge is unknown', async () => {
      const broken = { ...CHAT_TOOL_CALLS, choices: [{ ...CHAT_TOOL_CALLS.choices[0]!, message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { arguments: '{}' } }] } }] };
      script = [{ body: broken }, { body: { ...ANTHROPIC_TOOL_USE, content: [{ type: 'tool_use', name: 'flux_list_work', input: {} }] } }];
      assert.deepEqual(await compute().dispatch(requestFor(openai), live), { kind: 'failed', reason: 'provider_error', billed: 'unknown' });
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
          await assert.rejects(compute().dispatch(requestFor(wire, overrides), live));
          if (wire.wire === 'anthropic') await assert.rejects(compute().countInputTokens!(requestFor(wire, overrides)));
          assert.equal(seen.length, 0, 'no request reached the provider');
          assert.deepEqual(resolved, [], 'no key was resolved');
        });
      }
    }

    test('a model Flux knows cannot call tools on its wire format is never offered any (OpenAI GPT-6 Astra needs the Responses API)', async () => {
      const astra = { provider: 'openai' as const, model: 'gpt-6-astra' };
      await assert.rejects(compute().dispatch(requestFor(astra), live), /cannot call tools/);
      assert.equal(seen.length, 0);
      // The same model answers in one request with no tools.
      script = [{ body: CHAT_FINAL }];
      assert.equal((await compute().dispatch(requestFor(astra, { tools: undefined }), live)).kind, 'completed');
      assert.equal('tools' in seen[0]!.body, false);
    });
  });
});
