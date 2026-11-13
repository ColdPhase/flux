import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { AI_PRICE_LIST_PROVIDERS, AI_PRICE_MAX_MICROS_PER_MTOK, assistantApiPrice, currentConnectionPrice, listPrice, type AiPrice, type AiPriceList } from '@flux/contracts';
import { isPriceList, parsePriceList, PRICE_LIST_LARGEST_PROMPT_TOKENS, shippedPriceList } from '@flux/core';
import { aiPriceListRepository, storedPriceList, storedProviderPriceList } from '@flux/db';
import { fetchPriceList, parsePrivateTargets, PUBLIC_ONLY } from '../../packages/agent-runtime/src/index.js';
import { db } from './support/db.js';

// Flux's price list (#1465): LiteLLM's model price file turned into Flux's prices, the daily fetch through the egress guard with its
// bounds, the stored list that only a newer good list replaces, and a connection that runs at the list's price of today.

/** A small file of LiteLLM's shape: one entry of each case the parser decides. */
const FILE = {
  sample_spec: { litellm_provider: 'one of …', mode: 'one of …', input_cost_per_token: 0, output_cost_per_token: 0 },
  'claude-sonnet-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2e-7 },
  // A tier below Flux's largest request (114,000 tokens) is the price; one above it is not.
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
  test('only Anthropic\'s, OpenAI\'s and Gemini\'s text models with sane prices, at the tier Flux\'s largest request reaches', () => {
    assert.equal(PRICE_LIST_LARGEST_PROMPT_TOKENS, 114_000);
    const list = parsePriceList(FILE, '2026-11-13', 'https://example.test/prices.json');
    assert.deepEqual(list, {
      fetchedOn: '2026-11-13', source: 'https://example.test/prices.json',
      prices: {
        anthropic: { 'claude-haiku-5-5': price(500_000, 2_500_000), 'claude-sonnet-5': price(2_000_000, 10_000_000) },
        openai: { 'gpt-5-pro': price(15_000_000, 120_000_000), 'gpt-6.1-sol': price(2_000_000, 10_000_000), 'gpt-free': price(0, 0) },
        gemini: { 'gemini-3.1-pro-preview': price(2_000_000, 12_000_000) },
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
      { ...good, prices: { openrouter: { 'vendor/model': price(1, 1) } } },
    ]) assert.equal(isPriceList(bad), false, JSON.stringify(bad));
  });

  test('the release ships a list fetched on its build day, with every provider of the list', () => {
    const shipped = shippedPriceList();
    assert.ok(isPriceList(shipped));
    assert.match(shipped.fetchedOn, /^\d{4}-\d{2}-\d{2}$/);
    for (const provider of AI_PRICE_LIST_PROVIDERS) assert.ok(Object.keys(shipped.prices[provider] ?? {}).length > 0, provider);
    assert.equal(shipped.prices.openrouter, undefined, 'OpenRouter\'s models are priced by their owner');
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
  test('the migrator stored the shipped list; a newer good list replaces it, an older one never does', async () => {
    const stored = await storedPriceList(db);
    assert.ok(stored && isPriceList(stored));
    assert.ok(stored.fetchedOn >= shippedPriceList().fetchedOn, 'the shipped list or a newer one');
    await rolledBack(async (tx) => {
      const store = aiPriceListRepository(tx);
      const next: AiPriceList = { fetchedOn: '2099-01-02', source: 'test', prices: { anthropic: { 'claude-sonnet-5': price(3_000_000, 15_000_000) }, openai: {}, gemini: {} } };
      assert.equal(await store.store(next), true);
      assert.deepEqual(await storedProviderPriceList(tx, 'anthropic'), { fetchedOn: '2099-01-02', prices: { 'claude-sonnet-5': price(3_000_000, 15_000_000) } });
      assert.deepEqual(await storedProviderPriceList(tx, 'openrouter'), { fetchedOn: '2099-01-02', prices: {} });
      // The shipped list of an older release, stored again by its migrator, keeps the newer one; so does a list of an earlier day.
      assert.equal(await store.store(shippedPriceList(), 'keep'), false);
      assert.equal(await store.store({ ...next, fetchedOn: '2099-01-01' }), false);
      assert.equal((await store.read())?.fetchedOn, '2099-01-02');
      // The same day's list replaces it when fetched, and is kept when only shipped.
      assert.equal(await store.store({ ...next, source: 'again' }, 'keep'), false);
      assert.equal(await store.store({ ...next, source: 'again' }), true);
      assert.equal((await store.read())?.source, 'again');
    });
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
