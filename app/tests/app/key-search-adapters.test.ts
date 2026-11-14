import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, test } from 'node:test';
import { listPrice, providerPriceList, WEB_SEARCH_MICROS } from '@flux/contracts';
import { keySearchHoldMicros, KEY_SEARCH_LIMITS, searchWithKey, shippedPriceList, type KeySearchMeter, type PersonalConnection } from '@flux/core';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';

// `flux_web_search` (#1441, RT-5) through the REAL provider adapters against the provider mock (security review of #1453, P2-1 and P2-2):
// the one search request goes out with the hosted search and no other tool, bounded to KEY_SEARCH_LIMITS.searches searches (Anthropic
// `max_uses`, OpenAI Responses `max_tool_calls`); its hold is that bound; what the provider reported is charged as it is; a request that
// is never sent, or a complete error answer, is charged nothing. The meter is a stand-in that records the hold and the charge.

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const KEY = `sk-ant-api03-${'k'.repeat(40)}`;
const compute = providerPersonalCompute({ enabled: true, resolveKey: async () => KEY, policy: parsePrivateTargets(new URL(MOCK).hostname), timeoutMs: 5_000,
  baseUrls: { anthropic: `${MOCK}/anthropic`, openai: `${MOCK}/openai/v1` }, webSearch: true });
const control = async (path: string, body?: unknown) => {
  const response = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.json() as Promise<{ requests?: { path: string; body: Record<string, unknown> }[] }>;
};

function meter() {
  const seen = { held: [] as number[], settled: [] as { held: number; charged: number }[] };
  const port: KeySearchMeter = {
    async hold(_runId, _connection, micros, budgetMicros) { seen.held.push(micros); return micros <= budgetMicros; },
    async settle(_runId, held, charged) { seen.settled.push({ held, charged }); },
  };
  return { seen, port };
}

function connection(provider: 'anthropic' | 'openai', model: string): PersonalConnection {
  // The model at the price list this release ships (#1465).
  const price = listPrice(providerPriceList(shippedPriceList(), provider), model)!;
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
      const hold = keySearchHoldMicros(key.price)!;
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
    assert.deepEqual(first.seen.settled, [{ held: keySearchHoldMicros(key.price)!, charged: keySearchHoldMicros(key.price)! }]);
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
