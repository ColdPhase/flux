import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { AI_PROVIDER_KINDS, maxRequestMicros } from '@flux/contracts';
import { admitGatewayRequest, gatewayChargeMicros, gatewayHoldMicros, usageMeter, type GatewayRequestFacts, type GatewayUsage } from '@flux/core';
import {
  MODEL_GATEWAY_BASE_PATHS, MODEL_GATEWAY_LIMITS, MODEL_GATEWAY_PROVIDERS, modelGatewayBaseUrl, modelGatewayToken, parseModelGatewayUrl, RUNTIME_PORTS,
} from '@flux/runtime-protocol';
import { createModelForwarder } from '../../apps/runtime/src/egress/model.js';

// #1441: the model gateway's pure parts. The interface both sides parse (routes and tokens), what a request may ask, the usage each
// provider reports (whole and streamed, cache fields, malformed and missing), what a request holds and is charged, and runtime-egress's
// model forwarder, which passes only the providers' model paths on with a fixed set of headers. Loopback only, no database.

const TOKEN = `flux_mg_${'a'.repeat(43)}`;
const limits = MODEL_GATEWAY_LIMITS;
const price = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const facts = (provider: GatewayRequestFacts['provider'], operation: GatewayRequestFacts['operation'], pathModel: string | null = null, pathStream: boolean | null = null): GatewayRequestFacts =>
  ({ provider, operation, pathModel, pathStream });
const sse = (...events: unknown[]) => events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');

/** Feeds an answer to a meter in pieces of `size` bytes, so lines and characters are split across chunks. */
function meter(operation: GatewayRequestFacts['operation'], provider: GatewayRequestFacts['provider'], stream: boolean, body: string, size = 7): GatewayUsage | null {
  const reading = usageMeter(operation, provider, stream, 1024 * 1024);
  const bytes = Buffer.from(body);
  for (let at = 0; at < bytes.length; at += size) reading.push(bytes.subarray(at, at + size));
  return reading.end();
}

describe('the interface', () => {
  test('the providers are Connect AI\'s, each with its base URL on runtime-egress\'s model port', () => {
    assert.deepEqual([...MODEL_GATEWAY_PROVIDERS], [...AI_PROVIDER_KINDS]);
    assert.equal(RUNTIME_PORTS.egressModel, 8081);
    assert.equal(modelGatewayBaseUrl('anthropic'), 'http://runtime-egress:8081/anthropic');
    assert.equal(modelGatewayBaseUrl('openai'), 'http://runtime-egress:8081/openai/v1');
    assert.equal(modelGatewayBaseUrl('openrouter'), 'http://runtime-egress:8081/openrouter/api/v1');
    assert.equal(modelGatewayBaseUrl('gemini'), 'http://runtime-egress:8081/gemini');
    assert.equal(modelGatewayBaseUrl('openai_compatible'), 'http://runtime-egress:8081/openai_compatible');
    // A client adds its usual path to the base URL, and that is a route.
    for (const [provider, suffix] of [['anthropic', '/v1/messages'], ['openai', '/chat/completions'], ['openai', '/responses'], ['openrouter', '/chat/completions'],
      ['gemini', '/v1beta/models/gemini-3-flash:generateContent'], ['gemini', '/v1beta/openai/chat/completions'], ['openai_compatible', '/chat/completions']] as const) {
      assert.ok(parseModelGatewayUrl(`${MODEL_GATEWAY_BASE_PATHS[provider]}${suffix}`), `${provider}${suffix}`);
    }
  });

  test('routes: exact paths of the run\'s provider only; Gemini streams as server-sent events', () => {
    assert.deepEqual(parseModelGatewayUrl('/anthropic/v1/messages'), { provider: 'anthropic', operation: 'anthropic_messages', path: '/v1/messages', model: null, stream: null });
    assert.deepEqual(parseModelGatewayUrl('/openai/v1/responses'), { provider: 'openai', operation: 'openai_responses', path: '/v1/responses', model: null, stream: null });
    assert.deepEqual(parseModelGatewayUrl('/gemini/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse'),
      { provider: 'gemini', operation: 'gemini_generate', path: '/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse', model: 'gemini-3-flash', stream: true });
    for (const bad of ['/anthropic/v1/messages/count_tokens', '/anthropic/v1/messages?key=x', '/anthropic/v1/complete', '/anthropic/v1/files', '/openai/v1/models',
      '/openai/v1/embeddings', '/openai/v1/responses/abc', '/openai/v1/audio/speech', '/openai//v1/responses', '/openai/v1/../v1/responses', '/anthropic/v1/messages/',
      '/gemini/v1beta/models/gemini-3-flash:streamGenerateContent', '/gemini/v1beta/models/gemini-3-flash:generateContent?alt=sse',
      '/gemini/v1beta/models/gemini-3-flash:countTokens', '/gemini/v1beta/files', '/gemini/v1beta/cachedContents', '/gemini/v1beta/models/../x:generateContent',
      '/openai_compatible/v1/chat/completions', '/openai_compatible/models', '/mcp', '/', '', '/ANTHROPIC/v1/messages', '/anthropic/v1/messages%2f',
      'http://evil/anthropic/v1/messages', '/other/v1/messages', `/anthropic/${'a/'.repeat(200)}`, null, 7]) {
      assert.equal(parseModelGatewayUrl(bad), null, String(bad));
    }
  });

  test('tokens come in the header the provider\'s own client puts its key in; two different ones are refused', () => {
    assert.equal(modelGatewayToken({ authorization: `Bearer ${TOKEN}` }), TOKEN);
    assert.equal(modelGatewayToken({ 'x-api-key': TOKEN }), TOKEN);
    assert.equal(modelGatewayToken({ 'x-goog-api-key': TOKEN }), TOKEN);
    assert.equal(modelGatewayToken({ 'x-api-key': TOKEN, authorization: `bearer ${TOKEN}` }), TOKEN);
    assert.equal(modelGatewayToken({}), null);
    const other = `flux_mg_${'b'.repeat(43)}`;
    for (const headers of [{ 'x-api-key': TOKEN, authorization: `Bearer ${other}` }, { authorization: TOKEN }, { 'x-api-key': 'sk-ant-real-key' },
      { 'x-api-key': `${TOKEN}x` }, { authorization: `Basic ${TOKEN}` }, { 'x-api-key': [TOKEN, TOKEN] }]) {
      assert.equal(modelGatewayToken(headers as IncomingHttpHeaders), 'invalid', JSON.stringify(headers));
    }
  });
});

describe('what a request may ask', () => {
  const runModel = 'claude-sonnet-5';
  const anthropic = facts('anthropic', 'anthropic_messages');

  test('the run\'s model only, with the output bound set to at most the limit', () => {
    const admitted = admitGatewayRequest(anthropic, json({ model: runModel, max_tokens: 64_000, messages: [{ role: 'user', content: 'hi' }] }), runModel, limits);
    assert.ok(admitted.ok);
    assert.equal(JSON.parse(admitted.request.body.toString()).max_tokens, 32_000);
    assert.equal(admitted.request.maxOutputTokens, 32_000);
    assert.equal(admitted.request.stream, false);
    assert.equal(admitted.request.cacheAsked, false);
    assert.ok(admitted.request.inputBoundTokens >= admitted.request.body.length + limits.inputAllowanceTokens);
    const other = admitGatewayRequest(anthropic, json({ model: 'claude-opus-5', max_tokens: 10, messages: [] }), runModel, limits);
    assert.deepEqual(other, { ok: false, message: 'This run uses the model claude-sonnet-5' });
    for (const bad of ['not json', '[1]', 'null']) assert.equal(admitGatewayRequest(anthropic, Buffer.from(bad), runModel, limits).ok, false, bad);
    assert.equal(admitGatewayRequest(anthropic, json({ model: runModel, max_tokens: 0, messages: [] }), runModel, limits).ok, false);
    assert.equal(admitGatewayRequest(anthropic, json({ model: runModel, max_tokens: 1.5, messages: [] }), runModel, limits).ok, false);
  });

  test('a request that marks the cache asks for it; pictures widen the input bound', () => {
    const body = { model: runModel, max_tokens: 100, system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what?' }] }] };
    const admitted = admitGatewayRequest(anthropic, json(body), runModel, limits);
    assert.ok(admitted.ok);
    assert.equal(admitted.request.cacheAsked, true);
    assert.equal(admitted.request.inputBoundTokens, admitted.request.body.length + limits.inputAllowanceTokens + limits.pictureTokens);
  });

  test('hosted tools, server-side state, URLs, files and several answers are refused', () => {
    const refused: [GatewayRequestFacts, Record<string, unknown>][] = [
      [anthropic, { model: runModel, max_tokens: 10, messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }],
      [anthropic, { model: runModel, max_tokens: 10, messages: [], tools: [{ type: 'code_execution_20250825', name: 'code' }] }],
      [anthropic, { model: runModel, max_tokens: 10, messages: [], mcp_servers: [{ url: 'https://x' }] }],
      [anthropic, { model: runModel, max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }] }],
      [anthropic, { model: runModel, max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'f' } }] }] }],
      [anthropic, { model: runModel, max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } }] }] }],
      [facts('openai', 'openai_chat'), { model: runModel, messages: [], n: 2 }],
      [facts('openai', 'openai_chat'), { model: runModel, messages: [], web_search_options: {} }],
      [facts('openai', 'openai_chat'), { model: runModel, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] }],
      [facts('openrouter', 'openai_chat'), { model: runModel, messages: [], plugins: [{ id: 'web' }] }],
      [facts('openai', 'openai_responses'), { model: runModel, input: 'x', tools: [{ type: 'web_search' }] }],
      [facts('openai', 'openai_responses'), { model: runModel, input: 'x', tools: [{ type: 'mcp', server_url: 'https://x' }] }],
      [facts('openai', 'openai_responses'), { model: runModel, input: 'x', previous_response_id: 'resp_1' }],
      [facts('openai', 'openai_responses'), { model: runModel, input: 'x', background: true }],
      [facts('openai', 'openai_responses'), { model: runModel, input: 'x', conversation: 'conv_1' }],
      [facts('openai', 'openai_responses'), { model: runModel, input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }] }],
      [facts('gemini', 'gemini_generate', runModel, false), { contents: [], tools: [{ googleSearch: {} }] }],
      [facts('gemini', 'gemini_generate', runModel, false), { contents: [], cachedContent: 'cachedContents/1' }],
      [facts('gemini', 'gemini_generate', runModel, false), { contents: [{ parts: [{ fileData: { fileUri: 'https://youtube.com/x' } }] }] }],
      [facts('gemini', 'gemini_generate', runModel, false), { contents: [], generationConfig: { candidateCount: 3 } }],
      [facts('gemini', 'gemini_generate', 'gemini-3-pro', false), { contents: [] }],
      // Price and model changers the prices cannot follow (#1441 review).
      [anthropic, { model: runModel, max_tokens: 10, messages: [], speed: 'fast' }],
      [anthropic, { model: runModel, max_tokens: 10, messages: [], inference_geo: 'us' }],
      [anthropic, { model: runModel, max_tokens: 10, messages: [], cache_control: { type: 'ephemeral', ttl: '1h' } }],
      [anthropic, { model: runModel, max_tokens: 10, system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [] }],
      [facts('openai', 'openai_chat'), { model: runModel, messages: [], service_tier: 'priority' }],
      [facts('openai', 'openai_responses'), { model: runModel, input: 'x', service_tier: 'priority' }],
      [facts('openai', 'openai_responses'), { model: runModel, prompt: { id: 'pmpt_1' } }],
      [facts('openai', 'openai_responses'), { model: runModel, input: [{ type: 'item_reference', id: 'msg_1' }] }],
      [facts('openrouter', 'openai_chat'), { model: runModel, messages: [], models: [runModel, 'openai/gpt-5-pro'] }],
      [facts('openrouter', 'openai_chat'), { model: runModel, messages: [], route: 'fallback' }],
      [facts('gemini', 'openai_chat'), { model: runModel, messages: [], extra_body: { google: { cached_content: 'cachedContents/1' } } }],
    ];
    for (const [given, body] of refused) assert.equal(admitGatewayRequest(given, json(body), runModel, limits).ok, false, JSON.stringify(body));
    const functions = admitGatewayRequest(anthropic, json({ model: runModel, max_tokens: 10, messages: [], tools: [{ name: 'flux_read', input_schema: { type: 'object' } }] }), runModel, limits);
    assert.ok(functions.ok, 'the harness\'s own tools go through');
    const fiveMinutes = admitGatewayRequest(anthropic, json({ model: runModel, max_tokens: 10, messages: [], speed: 'standard', inference_geo: 'global',
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '5m' } }] }), runModel, limits);
    assert.ok(fiveMinutes.ok, 'the standard speed, global inference and the 5-minute cache go through');
  });

  test('each wire format\'s output bound and stream; a Chat Completions stream is asked for its usage, OpenRouter for its cost', () => {
    const chat = admitGatewayRequest(facts('openai', 'openai_chat'), json({ model: runModel, messages: [], stream: true }), runModel, limits);
    assert.ok(chat.ok);
    const sentChat = JSON.parse(chat.request.body.toString());
    assert.deepEqual([sentChat.max_completion_tokens, sentChat.stream_options, chat.request.stream], [32_000, { include_usage: true }, true]);
    const legacy = admitGatewayRequest(facts('openai_compatible', 'openai_chat'), json({ model: runModel, messages: [], max_tokens: 500 }), runModel, limits);
    assert.ok(legacy.ok);
    assert.deepEqual([JSON.parse(legacy.request.body.toString()).max_tokens, legacy.request.maxOutputTokens], [500, 500]);
    assert.equal(sentChat.service_tier, 'default', 'OpenAI is asked for its standard tier, whatever the project\'s default');
    const both = admitGatewayRequest(facts('openai_compatible', 'openai_chat'), json({ model: runModel, messages: [], max_tokens: 10, max_completion_tokens: 20_000 }), runModel, limits);
    assert.ok(both.ok);
    assert.equal(both.request.maxOutputTokens, 20_000, 'with both bounds the larger is held: a server may honour either');
    const compatible = admitGatewayRequest(facts('openai_compatible', 'openai_chat'), json({ model: runModel, messages: [] }), runModel, limits);
    assert.ok(compatible.ok);
    assert.equal(JSON.parse(compatible.request.body.toString()).max_tokens, 32_000, 'a compatible server reads max_tokens');
    const router = admitGatewayRequest(facts('openrouter', 'openai_chat'), json({ model: runModel, messages: [] }), runModel, limits);
    assert.ok(router.ok);
    assert.deepEqual(JSON.parse(router.request.body.toString()).usage, { include: true });
    const responses = admitGatewayRequest(facts('openai', 'openai_responses'), json({ model: runModel, input: 'x', stream: true, max_output_tokens: 99_999 }), runModel, limits);
    assert.ok(responses.ok);
    assert.deepEqual([JSON.parse(responses.request.body.toString()).max_output_tokens, responses.request.stream], [32_000, true]);
    const gemini = admitGatewayRequest(facts('gemini', 'gemini_generate', `models/${runModel}`, true), json({ contents: [{ parts: [{ text: 'x' }] }] }), runModel, limits);
    assert.ok(gemini.ok);
    assert.deepEqual([JSON.parse(gemini.request.body.toString()).generationConfig.maxOutputTokens, gemini.request.stream], [32_000, true]);
  });
});

describe('usage as each provider reports it', () => {
  test('Anthropic: whole and streamed, with cache writes and reads', () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 2_000 };
    const expected = { inputTokens: 3_100, outputTokens: 50, cache: { readTokens: 2_000, writeTokens: 1_000 } };
    assert.deepEqual(meter('anthropic_messages', 'anthropic', false, JSON.stringify({ type: 'message', content: [], usage })), expected);
    const stream = `event: message_start\n${sse({ type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } })}`
      + sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'zażółć "usage" gęślą' } }) + `event: ping\n${sse({ type: 'ping' })}`
      + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }) + sse({ type: 'message_stop' });
    assert.deepEqual(meter('anthropic_messages', 'anthropic', true, stream), expected);
    assert.deepEqual(meter('anthropic_messages', 'anthropic', true, stream.replace(/\n/g, '\r\n'), 3), expected, 'CRLF lines, split anywhere');
    // The delta's counts win where it gives them (newer streams repeat the input and cache counts there).
    const restated = stream.replace('"usage":{"output_tokens":50}', '"usage":{"output_tokens":50,"input_tokens":120}');
    assert.equal(meter('anthropic_messages', 'anthropic', true, restated)!.inputTokens, 3_120);
    // A stream that never finished, or reported an error, has no usage.
    assert.equal(meter('anthropic_messages', 'anthropic', true, stream.replace(sse({ type: 'message_stop' }), '')), null);
    assert.equal(meter('anthropic_messages', 'anthropic', true, stream + sse({ type: 'error', error: { type: 'overloaded_error' } })), null);
    assert.equal(meter('anthropic_messages', 'anthropic', false, JSON.stringify({ usage: { input_tokens: -1, output_tokens: 5 } })), null);
    assert.equal(meter('anthropic_messages', 'anthropic', false, JSON.stringify({ usage: { input_tokens: 1, output_tokens: '5' } })), null);
    assert.equal(meter('anthropic_messages', 'anthropic', false, JSON.stringify({ content: [] })), null);
    assert.equal(meter('anthropic_messages', 'anthropic', false, '{"usage": {"input_tok'), null);
  });

  test('Chat Completions: OpenAI, OpenRouter (with its cost), Gemini\'s compatible endpoint and compatible servers', () => {
    assert.deepEqual(meter('openai_chat', 'openai', false, JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } } })),
      { inputTokens: 10, outputTokens: 3 }, 'OpenAI\'s cached input is charged at the full price (#1410)');
    assert.deepEqual(meter('openai_chat', 'openrouter', false, JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.25 } })),
      { inputTokens: 10, outputTokens: 3, reportedCostMicros: 250_000 });
    assert.deepEqual(meter('openai_chat', 'openai_compatible', false, JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 5 } })),
      { inputTokens: 10, outputTokens: 3 }, 'only OpenRouter\'s reported cost counts');
    const stream = sse({ choices: [{ delta: { content: 'a' } }], usage: null }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }, '[DONE]');
    assert.deepEqual(meter('openai_chat', 'gemini', true, stream), { inputTokens: 7, outputTokens: 2 });
    assert.equal(meter('openai_chat', 'openai', true, sse({ choices: [{ delta: { content: 'a' } }] }, '[DONE]')), null, 'a stream without its usage');
    assert.equal(meter('openai_chat', 'openrouter', true, stream.replace('[DONE]', JSON.stringify({ error: { message: 'x' } }))), null);
  });

  test('OpenAI Responses: whole and streamed; a failed response has none', () => {
    assert.deepEqual(meter('openai_responses', 'openai', false, JSON.stringify({ status: 'completed', output: [], usage: { input_tokens: 40, output_tokens: 9 } })),
      { inputTokens: 40, outputTokens: 9 });
    assert.equal(meter('openai_responses', 'openai', false, JSON.stringify({ status: 'failed', usage: { input_tokens: 40, output_tokens: 9 } })), null);
    const stream = `event: response.created\n${sse({ type: 'response.created', response: { usage: null } })}${sse({ type: 'response.output_text.delta', delta: 'hi' })}`
      + `event: response.completed\n${sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 9 } } })}`;
    assert.deepEqual(meter('openai_responses', 'openai', true, stream), { inputTokens: 40, outputTokens: 9 });
    assert.deepEqual(meter('openai_responses', 'openai', true, stream.replace(/response\.completed/g, 'response.incomplete')), { inputTokens: 40, outputTokens: 9 });
    assert.equal(meter('openai_responses', 'openai', true, stream.replace(/response\.completed/g, 'response.failed')), null);
  });

  test('Gemini: the last running totals, with thoughts as output and tool prompts as input', () => {
    const usage = { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 4, toolUsePromptTokenCount: 2, cachedContentTokenCount: 10 };
    assert.deepEqual(meter('gemini_generate', 'gemini', false, JSON.stringify({ candidates: [], usageMetadata: usage })), { inputTokens: 32, outputTokens: 9 });
    const stream = sse({ candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 30 } },
      { candidates: [{ content: { parts: [{ text: 'b' }] } }], usageMetadata: usage });
    assert.deepEqual(meter('gemini_generate', 'gemini', true, stream), { inputTokens: 32, outputTokens: 9 });
    assert.deepEqual(meter('gemini_generate', 'gemini', false, JSON.stringify({ usageMetadata: { promptTokenCount: 3 } })), { inputTokens: 3, outputTokens: 0 });
    assert.equal(meter('gemini_generate', 'gemini', false, JSON.stringify({ usageMetadata: { candidatesTokenCount: 3 } })), null);
    assert.equal(meter('gemini_generate', 'gemini', true, sse({ candidates: [] })), null);
  });

  test('a whole answer past the meter\'s bound, or one event line past its bound, has no usage', () => {
    const small = usageMeter('openai_chat', 'openai', false, 10);
    small.push(Buffer.from(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    assert.equal(small.end(), null);
    const lines = usageMeter('openai_chat', 'openai', true, 10);
    lines.push(Buffer.from(`data: ${'x'.repeat(9 * 1024 * 1024)}`));
    lines.push(Buffer.from(`\n\n${sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`));
    assert.equal(lines.end(), null);
  });
});

describe('what a request holds and is charged', () => {
  const request = { inputBoundTokens: 10_000, maxOutputTokens: 1_000, cacheAsked: true };

  test('the hold is the input bound at the cache-write rate where the provider has one, and the output bound', () => {
    assert.equal(gatewayHoldMicros(price, 'anthropic', request), maxRequestMicros(price, 12_500, 1_000));
    assert.equal(gatewayHoldMicros(price, 'openai', request), maxRequestMicros(price, 10_000, 1_000));
  });

  test('cache reads at their rate only when asked (#1410, #1426); writes at theirs; counts that cannot be right count twice', () => {
    const hold = gatewayHoldMicros(price, 'anthropic', request);
    const usage: GatewayUsage = { inputTokens: 3_100, outputTokens: 50, cache: { readTokens: 2_000, writeTokens: 1_000 } };
    // 100 uncached + 1,000 × 1.25 + 2,000 × 0.1 = 1,550 full-price input tokens.
    assert.deepEqual(gatewayChargeMicros(price, 'anthropic', request, hold, usage), { micros: maxRequestMicros(price, 1_550, 50), known: true });
    // Not asked: the reads at the full price.
    assert.deepEqual(gatewayChargeMicros(price, 'anthropic', { ...request, cacheAsked: false }, hold, usage), { micros: maxRequestMicros(price, 3_350, 50), known: true });
    // More cached than the whole prompt: the input counts twice.
    const odd: GatewayUsage = { inputTokens: 1_000, outputTokens: 50, cache: { readTokens: 900, writeTokens: 900 } };
    assert.deepEqual(gatewayChargeMicros(price, 'anthropic', request, hold, odd), { micros: maxRequestMicros(price, 2_000, 50), known: true });
  });

  test('no usage, more than the bounds, a web search or more than the hold: all it held', () => {
    const hold = gatewayHoldMicros(price, 'openai', request);
    assert.deepEqual(gatewayChargeMicros(price, 'openai', request, hold, null), { micros: hold, known: false });
    assert.deepEqual(gatewayChargeMicros(price, 'openai', request, hold, { inputTokens: 10_001, outputTokens: 1 }), { micros: hold, known: false });
    assert.deepEqual(gatewayChargeMicros(price, 'openai', request, hold, { inputTokens: 1, outputTokens: 1_001 }), { micros: hold, known: false });
    assert.deepEqual(gatewayChargeMicros(price, 'anthropic', request, hold, { inputTokens: 1, outputTokens: 1, webSearches: 1 }), { micros: hold, known: false });
    assert.deepEqual(gatewayChargeMicros(price, 'openrouter', request, hold, { inputTokens: 1, outputTokens: 1, reportedCostMicros: hold + 1 }), { micros: hold, known: false });
    assert.deepEqual(gatewayChargeMicros(price, 'openrouter', request, hold, { inputTokens: 1, outputTokens: 1, reportedCostMicros: 77 }), { micros: 77, known: true });
  });
});

describe('runtime-egress\'s model port', () => {
  let worker: Server; let egress: Server; let base = '';
  const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  before(async () => {
    worker = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url!, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-should-retry': 'false', 'set-cookie': 'a=b', 'x-internal': 'secret' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 20);
      });
    });
    await new Promise<void>((done) => worker.listen(0, '127.0.0.1', () => done()));
    egress = createModelForwarder({ upstream: { host: '127.0.0.1', port: (worker.address() as AddressInfo).port }, log: (event) => logs.push(event), limits: { requestBytes: 1024 } });
    await new Promise<void>((done) => egress.listen(0, '127.0.0.1', () => done()));
    base = `http://127.0.0.1:${(egress.address() as AddressInfo).port}`;
  });
  after(() => { egress.close(); worker.close(); });

  test('passes a model path on with only its fixed headers, and the answer back as it arrives', async () => {
    const answer = await fetch(`${base}/anthropic/v1/messages`, { method: 'POST', body: '{"model":"m"}', headers: {
      'x-api-key': TOKEN, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'interleaved-thinking-2025-05-14', 'content-type': 'application/json',
      cookie: 'session=1', 'x-forwarded-for': '10.0.0.1', 'user-agent': 'claude-cli/9', 'x-app': 'cli', host: 'api.anthropic.com' } });
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), 'data: one\n\ndata: two\n\n');
    assert.equal(answer.headers.get('x-should-retry'), 'false');
    assert.equal(answer.headers.get('set-cookie'), null);
    assert.equal(answer.headers.get('x-internal'), null);
    const got = seen.at(-1)!;
    assert.equal(got.url, '/anthropic/v1/messages');
    assert.equal(got.body, '{"model":"m"}');
    assert.deepEqual(Object.keys(got.headers).filter((name) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)).sort(),
      ['accept', 'anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key']);
    assert.ok(!JSON.stringify(logs).includes(TOKEN), 'the egress never logs a token');
  });

  test('refuses other methods, paths and sizes itself, as non-retryable JSON errors', async () => {
    const before = seen.length;
    const get = await fetch(`${base}/anthropic/v1/messages`);
    assert.equal(get.status, 405);
    for (const path of ['/anthropic/v1/messages?key=x', '/anthropic/v1/files', '/mcp', '/openai/v1/models']) {
      const answer = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      assert.equal(answer.status, 404, path);
      assert.equal(answer.headers.get('x-should-retry'), 'false');
      assert.equal(((await answer.json()) as { error: { code: string } }).error.code, 'flux_not_found');
    }
    const large = await fetch(`${base}/openai/v1/responses`, { method: 'POST', body: 'x'.repeat(2048) });
    assert.equal(large.status, 413);
    assert.equal(seen.length, before, 'nothing refused reached the worker');
  });
});
