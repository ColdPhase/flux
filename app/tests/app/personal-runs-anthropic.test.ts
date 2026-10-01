import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PERSONAL_RUN_LIMITS } from '@flux/contracts';
import { costMicros, SYSTEM_PROMPT, type PersonalComputeRequest } from '@flux/core';
import { anthropicPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import { personalRunServerComposition } from '../../apps/server/src/personal-runs/composition.js';
import { personalRunWorkerComposition } from '../../apps/worker/src/personal-runs/composition.js';

// The Anthropic adapter behind `PersonalCompute` (#68, O-008 §3–§4), against a LOCAL MOCK HTTP
// server in this test process. No real provider is called and no key exists: the "key" is a
// fixed test string. These tests prove what the adapter sends and how it maps answers and
// failures; they are not a provider, billing or compatibility pass.

const KEY = 'test-only-not-a-key-7f3a';
const KEY_REF = 'key-ref-of-owner';

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: Record<string, unknown>; aborted: boolean }
type Handler = (seen: Seen, response: ServerResponse) => void;

let seen: Seen[] = [];
let handler: Handler = () => undefined;
let baseURL = '';
const server = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const item: Seen = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body: raw ? JSON.parse(raw) : {}, aborted: false };
    response.on('close', () => { if (!response.writableFinished) item.aborted = true; });
    seen.push(item);
    handler(item, response);
  });
});

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}
const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: PERSONAL_RUN_LIMITS.model,
  content: [{ type: 'text', text: 'Fact: the camera fails below 5 lux [S1].' }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1_200, output_tokens: 80 }, ...overrides,
});
const apiError = (type: string) => ({ type: 'error', error: { type, message: `scripted ${type}` } });

const request: PersonalComputeRequest = {
  connection: { id: 'connection-1', keyRef: KEY_REF }, model: PERSONAL_RUN_LIMITS.model, maxTokens: PERSONAL_RUN_LIMITS.maxOutputTokens,
  effort: PERSONAL_RUN_LIMITS.effort, system: SYSTEM_PROMPT, input: 'Task: Answer the request.\nRequest: Where are we?\n\nSources:\n[S1] Message 1 by Kai: Camera fails below 5 lux',
};
const resolved: string[] = [];
const compute = () => anthropicPersonalCompute({
  enabled: true, baseURL, timeoutMs: 2_000,
  resolveKey: async (keyRef) => { resolved.push(keyRef); return keyRef === KEY_REF ? KEY : null; },
});

describe('Anthropic personal compute adapter (#68, local mock server: no provider pass is claimed)', () => {
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => { seen = []; resolved.length = 0; handler = (_seen, response) => json(response, 200, message()); });

  test('one bounded Messages request: pinned model, max_tokens 1500, low effort, no tools, the owner\'s key', async () => {
    const result = await compute().dispatch(request, new AbortController().signal);
    assert.deepEqual(result, { kind: 'completed', text: 'Fact: the camera fails below 5 lux [S1].', stopReason: 'end_turn', usage: { inputTokens: 1_200, outputTokens: 80 } });
    assert.equal(seen.length, 1);
    const [sent] = seen;
    assert.deepEqual([sent!.method, sent!.path], ['POST', '/v1/messages']);
    assert.equal(sent!.headers['x-api-key'], KEY);
    assert.equal(sent!.headers.authorization, undefined, 'no other credential is sent');
    assert.deepEqual(sent!.body, {
      model: 'claude-sonnet-5', max_tokens: 1500, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: request.input }], output_config: { effort: 'low' },
    }, 'no tools, hosted search, MCP or streaming');
    assert.deepEqual(resolved, [KEY_REF]);
    // Usage → cost at the recorded O-008 price ($2/M input, $10/M output).
    assert.equal(result.kind === 'completed' && costMicros(result.usage), 1_200 * 2 + 80 * 10);
    assert.equal(JSON.stringify(result).includes(KEY), false, 'the key never appears in the result');
  });

  test('cache tokens are counted conservatively as input and a context-window stop counts as truncated', async () => {
    handler = (_seen, response) => json(response, 200, message({ stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 10, cache_creation_input_tokens: 8, cache_read_input_tokens: 7, output_tokens: 3 } }));
    assert.deepEqual(await compute().dispatch(request, new AbortController().signal), {
      kind: 'completed', text: 'Fact: the camera fails below 5 lux [S1].', stopReason: 'max_tokens', usage: { inputTokens: 10 + 10 + 7, outputTokens: 3 },
    });
    handler = (_seen, response) => json(response, 200, message({ stop_reason: 'max_tokens' }));
    assert.equal((await compute().dispatch(request, new AbortController().signal) as { stopReason: string }).stopReason, 'max_tokens');
    handler = (_seen, response) => json(response, 200, message({ stop_reason: 'refusal', content: [] }));
    assert.deepEqual(await compute().dispatch(request, new AbortController().signal), { kind: 'completed', text: '', stopReason: 'refusal', usage: { inputTokens: 1_200, outputTokens: 80 } });
  });

  test('the preflight uses the token-counting endpoint with the same input and key', async () => {
    handler = (_seen, response) => json(response, 200, { input_tokens: 4_321 });
    assert.equal(await compute().countInputTokens(request), 4_321);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.path, '/v1/messages/count_tokens');
    assert.equal(seen[0]!.headers['x-api-key'], KEY);
    assert.deepEqual(seen[0]!.body, { model: 'claude-sonnet-5', system: SYSTEM_PROMPT, messages: [{ role: 'user', content: request.input }] });
    handler = (_seen, response) => json(response, 500, apiError('api_error'));
    await assert.rejects(compute().countInputTokens(request));
    assert.equal(seen.length, 2, 'a failed count is not retried');
  });

  test('SDK retries are off: every failure is exactly one request; once sent, the charge is unknown', async () => {
    const cases: [number, string, Record<string, string>, { reason: string; billed: string }][] = [
      [429, 'rate_limit_error', { 'retry-after': '0' }, { reason: 'rate_limited', billed: 'unknown' }],
      [529, 'overloaded_error', {}, { reason: 'overloaded', billed: 'unknown' }],
      [500, 'api_error', {}, { reason: 'provider_error', billed: 'unknown' }],
      [503, 'api_error', {}, { reason: 'provider_error', billed: 'unknown' }],
      [400, 'invalid_request_error', {}, { reason: 'provider_error', billed: 'unknown' }],
      [401, 'authentication_error', {}, { reason: 'provider_error', billed: 'unknown' }],
    ];
    for (const [status, type, headers, expected] of cases) {
      seen = [];
      handler = (_seen, response) => json(response, status, apiError(type), { 'x-should-retry': 'true', ...headers });
      const result = await compute().dispatch(request, new AbortController().signal);
      assert.deepEqual(result, { kind: 'failed', ...expected }, `HTTP ${status}`);
      assert.equal(seen.length, 1, `HTTP ${status} is sent once, even when the server asks for a retry`);
      assert.equal(JSON.stringify(result).includes(KEY), false);
    }
  });

  test('Stop aborts the HTTP request; a timeout and a lost connection keep the charge unknown', async () => {
    handler = () => undefined; // never answers
    const controller = new AbortController();
    const pending = compute().dispatch(request, controller.signal);
    await waitFor(() => seen.length === 1);
    controller.abort();
    assert.deepEqual(await pending, { kind: 'failed', reason: 'aborted', billed: 'unknown' });
    await waitFor(() => seen[0]!.aborted);
    assert.equal(seen.length, 1);

    seen = [];
    assert.deepEqual(await compute().dispatch(request, new AbortController().signal), { kind: 'failed', reason: 'timeout', billed: 'unknown' });
    assert.equal(seen.length, 1, 'a timeout is not retried');

    seen = [];
    handler = (_seen, response) => { response.socket?.destroy(); };
    assert.deepEqual(await compute().dispatch(request, new AbortController().signal), { kind: 'failed', reason: 'provider_error', billed: 'unknown' });
    assert.equal(seen.length, 1, 'a lost connection is not retried');
  });

  test('nothing is sent without a usable key or outside the O-008 limits', async () => {
    const other = { ...request, connection: { id: 'connection-2', keyRef: 'someone-else' } };
    assert.deepEqual(await compute().dispatch(other, new AbortController().signal), { kind: 'failed', reason: 'provider_error', billed: 'none' });
    await assert.rejects(compute().countInputTokens(other));
    for (const bad of [{ ...request, model: 'claude-opus-5' }, { ...request, maxTokens: 1_501 }, { ...request, effort: 'high' as 'low' }]) {
      await assert.rejects(compute().dispatch(bad, new AbortController().signal));
      await assert.rejects(compute().countInputTokens(bad));
    }
    assert.equal(seen.length, 0, 'no request reached the provider');
    assert.deepEqual(resolved, ['someone-else', 'someone-else'], 'an out-of-limit request never even resolves a key');
  });

  test('ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY in the environment never redirect or replace the owner\'s key', async () => {
    const saved = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    process.env.ANTHROPIC_API_KEY = 'environment-key';
    try {
      assert.equal((await compute().dispatch(request, new AbortController().signal)).kind, 'completed');
      assert.equal(seen[0]!.headers['x-api-key'], KEY);
    } finally {
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    }
  });
});

describe('personal-run composition: production fails closed, the mock switch is test only', () => {
  test('without the switch both apps compose no connections and the provider off', async () => {
    const server = personalRunServerComposition({});
    const worker = personalRunWorkerComposition({});
    assert.deepEqual([server.mode, server.providerEnabled, worker.mode, worker.compute.enabled], ['production', false, 'production', false]);
    assert.equal(await server.connections.resolve('someone'), null);
    assert.equal(await worker.connections.resolve('someone'), null);
  });

  test('the switch needs the test flag and a plain mock origin, and anything else refuses to start', () => {
    const on = { FLUX_TEST_PERSONAL_RUNS: 'anthropic-mock', FLUX_TEST_FAILURE_INJECTION: 'true', FLUX_TEST_ANTHROPIC_URL: 'http://anthropic-mock:8090' };
    assert.equal(personalRunServerComposition(on).mode, 'test-anthropic-mock');
    assert.equal(personalRunWorkerComposition(on).compute.enabled, true);
    for (const env of [{ ...on, FLUX_TEST_FAILURE_INJECTION: 'false' }, { ...on, FLUX_TEST_PERSONAL_RUNS: 'real' }]) {
      assert.throws(() => personalRunServerComposition(env));
      assert.throws(() => personalRunWorkerComposition(env));
    }
    assert.throws(() => personalRunWorkerComposition({ ...on, FLUX_TEST_ANTHROPIC_URL: 'https://api.anthropic.com' }));
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
