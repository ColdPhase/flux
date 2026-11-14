import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PERSONAL_RUN_LIMITS, tablePrice } from '@flux/contracts';
import { costMicros, type PersonalComputeRequest } from '@flux/core';
import { BRIEF } from './support/brief.js';
import { anthropicPersonalCompute, parsePrivateTargets } from '../../packages/agent-runtime/src/index.js';
import { personalRunServerComposition } from '../../apps/server/src/personal-runs/composition.js';
import { anthropicProxyOf, personalRunWorkerComposition } from '../../apps/worker/src/personal-runs/composition.js';
import { createDatabase } from '@flux/db';

// The Anthropic adapter behind `PersonalCompute` (#68, O-008 §3–§4), against a LOCAL MOCK HTTP
// server in this test process. No real provider is called and no key exists: the "key" is a
// fixed test string. These tests prove what the adapter sends and how it maps answers and
// failures; they are not a provider, billing or compatibility pass. The same behaviour of every
// wire format against the Docker mock provider is `provider-adapters.test.ts` (F-020 PROV-6). The
// loopback mock is reached only because this test's endpoint policy allows 127.0.0.1. Every API-key
// agent runs in pi in the agent runtime (#1441, RT-1) and reaches its provider through Flux's model
// gateway, so the adapter is what the worker uses for the one request of `flux_web_search`, not for
// a run's own turns; and the compositions below say which apps start the provider and when.

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
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'Fact: the camera fails below 5 lux [S1].' }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1_200, output_tokens: 80 }, ...overrides,
});
const apiError = (type: string) => ({ type: 'error', error: { type, message: `scripted ${type}` } });

const request: PersonalComputeRequest = {
  connection: { id: 'connection-1', keyRef: KEY_REF, provider: 'anthropic', baseUrl: null }, model: 'claude-sonnet-5', maxTokens: PERSONAL_RUN_LIMITS.maxOutputTokens,
  effort: PERSONAL_RUN_LIMITS.effort, system: BRIEF.system, input: BRIEF.request,
};
const resolved: string[] = [];
const compute = () => anthropicPersonalCompute({
  enabled: true, baseURL, timeoutMs: 2_000, policy: parsePrivateTargets('127.0.0.1'),
  resolveKey: async (keyRef) => { resolved.push(keyRef); return keyRef === KEY_REF ? KEY : null; },
});

describe('Anthropic personal compute adapter (#68, local mock server: no provider pass is claimed)', () => {
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => { seen = []; resolved.length = 0; handler = (_seen, response) => json(response, 200, message()); });

  test('one bounded Messages request: the connection\'s model, max_tokens 4000, low effort, no tools, the owner\'s key', async () => {
    const result = await compute().dispatch(request, new AbortController().signal);
    assert.deepEqual(result, { kind: 'completed', text: 'Fact: the camera fails below 5 lux [S1].', stopReason: 'end_turn', usage: { inputTokens: 1_200, outputTokens: 80 } });
    assert.equal(seen.length, 1);
    const [sent] = seen;
    assert.deepEqual([sent!.method, sent!.path], ['POST', '/v1/messages']);
    // SDK 1.x sends an API key as a bearer (#1240); it is the one credential on the request.
    assert.equal(sent!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent!.headers['x-api-key'], undefined, 'no other credential is sent');
    assert.deepEqual(sent!.body, {
      model: 'claude-sonnet-5', max_tokens: 4000, system: BRIEF.system,
      messages: [{ role: 'user', content: request.input }], output_config: { effort: 'low' },
    }, 'no tools, hosted search, MCP or streaming');
    assert.deepEqual(resolved, [KEY_REF]);
    // Usage → cost at the connection's table price ($2/M input, $10/M output).
    assert.equal(result.kind === 'completed' && costMicros(result.usage, tablePrice('anthropic', 'claude-sonnet-5')!), 1_200 * 2 + 80 * 10);
    assert.equal(JSON.stringify(result).includes(KEY), false, 'the key never appears in the result');
  });

  test('cache tokens a request did not ask for are charged at no less than the full price, and a context-window stop counts as truncated', async () => {
    handler = (_seen, response) => json(response, 200, message({ stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 10, cache_creation_input_tokens: 8, cache_read_input_tokens: 7, output_tokens: 3 } }));
    const unasked = await compute().dispatch(request, new AbortController().signal);
    assert.deepEqual(unasked, {
      kind: 'completed', text: 'Fact: the camera fails below 5 lux [S1].', stopReason: 'max_tokens',
      usage: { inputTokens: 10 + 8 + 7, outputTokens: 3, cache: { readTokens: 7, writeTokens: 8, readRate: 1, writeRate: 1.25 } },
    });
    assert.equal(unasked.kind === 'completed' && costMicros(unasked.usage, tablePrice('anthropic', 'claude-sonnet-5')!), Math.ceil(((10 + 10 + 7) * 2_000_000 + 3 * 10_000_000) / 1_000_000));
    handler = (_seen, response) => json(response, 200, message({ stop_reason: 'max_tokens' }));
    assert.equal((await compute().dispatch(request, new AbortController().signal) as { stopReason: string }).stopReason, 'max_tokens');
    handler = (_seen, response) => json(response, 200, message({ stop_reason: 'refusal', content: [] }));
    assert.deepEqual(await compute().dispatch(request, new AbortController().signal), { kind: 'completed', text: '', stopReason: 'refusal', usage: { inputTokens: 1_200, outputTokens: 80 } });
  });

  test('SDK retries are off: every failure is exactly one request; once sent, the charge is unknown', async () => {
    const cases: [number, string, Record<string, string>, { reason: string; billed: string }][] = [
      [429, 'rate_limit_error', { 'retry-after': '0' }, { reason: 'rate_limited', billed: 'unknown' }],
      [529, 'overloaded_error', {}, { reason: 'overloaded', billed: 'unknown' }],
      [500, 'api_error', {}, { reason: 'provider_error', billed: 'unknown' }],
      // 503 is "overloaded" on every wire format (F-020 PROV-6), as 529 is.
      [503, 'api_error', {}, { reason: 'overloaded', billed: 'unknown' }],
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

  test('CA-3: Anthropic\'s answer when the credits ran out is its own failure, and nothing was billed', async () => {
    handler = (_seen, response) => json(response, 400, { type: 'error', error: { type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });
    assert.deepEqual(await compute().dispatch(request, new AbortController().signal), { kind: 'failed', reason: 'no_credits', billed: 'none' });
  });

  test('Stop aborts the HTTP request; a timeout and a lost connection keep the charge unknown', async () => {
    handler = () => undefined; // never answers
    const controller = new AbortController();
    const pending = compute().dispatch(request, controller.signal);
    await waitUntil(() => seen.length === 1);
    controller.abort();
    assert.deepEqual(await pending, { kind: 'failed', reason: 'aborted', billed: 'unknown' });
    await waitUntil(() => seen[0]!.aborted);
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
    const other = { ...request, connection: { ...request.connection, id: 'connection-2', keyRef: 'someone-else' } };
    assert.deepEqual(await compute().dispatch(other, new AbortController().signal), { kind: 'failed', reason: 'provider_error', billed: 'none' });
    const otherWire = { ...request, connection: { ...request.connection, provider: 'openai' as const } };
    for (const bad of [{ ...request, model: 'not a model id' }, { ...request, maxTokens: 4_001 }, { ...request, effort: 'high' as 'low' }, otherWire]) {
      // Never sent, so it costs nothing (security review of #1453): refused, not thrown.
      assert.deepEqual(await compute().dispatch(bad, new AbortController().signal), { kind: 'failed', reason: 'provider_error', billed: 'none' });
    }
    assert.equal(seen.length, 0, 'no request reached the provider');
    assert.deepEqual(resolved, ['someone-else'], 'an out-of-limit request never even resolves a key');
  });

  test('ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY in the environment never redirect or replace the owner\'s key', async () => {
    const saved = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    process.env.ANTHROPIC_API_KEY = 'environment-key';
    try {
      assert.equal((await compute().dispatch(request, new AbortController().signal)).kind, 'completed');
      assert.equal(seen[0]!.headers.authorization, `Bearer ${KEY}`);
    } finally {
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    }
  });
});

describe('personal-run composition: production is off until the operator switches it on and pi runs keys, the mock switch is test only', () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  after(() => pool.end());
  /** The agent runtime as the API sees it with `pi` in FLUX_AGENT_RUNTIME (#1441): every API key runs in pi there. */
  const withPi = { keys: true, manager: { url: 'http://runtime-manager:8081', secret: 'x'.repeat(32) } };
  /** Without `pi`, or without the runtime itself, an API key has nowhere to run. */
  const withoutPi = [{ keys: false, manager: withPi.manager }, { keys: true, manager: null }, { manager: null }];

  test('without the operator switch both apps look up the owner\'s own connections and keep the provider off', async () => {
    const server = personalRunServerComposition({}, db, withPi);
    const worker = personalRunWorkerComposition({}, db);
    assert.deepEqual([server.mode, server.providerEnabled, worker.mode, worker.compute.enabled], ['production', false, 'production', false]);
    assert.equal(await server.connections.resolve('someone-without-a-connection'), null);
    assert.equal(await worker.connections.resolve('someone-without-a-connection'), null);
    assert.equal(personalRunServerComposition({ FLUX_PERSONAL_RUNS: 'off' }, db, withPi).providerEnabled, false);
  });

  test('FLUX_PERSONAL_RUNS=on enables the provider in both apps, and for API keys only where pi runs them; any other value refuses to start', () => {
    const on = { FLUX_PERSONAL_RUNS: 'on' };
    assert.equal(personalRunServerComposition(on, db, withPi).providerEnabled, true);
    for (const runtime of withoutPi) assert.equal(personalRunServerComposition(on, db, runtime).providerEnabled, false, `no pi in the runtime: ${JSON.stringify(runtime)}`);
    // The worker also needs the instance key that seals connection keys (present in the test stack).
    assert.equal(personalRunWorkerComposition(on, db).compute.enabled, true);
    for (const value of ['yes', 'ON', 'true']) {
      assert.throws(() => personalRunServerComposition({ FLUX_PERSONAL_RUNS: value }, db, withPi));
      assert.throws(() => personalRunWorkerComposition({ FLUX_PERSONAL_RUNS: value }, db));
    }
  });

  test('the switch needs the test flag and a plain mock origin, and anything else refuses to start', () => {
    const on = { FLUX_TEST_PERSONAL_RUNS: 'anthropic-mock', FLUX_TEST_FAILURE_INJECTION: 'true', FLUX_TEST_ANTHROPIC_URL: 'http://anthropic-mock:8090' };
    const server = personalRunServerComposition(on, db, withPi);
    assert.deepEqual([server.mode, server.providerEnabled], ['test-anthropic-mock', true]);
    for (const runtime of withoutPi) assert.equal(personalRunServerComposition(on, db, runtime).providerEnabled, false, `no pi in the runtime: ${JSON.stringify(runtime)}`);
    assert.equal(personalRunWorkerComposition(on, db).compute.enabled, true);
    for (const env of [{ ...on, FLUX_TEST_FAILURE_INJECTION: 'false' }, { ...on, FLUX_TEST_PERSONAL_RUNS: 'real' }]) {
      assert.throws(() => personalRunServerComposition(env, db, withPi));
      assert.throws(() => personalRunWorkerComposition(env, db));
    }
    assert.throws(() => personalRunWorkerComposition({ ...on, FLUX_TEST_ANTHROPIC_URL: 'https://api.anthropic.com' }, db));
  });

  test('the evaluation\'s recording proxy (#1295) is test only and a plain origin; production without it is unchanged', () => {
    assert.equal(anthropicProxyOf({}), null);
    assert.equal(anthropicProxyOf({ FLUX_TEST_ANTHROPIC_PROXY_URL: 'http://evalproxy:8099', FLUX_TEST_FAILURE_INJECTION: 'true' }), 'http://evalproxy:8099');
    assert.throws(() => anthropicProxyOf({ FLUX_TEST_ANTHROPIC_PROXY_URL: 'http://evalproxy:8099' }), /test only/);
    assert.throws(() => anthropicProxyOf({ FLUX_TEST_ANTHROPIC_PROXY_URL: 'https://evil.example/x', FLUX_TEST_FAILURE_INJECTION: 'true' }), /http origin/);
    assert.throws(() => personalRunWorkerComposition({ FLUX_PERSONAL_RUNS: 'on', FLUX_TEST_ANTHROPIC_PROXY_URL: 'http://evalproxy:8099' }, db), /test only/);
  });
});

async function waitUntil(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
