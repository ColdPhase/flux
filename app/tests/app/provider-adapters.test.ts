import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { tablePrice, type AiProviderKind } from '@flux/contracts';
import { ComparisonNotSentError, costMicros, SYSTEM_PROMPT, type ComparisonProvider, type ComparisonSource, type PersonalCompute,
  type PersonalComputeRequest } from '@flux/core';
import { listProviderModels, parsePrivateTargets, providerComparison, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
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
const comparison = (timeoutMs = 2_000): ComparisonProvider => providerComparison({ policy, baseUrls: NAMED_BASE_URLS, timeoutMs, maxResponseBytes: 1_000_000 });
const request = (wire: WireCase, overrides: Partial<PersonalComputeRequest> = {}): PersonalComputeRequest => ({
  connection: { id: 'connection-1', keyRef: 'owner-key-ref', provider: wire.provider, baseUrl: wire.connectionBaseUrl },
  model: wire.model, maxTokens: 1_500, effort: 'low', system: SYSTEM_PROMPT,
  input: 'Task: Answer the request.\nRequest: Where are we?\n\nSources:\n[S1] Message 1 by Kai: Camera fails below 5 lux', ...overrides,
});
const source: ComparisonSource = { type: 'result', id: 'result-1', version: 1, text: 'Camera A missed gestures at 5 lux.' };
const comparisonInput = (wire: WireCase, signal = AbortSignal.timeout(5_000)) => ({
  apiKey: wire.key, provider: wire.provider, model: wire.model, baseUrl: wire.connectionBaseUrl, sources: [source], signal,
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
      assert.deepEqual([system, user, messages.length], [SYSTEM_PROMPT, request(wire).input, wire.wire === 'anthropic' ? 1 : 2]);
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
      for (const bad of [request(wire, { model: 'not a model' }), request(wire, { maxTokens: 1_501 }), request(wire, { effort: 'high' as 'low' })])
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

    test('comparison: the same structured request and parsing, usage kept for malformed answers, errors without bodies', async () => {
      const answer = { outcome: { kind: 'comparison', fact: 'Camera A missed gestures at 5 lux.', interpretation: 'A second sensor may help.',
        suggestedAction: 'Test another sensor.', citations: [{ type: 'result', id: source.id, version: 1 }] } };
      await script(wire.wire, { text: JSON.stringify(answer), usage: { input: 300, output: 90 } });
      const result = await comparison().createMessage({ ...comparisonInput(wire), maxTokens: 1_200, effort: 'low' });
      assert.deepEqual(result, { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 90 }, answer: answer.outcome });
      const body = (await sent(wire.wire)).at(-1)!.body as Record<string, unknown>;
      assert.equal(body[wire.maxTokensField], 1_200);
      assert.equal(body.tools, undefined);
      const schema = wire.wire === 'anthropic' ? (body.output_config as { format: { schema: unknown } }).format.schema
        : (body.response_format as { json_schema: { schema: unknown; strict: boolean } }).json_schema.schema;
      assert.deepEqual((schema as { required: string[] }).required, ['outcome'], 'the answer schema rides the wire format\'s structured-output field');
      assert.ok(JSON.stringify(body).includes(source.text));
      await script(wire.wire, { mode: 'truncated', text: '{"outcome":' });
      const truncated = await comparison().createMessage({ ...comparisonInput(wire), maxTokens: 1_200, effort: 'low' });
      assert.deepEqual([truncated.stopReason, truncated.answer, truncated.usage.inputTokens], ['max_tokens', null, 1_200]);
      await script(wire.wire, { mode: 'refusal' });
      const refused = await comparison().createMessage({ ...comparisonInput(wire), maxTokens: 1_200, effort: 'low' });
      assert.deepEqual([refused.stopReason, refused.answer], ['refusal', null]);
      await script(wire.wire, { text: `invalid JSON with ${wire.key}` });
      const malformed = await comparison().createMessage({ ...comparisonInput(wire), maxTokens: 1_200, effort: 'low' });
      assert.deepEqual([malformed.answer, malformed.usage.inputTokens], [null, 1_200]);
      assert.equal(JSON.stringify(malformed).includes(wire.key), false);
      await control('/__reset', {});
      await script(wire.wire, { mode: 'status', status: 503 });
      await assert.rejects(comparison().createMessage({ ...comparisonInput(wire), maxTokens: 1_200, effort: 'low' }),
        (error: Error) => !error.message.includes(wire.key) && !String(error.stack).includes(wire.key));
      assert.equal((await sent(wire.wire)).length, 1, 'no automatic retry');
    });

    test('comparison: a refused endpoint is a request that was never sent', async () => {
      const refusedInput = { ...comparisonInput(wire), baseUrl: wire.connectionBaseUrl ? 'https://169.254.169.254/v1' : null };
      const provider = wire.connectionBaseUrl ? comparison() : providerComparison({ policy, baseUrls: { anthropic: 'https://169.254.169.254' } });
      await assert.rejects(provider.createMessage({ ...refusedInput, maxTokens: 1_200, effort: 'low' }), ComparisonNotSentError);
      assert.equal((await sent()).length, 0);
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
    const openAiWire = { ...openai('openai'), key: `sk-proj-${'owner-budget-key-'.repeat(3)}OA01` };
    await personal(openAiWire).dispatch(request(openAiWire, { model: 'gpt-model' }), new AbortController().signal);
    const body = (await sent('openai'))[0]!.body as Record<string, unknown>;
    assert.equal(body.max_completion_tokens, 1_500, 'OpenAI\'s field includes reasoning tokens');
    assert.equal(body.max_tokens, undefined);
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
