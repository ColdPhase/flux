import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, test } from 'node:test';
import { listPrice, OPENROUTER_WEB_PLUGIN, providerPriceList, WEB_SEARCH_MICROS, webSearchMicros, type AiPrice } from '@flux/contracts';
import { keySearchHoldMicros, KEY_SEARCH_LIMITS, KEY_SEARCH_SYSTEM, keySearchOffered, searchWithKey, shippedPriceList, type KeySearchMeter, type PersonalConnection } from '@flux/core';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';

// `flux_web_search` (#1441, RT-5) through the REAL provider adapters against the provider mock (security review of #1453, P2-1 and P2-2):
// the one search request goes out with the hosted search and no other tool, bounded to KEY_SEARCH_LIMITS.searches searches (Anthropic
// `max_uses`, OpenAI Responses `max_tool_calls`); its hold is that bound; what the provider reported is charged as it is; a request that
// is never sent, or a complete error answer, is charged nothing. The meter is a stand-in that records the hold and the charge.

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const KEY = `sk-ant-api03-${'k'.repeat(40)}`;
const compute = providerPersonalCompute({ enabled: true, resolveKey: async () => KEY, policy: parsePrivateTargets(new URL(MOCK).hostname), timeoutMs: 5_000,
  baseUrls: { anthropic: `${MOCK}/anthropic`, openai: `${MOCK}/openai/v1`, openrouter: `${MOCK}/openai/v1`, gemini: `${MOCK}/gemini/v1beta/openai` }, webSearch: true });
const control = async (path: string, body?: unknown) => {
  const response = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.json() as Promise<{ requests?: { path: string; key: string | null; body: Record<string, unknown> }[] }>;
};

function meter() {
  const seen = { held: [] as number[], settled: [] as { held: number; charged: number }[] };
  const port: KeySearchMeter = {
    async hold(_runId, _connection, micros, budgetMicros) { seen.held.push(micros); return micros <= budgetMicros; },
    async settle(_runId, held, charged) { seen.settled.push({ held, charged }); },
  };
  return { seen, port };
}

function connection(provider: PersonalConnection['provider'], model: string, given?: AiPrice): PersonalConnection {
  // The model at the price list this release ships (#1465).
  const price = given ?? listPrice(providerPriceList(shippedPriceList(), provider), model)!;
  return { id: randomUUID(), ownerUserId: randomUUID(), status: 'active', keyRef: 'ref', name: 'Key', provider, model, baseUrl: null, dailyBudgetCents: 1_000,
    timeZone: 'UTC', price };
}

describe('flux_web_search through the real adapters (#1441, security review of #1453)', () => {
  beforeEach(async () => { await control('/__reset', {}); });

  for (const [wire, provider, model] of [['anthropic', 'anthropic', 'claude-sonnet-5'], ['openai', 'openai', 'gpt-6.1-sol']] as const) {
    test(`${provider}: one request with the hosted search alone and its bound, held for that bound and charged what the provider reported`, async () => {
      const key = connection(provider, model);
      await control('/__script', { wire, mode: 'success', text: 'Result one, https://example.org/a', usage: { input: 2_000, output: 300 },
        search: { query: 'lux sensors', results: ['https://example.org/a', 'https://example.org/b'], cite: 'https://example.org/a' } });
      const { seen, port } = meter();
      const outcome = await searchWithKey(compute, port, randomUUID(), key, 'lux sensors');
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      const sent = (await control('/__requests')).requests!.filter((request) => !request.path.startsWith('/__'));
      assert.equal(sent.length, 1, 'one request reached the provider');
      const tools = sent[0]!.body.tools as Record<string, unknown>[];
      assert.equal(tools.length, 1, 'the search alone, no other tool');
      if (provider === 'anthropic') assert.deepEqual(tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: KEY_SEARCH_LIMITS.searches });
      else {
        assert.equal(tools[0]!.type, 'web_search');
        assert.equal(sent[0]!.body.max_tool_calls, KEY_SEARCH_LIMITS.searches);
      }
      const hold = keySearchHoldMicros(key)!;
      assert.deepEqual(seen.held, [hold]);
      assert.ok(hold >= KEY_SEARCH_LIMITS.searches * WEB_SEARCH_MICROS, 'the hold covers every search the request may make');
      // 2,000 in and 300 out at the table price, and the one search the mock reports.
      const expected = Math.ceil((2_000 * key.price!.inputMicrosPerMTok + 300 * key.price!.outputMicrosPerMTok) / 1_000_000) + WEB_SEARCH_MICROS;
      assert.deepEqual(seen.settled, [{ held: hold, charged: expected }], 'charged what was reported, not the hold');
      assert.ok(outcome.ok && outcome.found.results.includes('https://example.org/a'));
    });
  }

  test('an error answer the adapter cannot show was free keeps its hold; one out of credits is charged nothing', async () => {
    await control('/__script', { wire: 'anthropic', mode: 'status', status: 500 });
    const first = meter();
    const key = connection('anthropic', 'claude-sonnet-5');
    assert.equal((await searchWithKey(compute, first.port, randomUUID(), key, 'lux sensors')).ok, false);
    assert.deepEqual(first.seen.settled, [{ held: keySearchHoldMicros(key)!, charged: keySearchHoldMicros(key)! }]);
    await control('/__script', { wire: 'anthropic', mode: 'status', status: 400, errorMessage: 'Your credit balance is too low to access the Anthropic API.' });
    const second = meter();
    assert.equal((await searchWithKey(compute, second.port, randomUUID(), key, 'lux sensors')).ok, false);
    assert.equal(second.seen.settled[0]?.charged, 0);
  });

  test('a request that is never sent (the key cannot be opened) is charged nothing', async () => {
    const { seen, port } = meter();
    const locked = providerPersonalCompute({ enabled: true, resolveKey: async () => null, policy: parsePrivateTargets(new URL(MOCK).hostname), timeoutMs: 5_000,
      baseUrls: { anthropic: `${MOCK}/anthropic` }, webSearch: true });
    const outcome = await searchWithKey(locked, port, randomUUID(), connection('anthropic', 'claude-sonnet-5'), 'lux sensors');
    assert.equal(outcome.ok, false);
    assert.equal((await control('/__requests')).requests!.filter((request) => !request.path.startsWith('/__')).length, 0, 'nothing reached the provider');
    assert.deepEqual(seen.settled.map((entry) => entry.charged), [0]);
  });
});

// #1585 (C-72): Gemini searches with Google Search grounding on its own `generateContent` API, OpenRouter with its `web` plugin on the Exa
// engine. The same contract as Anthropic's and OpenAI's above: the search alone on the run's key, nothing of Flux's but its own instruction
// and the agent's query (C-30), the sources back with the answer, the hold and the charge at the provider's own search fee.
describe('flux_web_search on Gemini and OpenRouter keys (#1585, C-72; Docker mock of the documented shapes, no provider pass)', () => {
  const sent = async () => (await control('/__requests')).requests!.filter((request) => !request.path.startsWith('/__'));
  const SEARCH = { query: 'lux sensors', results: ['https://example.org/a', 'https://example.org/b'], cite: 'https://example.org/b' };
  const tokensAt = (price: AiPrice, input: number, output: number) => Math.ceil((input * price.inputMicrosPerMTok + output * price.outputMicrosPerMTok) / 1_000_000);
  beforeEach(async () => { await control('/__reset', {}); });

  for (const [model, perPrompt] of [['gemini-3.8-flash', false], ['gemini-2.5-flash', true]] as const) {
    test(`Gemini ${model}: Google Search grounding alone on Gemini's own API, the sources come back, and ${perPrompt ? 'the grounded prompt' : 'each query'} is charged at Google's fee`, async () => {
      const key = connection('gemini', model);
      await control('/__script', { wire: 'gemini', mode: 'success', text: 'Result two says sensors fail below 5 lux.', usage: { input: 2_000, output: 300 }, search: SEARCH });
      const { seen, port } = meter();
      const outcome = await searchWithKey(compute, port, randomUUID(), key, 'lux sensors');
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      const requests = await sent();
      assert.equal(requests.length, 1, 'one request reached the provider');
      assert.equal(requests[0]!.path, `/gemini/v1beta/models/${model}:generateContent`, 'Gemini\'s own API, beside the compatible endpoint the key\'s runs use');
      assert.equal(requests[0]!.key, KEY, 'the key in x-goog-api-key');
      assert.deepEqual(requests[0]!.body, {
        systemInstruction: { parts: [{ text: KEY_SEARCH_SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: 'Search the web for: lux sensors' }] }],
        tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: KEY_SEARCH_LIMITS.maxTokens },
      }, 'the search tool alone, Flux\'s own instruction and the agent\'s query: nothing else of the run (C-30)');
      assert.ok(outcome.ok);
      assert.equal(outcome.text, 'Result two says sensors fail below 5 lux.', 'the answer, without the model\'s thinking');
      assert.deepEqual(outcome.found, { queries: ['lux sensors', 'lux sensors 2026'], results: SEARCH.results, cited: [SEARCH.cite] }, 'what it searched and found, to list');
      const fee = perPrompt ? 35_000 : 14_000;
      assert.equal(webSearchMicros('gemini', model), fee);
      const hold = keySearchHoldMicros(key)!;
      assert.deepEqual(seen.held, [hold]);
      assert.ok(hold >= KEY_SEARCH_LIMITS.searches * fee, 'the hold covers the searches at Google\'s fee');
      // The search results Google gave the model (500) are input, the thinking (40) output; two queries, or one grounded prompt.
      assert.deepEqual(seen.settled, [{ held: hold, charged: tokensAt(key.price!, 2_500, 340) + (perPrompt ? 1 : 2) * fee }]);
    });
  }

  test('OpenRouter: the web plugin on Exa alone, the cited sources come back, and the larger of OpenRouter\'s reported cost and the counted one is charged', async () => {
    const price: AiPrice = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, source: 'owner', checkedOn: '2026-11-20' };
    const key = connection('openrouter', 'anthropic/claude-sonnet-5', price);
    const counted = tokensAt(price, 2_000, 300) + 7_000;
    for (const [cost, charged] of [[null, counted], [0.05, 50_000], [0.001, counted]] as const) {
      await control('/__reset', {});
      await control('/__script', { wire: 'openai', mode: 'success', text: 'Sensors fail below 5 lux.', usage: { input: 2_000, output: 300 }, cost, search: SEARCH });
      const { seen, port } = meter();
      const outcome = await searchWithKey(compute, port, randomUUID(), key, 'lux sensors');
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      const requests = await sent();
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.path, '/openai/v1/chat/completions');
      const body = requests[0]!.body as { plugins?: unknown; tools?: unknown; messages: unknown };
      assert.deepEqual(body.plugins, [OPENROUTER_WEB_PLUGIN], 'OpenRouter\'s web plugin on Exa, five results');
      assert.equal(body.tools, undefined, 'and no other tool');
      assert.deepEqual(body.messages, [{ role: 'system', content: KEY_SEARCH_SYSTEM }, { role: 'user', content: 'Search the web for: lux sensors' }],
        'Flux\'s own instruction and the agent\'s query: nothing else of the run (C-30)');
      assert.ok(outcome.ok);
      assert.deepEqual(outcome.found, { queries: ['lux sensors'], results: SEARCH.results, cited: SEARCH.results }, 'the plugin\'s sources, and the agent\'s query as what it searched');
      const hold = keySearchHoldMicros(key)!;
      assert.ok(hold >= KEY_SEARCH_LIMITS.searches * 7_000);
      assert.deepEqual(seen.settled, [{ held: hold, charged }], `reported ${cost}`);
    }
  });

  test('FLUX_WEB_READS=off gives no Gemini or OpenRouter key the search; an endpoint of the owner\'s own never has one, and nothing is sent for it', async () => {
    for (const [provider, model] of [['gemini', 'gemini-3.8-flash'], ['openrouter', 'vendor/model']] as const) {
      assert.equal(keySearchOffered(provider, model, true), true, `${provider}: offered with the web on`);
      assert.equal(keySearchOffered(provider, model, false), false, `${provider}: not with FLUX_WEB_READS=off`);
    }
    assert.equal(keySearchOffered('openai_compatible', 'llama3.1:8b', true), false);
    const own = { ...connection('openai_compatible', 'llama3.1:8b', { inputMicrosPerMTok: 0, outputMicrosPerMTok: 0, source: 'owner', checkedOn: '2026-11-20' }), baseUrl: `${MOCK}/openai/v1` };
    const { seen, port } = meter();
    assert.deepEqual(await searchWithKey(compute, port, randomUUID(), own, 'lux sensors'), { ok: false, reason: 'no_search' });
    assert.deepEqual([seen.held, (await sent()).length], [[], 0]);
  });

  test('Gemini\'s and OpenRouter\'s search never goes beside the Flux tools: such a request is refused before it is sent', async () => {
    for (const provider of ['gemini', 'openrouter'] as const) {
      const result = await compute.dispatch({ connection: { id: 'c', keyRef: 'ref', provider, baseUrl: null }, model: provider === 'gemini' ? 'gemini-3.8-flash' : 'vendor/model',
        maxTokens: 1_500, effort: 'low', system: 's', input: 'u', webSearch: true,
        tools: [{ name: 'flux_search', description: 'Search Flux', inputSchema: { type: 'object', properties: {} } }] }, new AbortController().signal);
      assert.deepEqual(result, { kind: 'failed', reason: 'provider_error', billed: 'none' }, provider);
    }
    assert.equal((await sent()).length, 0);
  });
});
