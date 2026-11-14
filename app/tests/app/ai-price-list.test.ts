import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { AI_PRICE_LIST_PROVIDERS, AI_PRICE_MAX_MICROS_PER_MTOK, assistantApiPrice, currentConnectionPrice, listPrice, maxRequestMicros, rateAt, type AiPrice,
  type AiPriceList, type AiRate } from '@flux/contracts';
import { boundedUsageMicros, gatewayChargeMicros, gatewayHoldMicros, isPriceList, openRouterPriceList, parsePriceList, runReservationMicros, shippedPriceList,
  usageMicros } from '@flux/core';
import { aiPriceListRepository, storedPriceLists, storedProviderPriceList } from '@flux/db';
import { fetchPriceList, parsePrivateTargets, PUBLIC_ONLY } from '../../packages/agent-runtime/src/index.js';
import { db } from './support/db.js';

// The price lists (#1465): LiteLLM's model price file and OpenRouter's own model list turned into Flux's prices with their long-prompt
// tiers, the daily fetch through the egress guard with its bounds, the stored lists that only a newer good list replaces, a connection
// that runs at the list's price of today, and a request reserved and charged at the tier its prompt falls in.

/** A small file of LiteLLM's shape: one entry of each case the parser decides. */
const FILE = {
  sample_spec: { litellm_provider: 'one of …', mode: 'one of …', input_cost_per_token: 0, output_cost_per_token: 0 },
  'claude-sonnet-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2e-7 },
  // Long-prompt tiers are kept with the price; batch, flex and priority fields are not read.
  'claude-haiku-5-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 1e-7, output_cost_per_token: 5e-7,
    input_cost_per_token_above_100k_tokens: 5e-7, output_cost_per_token_above_100k_tokens: 2.5e-6, input_cost_per_token_above_100k_tokens_batches: 9e-5 },
  'gpt-6.1-sol': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5,
    input_cost_per_token_above_272k_tokens: 4e-6, output_cost_per_token_above_272k_tokens: 1.5e-5, input_cost_per_token_priority: 9e-5 },
  'gpt-5-pro': { litellm_provider: 'openai', mode: 'responses', input_cost_per_token: 1.5e-5, output_cost_per_token: 1.2e-4 },
  'gpt-image-2': { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_token: 5e-6, output_cost_per_token: 4e-5 },
  'gemini/gemini-3.1-pro-preview': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5,
    input_cost_per_token_above_200k_tokens: 4e-6, output_cost_per_token_above_200k_tokens: 1.8e-5 },
  // Not Flux's: another provider's entry, a Vertex id under a Gemini provider, and values that are not sane prices.
  'openrouter/anthropic/claude-opus-5.5': { litellm_provider: 'openrouter', mode: 'chat', input_cost_per_token: 4e-6, output_cost_per_token: 2e-5 },
  'gemini-2.5-pro': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
  'gpt-negative': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: -1e-6, output_cost_per_token: 1e-5 },
  'gpt-string': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: '0.000002', output_cost_per_token: 1e-5 },
  'gpt-too-dear': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 2e-3, output_cost_per_token: 1e-5 },
  'gpt-bad-tier': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-5, input_cost_per_token_above_8k_tokens: 'x' },
  'gpt with space': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 },
  'gpt-free': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 0, output_cost_per_token: 0 },
};
const price = (inputMicrosPerMTok: number, outputMicrosPerMTok: number) => ({ inputMicrosPerMTok, outputMicrosPerMTok });

describe('reading LiteLLM\'s price file (#1465)', () => {
  test('only Anthropic\'s, OpenAI\'s and Gemini\'s text models with sane prices, with their long-prompt tiers', () => {
    const list = parsePriceList(FILE, '2026-11-13', 'https://example.test/prices.json');
    assert.deepEqual(list, {
      fetchedOn: '2026-11-13', source: 'https://example.test/prices.json',
      prices: {
        anthropic: {
          'claude-haiku-5-5': { ...price(100_000, 500_000), tiers: [{ fromTokens: 100_001, ...price(500_000, 2_500_000) }] },
          'claude-sonnet-5': price(2_000_000, 10_000_000),
        },
        openai: {
          'gpt-5-pro': price(15_000_000, 120_000_000),
          'gpt-6.1-sol': { ...price(2_000_000, 10_000_000), tiers: [{ fromTokens: 272_001, ...price(4_000_000, 15_000_000) }] },
          'gpt-free': price(0, 0),
        },
        gemini: { 'gemini-3.1-pro-preview': { ...price(2_000_000, 12_000_000), tiers: [{ fromTokens: 200_001, ...price(4_000_000, 18_000_000) }] } },
      },
    });
    assert.ok(isPriceList(list));
  });

  test('a file that is not one is refused whole, so the last good list stays', () => {
    assert.equal(parsePriceList(null, '2026-11-13'), null);
    assert.equal(parsePriceList([FILE], '2026-11-13'), null);
    assert.equal(parsePriceList('{}', '2026-11-13'), null);
    assert.equal(parsePriceList(FILE, '13 Nov 2026'), null);
    // A provider missing altogether is a truncated or replaced file, not a list without that provider.
    const withoutGemini = Object.fromEntries(Object.entries(FILE).filter(([, entry]) => entry.litellm_provider !== 'gemini'));
    assert.equal(parsePriceList(withoutGemini, '2026-11-13'), null);
  });

  test('a stored list is checked again: prices within bounds, ids Flux accepts, only the listed providers', () => {
    const good: AiPriceList = { fetchedOn: '2026-11-13', source: 'x', prices: { openai: { 'gpt-6.1-sol': price(2_000_000, 10_000_000) } } };
    assert.ok(isPriceList(good));
    for (const bad of [
      { ...good, fetchedOn: 'today' },
      { ...good, prices: { openai: { 'gpt-6.1-sol': price(-1, 10) } } },
      { ...good, prices: { openai: { 'gpt-6.1-sol': price(AI_PRICE_MAX_MICROS_PER_MTOK + 1, 10) } } },
      { ...good, prices: { openai: { 'gpt-6.1-sol': price(1.5, 10) } } },
      { ...good, prices: { openai: { 'bad id': price(1, 1) } } },
      { ...good, prices: { openai_compatible: { 'llama3.1:8b': price(1, 1) } } },
      { ...good, prices: { openai: { 'gpt-6.1-sol': { ...price(1, 1), tiers: [{ fromTokens: 0, ...price(1, 1) }] } } } },
      { ...good, prices: { openai: { 'gpt-6.1-sol': { ...price(1, 1), tiers: [{ fromTokens: 10, ...price(-1, 1) }] } } } },
    ]) assert.equal(isPriceList(bad), false, JSON.stringify(bad));
  });

  test('the release ships a list fetched on its build day, with every provider of the list', () => {
    const shipped = shippedPriceList();
    assert.ok(isPriceList(shipped));
    assert.match(shipped.fetchedOn, /^\d{4}-\d{2}-\d{2}$/);
    for (const provider of AI_PRICE_LIST_PROVIDERS) assert.ok(Object.keys(shipped.prices[provider] ?? {}).length > 0, provider);
    assert.equal(shipped.prices.openrouter, undefined, 'OpenRouter\'s prices come from OpenRouter, read while someone has a key');
    assert.deepEqual(shipped.prices.anthropic?.['claude-haiku-5-5']?.tiers?.[0]?.fromTokens, 100_001, 'Claude Haiku 5.5 over 100,000 tokens');
  });
});

describe('the daily fetch (#1465)', () => {
  let server: Server;
  let origin = '';
  const answers: Record<string, { status: number; body: string }> = {};
  before(async () => {
    server = createServer((request, response) => {
      const answer = answers[request.url ?? ''] ?? { status: 404, body: '' };
      response.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const local = { policy: parsePrivateTargets('127.0.0.1'), now: () => new Date('2026-11-14T04:17:00Z') };

  test('a good file becomes the day\'s list; a failure, an oversized or malformed answer says why and gives none', async () => {
    answers['/ok'] = { status: 200, body: JSON.stringify(FILE) };
    answers['/down'] = { status: 503, body: '{}' };
    answers['/html'] = { status: 200, body: '<html>' };
    answers['/empty'] = { status: 200, body: '{}' };
    answers['/big'] = { status: 200, body: JSON.stringify({ ...FILE, padding: 'x'.repeat(4_000) }) };
    const ok = await fetchPriceList({ ...local, url: `${origin}/ok` });
    assert.ok(ok.ok);
    assert.equal(ok.list.fetchedOn, '2026-11-14');
    assert.deepEqual(ok.list.prices.anthropic?.['claude-sonnet-5'], price(2_000_000, 10_000_000));
    assert.deepEqual(await fetchPriceList({ ...local, url: `${origin}/down` }), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await fetchPriceList({ ...local, url: `${origin}/missing` }), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await fetchPriceList({ ...local, url: `${origin}/html` }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await fetchPriceList({ ...local, url: `${origin}/empty` }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await fetchPriceList({ ...local, url: `${origin}/big`, maxResponseBytes: 3_000 }), { ok: false, reason: 'too_large' });
  });

  test('the egress guard applies: a private address is refused unless the operator allows it', async () => {
    answers['/ok'] = { status: 200, body: JSON.stringify(FILE) };
    assert.deepEqual(await fetchPriceList({ policy: PUBLIC_ONLY, url: `${origin}/ok` }), { ok: false, reason: 'refused' });
  });

  test('a slow answer ends at the time limit', async () => {
    const slow = createServer(() => undefined);
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/prices.json`;
      assert.deepEqual(await fetchPriceList({ ...local, url, timeoutMs: 300 }), { ok: false, reason: 'unavailable' });
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});

/** Runs `body` in a transaction that is always rolled back, so the stored list other tests read is never changed. */
async function rolledBack(body: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
  const done = new Error('rolled back');
  await assert.rejects(db.transaction(async (tx) => { await body(tx); throw done; }), (error) => error === done);
}

describe('the stored list (#1465)', () => {
  test('the migrator stored the shipped list; a newer good list replaces it, an older one never does; each list is kept apart', async () => {
    const stored = await aiPriceListRepository(db).read('litellm');
    assert.ok(stored && isPriceList(stored));
    assert.ok(stored.fetchedOn >= shippedPriceList().fetchedOn, 'the shipped list or a newer one');
    await rolledBack(async (tx) => {
      const store = aiPriceListRepository(tx);
      const next: AiPriceList = { fetchedOn: '2099-01-02', source: 'test', prices: { anthropic: { 'claude-sonnet-5': price(3_000_000, 15_000_000) }, openai: {}, gemini: {} } };
      assert.equal(await store.store('litellm', next), true);
      assert.deepEqual(await storedProviderPriceList(tx, 'anthropic'), { fetchedOn: '2099-01-02', prices: { 'claude-sonnet-5': price(3_000_000, 15_000_000) } });
      // The shipped list of an older release, stored again by its migrator, keeps the newer one; so does a list of an earlier day.
      assert.equal(await store.store('litellm', shippedPriceList(), 'keep'), false);
      assert.equal(await store.store('litellm', { ...next, fetchedOn: '2099-01-01' }), false);
      assert.equal((await store.read('litellm'))?.fetchedOn, '2099-01-02');
      // The same day's list replaces it when fetched, and is kept when only shipped.
      assert.equal(await store.store('litellm', { ...next, source: 'again' }, 'keep'), false);
      assert.equal(await store.store('litellm', { ...next, source: 'again' }), true);
      assert.equal((await store.read('litellm'))?.source, 'again');
      // OpenRouter's own list is a list of its own: storing it changes nothing of LiteLLM's.
      await store.store('openrouter', { fetchedOn: '2099-01-03', source: 'openrouter', prices: { openrouter: { 'vendor/model': price(1, 2) } } });
      const lists = await storedPriceLists(tx);
      assert.deepEqual(lists.openrouter, { fetchedOn: '2099-01-03', prices: { 'vendor/model': price(1, 2) } });
      assert.equal(lists.anthropic?.fetchedOn, '2099-01-02');
      assert.equal(await storedProviderPriceList(tx, 'openai_compatible'), null);
    });
  });
});

describe('OpenRouter\'s prices are what an OpenRouter key pays (#1465)', () => {
  test('its model list, read without a key, becomes its price list: listed prices with their long-prompt overrides; a variable one is none', () => {
    const list = openRouterPriceList({ provider: 'openrouter', status: 'listed', checkedOn: '2026-11-13', models: [
      { id: 'vendor/priced-model', family: 'vendor', price: price(3_000_000, 15_000_000) },
      { id: 'vendor/long-model', family: 'vendor', price: { ...price(2_000_000, 10_000_000), tiers: [{ fromTokens: 200_000, ...price(4_000_000, 18_000_000) }] } },
      { id: 'openrouter/auto', family: 'openrouter', price: null },
    ] });
    assert.deepEqual(list?.prices, { openrouter: {
      'vendor/long-model': { ...price(2_000_000, 10_000_000), tiers: [{ fromTokens: 200_000, ...price(4_000_000, 18_000_000) }] },
      'vendor/priced-model': price(3_000_000, 15_000_000),
    } });
    assert.equal(list?.fetchedOn, '2026-11-13');
    assert.equal(openRouterPriceList({ provider: 'openrouter', status: 'unavailable', checkedOn: '2026-11-13', models: [] }), null);
    assert.equal(openRouterPriceList({ provider: 'openai_compatible', status: 'listed', checkedOn: '2026-11-13', models: [{ id: 'x', family: 'x', price: price(1, 1) }] }), null);
  });
});

describe('a request is reserved and charged at the tier its prompt falls in (#1465)', () => {
  // Gemini 3.1 Pro: $2 / $12, and $4 / $18 for a prompt over 200,000 tokens.
  const pro: AiRate = { ...price(2_000_000, 12_000_000), tiers: [{ fromTokens: 200_001, ...price(4_000_000, 18_000_000) }] };

  test('the tier is the highest the prompt reaches, never below the base', () => {
    assert.deepEqual(rateAt(pro, 200_000), price(2_000_000, 12_000_000));
    assert.deepEqual(rateAt(pro, 200_001), price(4_000_000, 18_000_000));
    assert.deepEqual(rateAt({ ...price(5, 5), tiers: [{ fromTokens: 10, ...price(1, 9) }] }, 10), price(5, 9), 'a lower tier price never lowers it');
    assert.equal(maxRequestMicros(pro, 100_000, 1_000), 200_000 + 12_000);
    assert.equal(maxRequestMicros(pro, 300_000, 1_000), 1_200_000 + 18_000);
  });

  test('a server run reserves its largest request (114,000 tokens) at Claude Haiku 5.5\'s over-100k price and charges a short one at the base', () => {
    const haiku: AiRate = { ...price(100_000, 500_000), tiers: [{ fromTokens: 100_001, ...price(500_000, 2_500_000) }] };
    assert.equal(runReservationMicros(haiku, true, true), Math.ceil((114_000 * 500_000 + 4_000 * 2_500_000) / 1_000_000));
    assert.equal(usageMicros(haiku, { inputTokens: 20_000, outputTokens: 1_000 }), 2_000 + 500);
    assert.equal(usageMicros(haiku, { inputTokens: 110_000, outputTokens: 1_000 }), 55_000 + 2_500);
    // A cache read lowers what is billed, not the prompt's length: a 110,000-token prompt read from the cache is still over 100,000.
    assert.equal(usageMicros(haiku, { inputTokens: 110_000, outputTokens: 0, cache: { readTokens: 100_000, writeTokens: 0, readRate: 0.1, writeRate: 1.25 } }),
      Math.ceil((10_000 + 10_000) * 500_000 / 1_000_000));
    assert.equal(boundedUsageMicros(haiku, { inputTokens: 110_000, outputTokens: 1_000 }, { maxInputTokens: 114_000, maxOutputTokens: 4_000, reservedMicros: 57_500 }), 57_500);
  });

  test('the gateway holds a long request at its tier and settles by the reported usage', () => {
    const request = { inputBoundTokens: 300_000, maxOutputTokens: 10_000, cacheAsked: false };
    const hold = gatewayHoldMicros(pro, 'gemini', request);
    assert.equal(hold, 1_200_000 + 180_000, 'a request that may be 300,000 tokens is held at the over-200k price');
    assert.deepEqual(gatewayChargeMicros(pro, 'gemini', request, hold, { inputTokens: 250_000, outputTokens: 1_000 }), { micros: 1_000_000 + 18_000, known: true });
    assert.deepEqual(gatewayChargeMicros(pro, 'gemini', request, hold, { inputTokens: 50_000, outputTokens: 1_000 }), { micros: 100_000 + 12_000, known: true },
      'a short one is charged at the base price');
  });
});

describe('a connection runs at today\'s list price (#1465)', () => {
  const list = { fetchedOn: '2026-11-14', prices: { 'claude-sonnet-5': price(3_000_000, 15_000_000) } };
  const stored = (source: 'list' | 'owner'): AiPrice => ({ ...price(2_000_000, 10_000_000), source, checkedOn: source === 'list' ? '2026-11-13' : null });

  test('the list\'s price of today wins; a model it no longer carries keeps the stored one; no list keeps it too', () => {
    assert.deepEqual(currentConnectionPrice(stored('list'), 'claude-sonnet-5', list), { ...price(3_000_000, 15_000_000), source: 'list', checkedOn: '2026-11-14' });
    assert.deepEqual(currentConnectionPrice(stored('owner'), 'claude-sonnet-5', list)?.source, 'list', 'once the list knows a model, its price is used');
    assert.deepEqual(currentConnectionPrice(stored('list'), 'claude-sonnet-4-5', list), stored('list'));
    assert.deepEqual(currentConnectionPrice(stored('owner'), 'local-model', null), stored('owner'));
    assert.equal(currentConnectionPrice(null, 'local-model', list), null, 'no price is never free');
  });

  test('another model of the key: the list\'s price, else its owner\'s, else none', () => {
    const owner = { 'my-model': price(1, 2) };
    assert.deepEqual(assistantApiPrice('claude-sonnet-5', owner, list), listPrice(list, 'claude-sonnet-5'));
    assert.deepEqual(assistantApiPrice('my-model', owner, list), { ...price(1, 2), source: 'owner', checkedOn: null });
    assert.equal(assistantApiPrice('other', owner, list), null);
    assert.equal(listPrice(list, 'constructor'), null, 'only the list\'s own models');
  });
});
