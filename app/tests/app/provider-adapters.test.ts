import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { tablePrice, type AiProviderKind } from '@flux/contracts';
import { costMicros, type PersonalCompute, type PersonalComputeRequest } from '@flux/core';
import { BRIEF } from './support/brief.js';
import { listProviderModels, parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// The adapter contract suite (F-020 PROV-6): ONE set of cases runs identically against the Docker
// mock of each wire format (`providermock`, app/tests/app/support/provider-mock.ts): Anthropic
// Messages, and OpenAI-compatible Chat Completions as OpenAI, OpenRouter, Gemini's compatible
// endpoint and self-hosted servers speak it. It covers success, truncation, refusal, rate limit,
// overload, timeout, abort, malformed output, redirects, oversized answers, usage and cost
// reconciliation, retries off, and that the owner's key never leaves an adapter. Nothing here calls
// a real provider: no case is a provider, billing or compatibility pass.

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
// The operator allowlist of this suite: the mock's host only, as `FLUX_AI_PRIVATE_TARGETS` would.
const policy = parsePrivateTargets(new URL(MOCK).hostname);
const PRICE = tablePrice('anthropic', 'claude-sonnet-5')!;

interface WireCase {
  wire: 'anthropic' | 'openai';
  provider: AiProviderKind;
  model: string;
  /** The owner's key: each carries the marker check_application.sh also looks for in the API logs. */
  key: string;
  connectionBaseUrl: string | null;
  /** The request field of the output bound on this wire format. */
  maxTokensField: string;
}

const WIRES: WireCase[] = [
  { wire: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5', key: `sk-ant-api03-${'owner-budget-key-'.repeat(3)}ANT1`,
    connectionBaseUrl: null, maxTokensField: 'max_tokens' },
  { wire: 'openai', provider: 'openai_compatible', model: 'llama3.1:8b', key: `local-${'owner-budget-key-'.repeat(3)}OAI1`,
    connectionBaseUrl: `${MOCK}/openai/v1`, maxTokensField: 'max_tokens' },
];
const NAMED_BASE_URLS = { anthropic: `${MOCK}/anthropic`, openai: `${MOCK}/openai/v1`, openrouter: `${MOCK}/openai/v1`, gemini: `${MOCK}/openai/v1` };

const resolveKeyFor = (key: string) => async (keyRef: string) => (keyRef === 'owner-key-ref' ? key : null);
const personal = (wire: WireCase, timeoutMs = 2_000): PersonalCompute => providerPersonalCompute({
  enabled: true, resolveKey: resolveKeyFor(wire.key), policy, baseUrls: NAMED_BASE_URLS, timeoutMs, maxResponseBytes: 1_000_000 });
const request = (wire: WireCase, overrides: Partial<PersonalComputeRequest> = {}): PersonalComputeRequest => ({
  connection: { id: 'connection-1', keyRef: 'owner-key-ref', provider: wire.provider, baseUrl: wire.connectionBaseUrl },
  model: wire.model, maxTokens: 1_500, effort: 'low', system: BRIEF.system,
  input: BRIEF.request, ...overrides,
});

async function control(path: string, body?: unknown) {
  const response = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ requests: RecordedProviderRequest[] }>;
}
const script = (wire: WireCase['wire'], patch: Record<string, unknown>) => control('/__script', { wire, ...patch });
const sent = async (wire?: WireCase['wire']) => (await control('/__requests')).requests.filter((item) => !wire || item.wire === wire);

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Everything the adapters print while the suite runs, to prove no key reaches a log.
const printed: string[] = [];
const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
before(() => {
  for (const name of Object.keys(originals) as (keyof typeof originals)[])
    console[name] = (...args: unknown[]) => { printed.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' ')); };
});
after(() => { Object.assign(console, originals); });

for (const wire of WIRES) {
  describe(`adapter contract on ${wire.wire === 'anthropic' ? 'Anthropic Messages' : 'OpenAI-compatible Chat Completions'} (Docker mock; no provider pass)`, () => {
    beforeEach(() => control('/__reset', {}));
    afterEach(async () => {
      // Keys never appear in what the adapters printed. (Results and errors are checked per case.)
      for (const line of printed) assert.equal(line.includes(wire.key), false, 'a key reached the console');
    });

    test('success: one bounded request with the owner\'s key, the connection\'s model, no tools; usage maps to cost', async () => {
      const result = await personal(wire).dispatch(request(wire), new AbortController().signal);
      assert.deepEqual(result, { kind: 'completed', text: 'Fact: the camera fails below 5 lux [S1].', stopReason: 'end_turn', usage: { inputTokens: 1_200, outputTokens: 80 } });
      const [one, ...rest] = await sent(wire.wire);
      assert.equal(rest.length, 0, 'exactly one request');
      assert.equal(one!.key, wire.key);
      const body = one!.body as Record<string, unknown>;
      assert.equal(body.model, wire.model);
      assert.equal(body[wire.maxTokensField], 1_500);
      for (const field of ['tools', 'tool_choice', 'stream', 'plugins', 'web_search_options']) assert.equal(body[field], undefined, `no ${field}`);
      // The same prompt assembly on both wire formats: one system prompt and one user input.
      const messages = body.messages as Array<{ role: string; content: string }>;
      const [system, user] = wire.wire === 'anthropic' ? [body.system, messages[0]?.content] : [messages[0]?.content, messages[1]?.content];
      assert.deepEqual([system, user, messages.length], [BRIEF.system, request(wire).input, wire.wire === 'anthropic' ? 1 : 2]);
      assert.equal(result.kind === 'completed' && costMicros(result.usage, PRICE), 1_200 * 2 + 80 * 10, 'usage × the connection price');
      assert.equal(JSON.stringify(result).includes(wire.key), false);
    });

    test('truncation and refusal map to the shared stop reasons', async () => {
      await script(wire.wire, { mode: 'truncated' });
      assert.equal((await personal(wire).dispatch(request(wire), new AbortController().signal) as { stopReason: string }).stopReason, 'max_tokens');
      await script(wire.wire, { mode: 'refusal' });
      assert.deepEqual(await personal(wire).dispatch(request(wire), new AbortController().signal),
        { kind: 'completed', text: '', stopReason: 'refusal', usage: { inputTokens: 1_200, outputTokens: 80 } });
    });

    test('rate limit, overload and errors: one request each, the closed reason, the charge unknown, no error body', async () => {
      const cases: [number, string][] = [[429, 'rate_limited'], [529, 'overloaded'], [503, 'overloaded'], [500, 'provider_error'], [400, 'provider_error'], [401, 'provider_error']];
      for (const [status, reason] of cases) {
        await control('/__reset', {});
        await script(wire.wire, { mode: 'status', status });
        const result = await personal(wire).dispatch(request(wire), new AbortController().signal);
        assert.deepEqual(result, { kind: 'failed', reason, billed: 'unknown' }, `HTTP ${status}`);
        assert.equal((await sent(wire.wire)).length, 1, `HTTP ${status} is sent once, although the mock asks for a retry`);
        assert.equal(JSON.stringify(result).includes(wire.key), false);
      }
    });

    test('timeout and abort end the request; the charge stays unknown', async () => {
      await script(wire.wire, { mode: 'hang' });
      assert.deepEqual(await personal(wire, 800).dispatch(request(wire), new AbortController().signal), { kind: 'failed', reason: 'timeout', billed: 'unknown' });
      assert.equal((await sent(wire.wire)).length, 1, 'a timeout is not retried');
      await control('/__reset', {});
      await script(wire.wire, { mode: 'hang' });
      const controller = new AbortController();
      const pending = personal(wire).dispatch(request(wire), controller.signal);
      await waitFor(async () => (await sent(wire.wire)).length === 1);
      controller.abort();
      assert.deepEqual(await pending, { kind: 'failed', reason: 'aborted', billed: 'unknown' });
      await waitFor(async () => (await sent(wire.wire))[0]!.aborted);
    });

    test('malformed, usage-less, redirected and oversized answers fail closed without following anything', async () => {
      for (const mode of ['malformed', 'no_usage', 'redirect', 'oversized']) {
        await control('/__reset', {});
        await script(wire.wire, { mode });
        const result = await personal(wire).dispatch(request(wire), new AbortController().signal);
        assert.deepEqual(result, { kind: 'failed', reason: 'provider_error', billed: 'unknown' }, mode);
        assert.equal(JSON.stringify(result).includes(wire.key), false);
        const all = await sent();
        assert.equal(all.some((item) => item.path === '/__redirected'), false, `${mode}: a redirect is never followed`);
        assert.equal(all.length, 1, `${mode}: one request`);
      }
    });

    test('nothing is sent without a usable key, to a refused endpoint, or outside the O-008 limits', async () => {
      const noKey = request(wire, { connection: { ...request(wire).connection, keyRef: 'someone-else' } });
      assert.deepEqual(await personal(wire).dispatch(noKey, new AbortController().signal), { kind: 'failed', reason: 'provider_error', billed: 'none' });
      // A private or metadata address the operator has not allowed: refused before anything is sent (PROV-4).
      for (const target of ['http://10.0.0.7:11434/v1', 'https://169.254.169.254/v1']) {
        const refused = wire.connectionBaseUrl ? request(wire, { connection: { ...request(wire).connection, baseUrl: target } }) : request(wire);
        const compute = wire.connectionBaseUrl ? personal(wire)
          : providerPersonalCompute({ enabled: true, resolveKey: resolveKeyFor(wire.key), policy, baseUrls: { anthropic: target.replace(/\/v1$/, '') } });
        assert.deepEqual(await compute.dispatch(refused, new AbortController().signal), { kind: 'failed', reason: 'provider_error', billed: 'none' }, target);
      }
      for (const bad of [request(wire, { model: 'not a model' }), request(wire, { maxTokens: 4_001 }), request(wire, { effort: 'high' as 'low' })])
        await assert.rejects(personal(wire).dispatch(bad, new AbortController().signal));
      assert.equal((await sent()).length, 0, 'no request reached any provider');
    });

    test('environment variables never redirect a request or replace the owner\'s key', async () => {
      const names = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'HTTPS_PROXY'];
      const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      for (const name of names) process.env[name] = name.endsWith('KEY') ? 'environment-key' : 'http://127.0.0.1:9';
      try {
        assert.equal((await personal(wire).dispatch(request(wire), new AbortController().signal)).kind, 'completed');
        assert.equal((await sent(wire.wire))[0]!.key, wire.key);
      } finally {
        for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
      }
    });
  });
}

describe('wire details beyond the shared contract', () => {
  beforeEach(() => control('/__reset', {}));
  const openai = (provider: AiProviderKind): WireCase => ({ wire: 'openai', provider, model: 'vendor/priced-model', key: `sk-or-v1-${'owner-budget-key-'.repeat(3)}OR01`,
    connectionBaseUrl: null, maxTokensField: 'max_tokens' });

  test('a named OpenAI-wire provider uses its own URL; only OpenRouter\'s reported cost reconciles the charge', async () => {
    await script('openai', { cost: 0.0042 });
    const reported = await personal(openai('openrouter')).dispatch(request(openai('openrouter')), new AbortController().signal);
    assert.deepEqual(reported.kind === 'completed' && reported.usage, { inputTokens: 1_200, outputTokens: 80, reportedCostMicros: 4_200 });
    assert.equal(reported.kind === 'completed' && costMicros(reported.usage, PRICE), 4_200, 'PROV-3: the reported cost reconciles the actual charge');
    assert.deepEqual(((await sent('openai'))[0]!.body as { usage?: unknown }).usage, { include: true }, 'OpenRouter is asked for its usage accounting');
    // Any other wire user may print a cost field; it is not a documented price source and is ignored.
    const compatible = await personal(WIRES[1]!).dispatch(request(WIRES[1]!), new AbortController().signal);
    assert.deepEqual(compatible.kind === 'completed' && compatible.usage, { inputTokens: 1_200, outputTokens: 80 });
    await control('/__reset', {});
    // OpenAI itself is spoken over the Responses API (#954): the brief is `instructions`, the output bound `max_output_tokens`
    // (it includes reasoning tokens), nothing is stored at OpenAI, and a request without tools has neither tools nor search.
    const openAiWire = { ...openai('openai'), key: `sk-proj-${'owner-budget-key-'.repeat(3)}OA01` };
    const answered = await personal(openAiWire).dispatch(request(openAiWire, { model: 'gpt-model' }), new AbortController().signal);
    assert.deepEqual(answered.kind === 'completed' && [answered.text, answered.stopReason, answered.usage], ['Fact: the camera fails below 5 lux [S1].', 'end_turn', { inputTokens: 1_200, outputTokens: 80 }]);
    const [one] = await sent('openai');
    assert.equal(one!.path, '/openai/v1/responses');
    const body = one!.body as Record<string, unknown>;
    assert.deepEqual([body.max_output_tokens, body.store, body.instructions, body.max_tokens, body.max_completion_tokens, 'tools' in body, 'include' in body],
      [1_500, false, BRIEF.system, undefined, undefined, false, false]);
    assert.deepEqual(body.input, [{ role: 'user', content: request(openAiWire).input }]);
  });

  test('the Responses API maps a cut-off answer and a refusal like every wire format (#954)', async () => {
    const openAiWire = { ...openai('openai'), key: `sk-proj-${'owner-budget-key-'.repeat(3)}OA02` };
    await script('openai', { mode: 'truncated' });
    const cut = await personal(openAiWire).dispatch(request(openAiWire, { model: 'gpt-model' }), new AbortController().signal);
    assert.equal(cut.kind === 'completed' && cut.stopReason, 'max_tokens');
    await script('openai', { mode: 'refusal' });
    const refused = await personal(openAiWire).dispatch(request(openAiWire, { model: 'gpt-model' }), new AbortController().signal);
    assert.deepEqual(refused.kind === 'completed' && [refused.stopReason, refused.text], ['refusal', '']);
    await script('openai', { mode: 'status', status: 429 });
    const limited = await personal(openAiWire).dispatch(request(openAiWire, { model: 'gpt-model' }), new AbortController().signal);
    assert.deepEqual(limited, { kind: 'failed', reason: 'rate_limited', billed: 'unknown' });
    await script('openai', { mode: 'malformed' });
    const malformed = await personal(openAiWire).dispatch(request(openAiWire, { model: 'gpt-model' }), new AbortController().signal);
    assert.deepEqual(malformed, { kind: 'failed', reason: 'provider_error', billed: 'unknown' });
    assert.ok(!printed.some((line) => line.includes(openAiWire.key)), 'the key is never printed');
  });

  test('with a reader of the words, Anthropic and the Responses API stream: the words come as they are written, and the answer is the same (#1248)', async () => {
    const cases: [WireCase, Partial<PersonalComputeRequest>][] = [[WIRES[0]!, {}], [{ ...openai('openai'), key: `sk-proj-${'owner-budget-key-'.repeat(3)}OA03` }, { model: 'gpt-model' }]];
    for (const [wire, overrides] of cases) {
      await control('/__reset', {});
      const text = 'The camera fails below 5 lux, so the ToF sensor takes over at night [S1].';
      await script(wire.wire, { text, streamGapMs: 25 });
      const words: { delta: string; at: number }[] = [];
      const whole = await personal(wire).dispatch(request(wire, overrides), new AbortController().signal);
      const streamed = await personal(wire).dispatch(request(wire, overrides), new AbortController().signal, (delta) => words.push({ delta, at: Date.now() }));
      const done = Date.now();
      assert.deepEqual(streamed, whole, `${wire.provider}: a streamed answer is the same result as a whole one`);
      assert.equal(words.map((word) => word.delta).join(''), text, `${wire.provider}: every word, in order`);
      assert.ok(words.length > 5, `${wire.provider}: in pieces (${words.length})`);
      assert.ok(done - words[0]!.at > 100, `${wire.provider}: the first words came before the answer ended`);
      const asked = (await sent(wire.wire)).map((item) => (item.body as { stream?: unknown }).stream);
      assert.deepEqual(asked, [undefined, true], `${wire.provider}: only the request with a reader is streamed`);
    }
    // A server that ends its lines with CRLF, one of them split across two chunks, is read the same.
    const crlfWire = { ...openai('openai'), key: `sk-proj-${'owner-budget-key-'.repeat(3)}OA04` };
    await control('/__reset', {});
    await script('openai', { crlf: true, streamGapMs: 10 });
    const crlfWhole = await personal(crlfWire).dispatch(request(crlfWire, { model: 'gpt-model' }), new AbortController().signal);
    const crlfStreamed = await personal(crlfWire).dispatch(request(crlfWire, { model: 'gpt-model' }), new AbortController().signal, () => undefined);
    assert.deepEqual(crlfStreamed, crlfWhole);
    // With the provider's own search the streamed answer keeps what the search found and its usage (#954).
    await control('/__reset', {});
    await script('anthropic', { search: { query: 'lux sensors', results: ['https://example.com/a', 'https://example.com/b'], cite: 'https://example.com/a' } });
    const tools = [{ name: 'flux_list_work', description: 'List the tasks', inputSchema: { type: 'object' as const, properties: {} } }];
    const searchWhole = await personal(WIRES[0]!).dispatch(request(WIRES[0]!, { tools, webSearch: true }), new AbortController().signal);
    const searchStreamed = await personal(WIRES[0]!).dispatch(request(WIRES[0]!, { tools, webSearch: true }), new AbortController().signal, () => undefined);
    assert.deepEqual(searchStreamed, searchWhole);
    // A stopped stream is an abort, as for a whole answer.
    await control('/__reset', {});
    await script('anthropic', { streamGapMs: 200 });
    const stop = new AbortController();
    const pending = personal(WIRES[0]!).dispatch(request(WIRES[0]!), stop.signal, () => stop.abort());
    assert.deepEqual(await pending, { kind: 'failed', reason: 'aborted', billed: 'unknown' });
  });

  test('only the Anthropic wire format counts tokens; the registry returns null elsewhere', async () => {
    const counted = await personal(WIRES[0]!).countInputTokens!(request(WIRES[0]!));
    assert.ok(typeof counted === 'number' && counted > 0);
    assert.equal(await personal(WIRES[1]!).countInputTokens!(request(WIRES[1]!)), null);
    assert.deepEqual((await sent()).map((item) => item.path), ['/anthropic/v1/messages/count_tokens']);
  });

  test('model lists are read without a key; OpenRouter\'s listing states prices; others need a key', async () => {
    const compatible = await listProviderModels('openai_compatible', `${MOCK}/openai/v1`, { policy });
    assert.equal(compatible.status, 'listed');
    assert.deepEqual(compatible.models, [{ id: 'llama3.1:8b', price: null }, { id: 'qwen2.5:7b-instruct', price: null }], 'invalid ids are dropped');
    const routed = await listProviderModels('openrouter', null, { policy, baseUrls: { openrouter: `${MOCK}/openrouter/v1` } });
    assert.deepEqual(routed.models, [
      { id: 'openrouter/auto', price: null },
      { id: 'vendor/free-model:free', price: { inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 } },
      { id: 'vendor/priced-model', price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 } },
    ], 'a variable price is unknown, and provider-hosted search variants are not offered');
    for (const listed of (await sent()).filter((item) => item.method === 'GET')) assert.equal(listed.key, null, 'no key is sent to list models');
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) assert.equal((await listProviderModels(provider, null, { policy })).status, 'needs_key');
    assert.equal((await listProviderModels('openai_compatible', 'http://10.1.2.3:11434/v1', { policy })).status, 'refused');
  });
});
