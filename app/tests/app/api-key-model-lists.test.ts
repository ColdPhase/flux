import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase, personalConnectionLookup } from '@flux/db';
import { createPersonalRunProcessor, type Principal } from '@flux/core';
import { AI_MODEL_LISTS_PATH, groupModelsByFamily, type AiModelList, type AssistantModelListing, type BackgroundComputeConnection, type Conversation } from '@flux/contracts';
import { listKeyModels, parsePrivateTargets, providerPersonalCompute, PUBLIC_ONLY } from '../../packages/agent-runtime/src/index.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { expectStatus, person, project, workspace, type Person } from './support/people.js';
import { chooseModel, FakeQueue } from './support/personal-runs.js';
import type { KeyListRequest } from './support/key-list-mock.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// An API key's models come from its provider, read with that key (CA-2, #1218), against the provider mock's key listings
// (`/lists/…`, FLUX_TEST_PROVIDER_LISTS): the listing and its failures, the key test before a save, the picker by family with prices,
// a model priced by its owner, a model the provider retired, Try again through the worker, and a run sent with the listed model id.
// The keys carry the marker check_application.sh looks for in the logs. No real provider is called.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const path = '/api/v1/background-compute-connections';
const marker = 'owner-budget-key-';
let serial = 0;
/** A fresh key per case, so the API's 6-hour list of one key never answers another case. */
const keyOf = (provider: 'anthropic' | 'openai' | 'gemini', tag = '') => {
  serial += 1;
  const tail = `${tag}${marker}${Date.now().toString(36)}${serial}`;
  return provider === 'anthropic' ? `sk-ant-api03-${tail}` : provider === 'openai' ? `sk-proj-${tail}` : `AIza${tail}-gemini-key-format`;
};
const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const lists = { policy: parsePrivateTargets(new URL(MOCK).hostname),
  baseUrls: { anthropic: `${MOCK}/lists/anthropic`, openai: `${MOCK}/lists/openai/v1`, gemini: `${MOCK}/lists/gemini/v1beta/openai` } };

async function keyLists(body?: unknown) {
  const response = await fetch(`${MOCK}/__key-lists`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await response.json()) as { requests: KeyListRequest[] }).requests;
}
async function providerRequests(body?: unknown, pathname = '/__requests') {
  const response = await fetch(`${MOCK}${pathname}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await response.json()) as { requests: RecordedProviderRequest[] }).requests;
}
const askedWith = async (key: string) => (await keyLists()).filter((item) => item.key === key);

describe('listing a key\'s models from its provider (#1218)', () => {
  test('Anthropic: the key\'s models with the provider\'s names, newest first, a retired model left out; the key only in its header', async () => {
    const key = keyOf('anthropic');
    const list = await listKeyModels('anthropic', key, lists);
    assert.equal(list.status, 'listed');
    assert.deepEqual(list.models.map((model) => model.id), ['claude-sonnet-5-7', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    assert.deepEqual(list.models.find((model) => model.id === 'claude-opus-5-5'), { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', family: 'Opus', createdAt: '2026-09-21T00:00:00.000Z', price: null });
    // By family, the family with the newest model first.
    assert.deepEqual(groupModelsByFamily(list.models).map((group) => [group.family, group.models.map((model) => model.id)]), [
      ['Sonnet', ['claude-sonnet-5-7', 'claude-sonnet-5-5', 'claude-sonnet-5']],
      ['Fable', ['claude-fable-5-2', 'claude-fable-5-1']],
      ['Opus', ['claude-opus-5-5']],
      ['Haiku', ['claude-haiku-4-5-20251001']],
    ]);
    const [asked] = await askedWith(key);
    assert.equal(asked!.path, '/lists/anthropic/v1/models?limit=1000');
    assert.equal(asked!.path.includes(key), false, 'the key never goes into the address');
    assert.equal(asked!.version, '2026-10-21', 'the API version the adapter sends (SDK 1.x), and the key as its bearer token: the mock only finds a bearer');
    assert.equal(JSON.stringify(list).includes(key), false);
  });

  test('OpenAI and Gemini: only their chat models; the same refusal and failures', async () => {
    const openai = await listKeyModels('openai', keyOf('openai'), lists);
    assert.deepEqual([openai.status, openai.models.map((model) => model.id)], ['listed', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-4o', 'o3']],
      'no embeddings, speech, realtime, images or a dated snapshot beside its alias');
    assert.deepEqual(openai.models.map((model) => model.family), ['Sol', 'Astra', 'Terra', 'Luna', 'GPT', 'o-series']);
    const gemini = await listKeyModels('gemini', keyOf('gemini'), lists);
    assert.deepEqual([gemini.status, gemini.models.map((model) => [model.id, model.name])], ['listed',
      [['gemini-4-carbon', 'Gemini 4 Carbon'], ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'], ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview']]],
      'Gemini gives no release date: the version in the id orders them, newest first');
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      assert.equal((await listKeyModels(provider, keyOf(provider, 'refused-'), lists)).status, 'key_refused', `${provider}: a refused key`);
      assert.equal((await listKeyModels(provider, keyOf(provider, 'broken-'), lists)).status, 'unavailable', `${provider}: a 5xx`);
      const slow = await listKeyModels(provider, keyOf(provider, 'slow-'), { ...lists, timeoutMs: 500 });
      assert.deepEqual([slow.status, slow.models], ['unavailable', []], `${provider}: a timeout`);
    }
    // The endpoint guard: a private address not allowed by the operator is never asked.
    assert.equal((await listKeyModels('anthropic', keyOf('anthropic'), { ...lists, policy: PUBLIC_ONLY })).status, 'refused');
  });

  test('the API: the key\'s list while it is typed, read once for 6 hours; a refused key, a timeout and a 5xx say so and echo nothing', async () => {
    const owner = await person('model-list-typed');
    const key = keyOf('anthropic');
    const first = expectStatus(await owner.browser.request('POST', AI_MODEL_LISTS_PATH, { body: { provider: 'anthropic', apiKey: key } }), 200) as AiModelList;
    assert.equal(first.status, 'listed');
    assert.ok(first.models.some((model) => model.id === 'claude-opus-5-5'), 'Opus is listed');
    // Flux's price list of the provider comes with it (#1465): the form prices a model with it, or asks its owner.
    assert.deepEqual(first.priceList?.prices['claude-opus-5-5'], { inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 20_000_000 });
    assert.match(first.priceList?.fetchedOn ?? '', /^\d{4}-\d{2}-\d{2}$/);
    const again = await owner.browser.request('POST', AI_MODEL_LISTS_PATH, { body: { provider: 'anthropic', apiKey: key } });
    assert.equal(again.text.includes(key), false);
    assert.equal((await askedWith(key)).length, 1, 'the second look and later the save use the same reading');
    expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: key, dailyBudgetCents: 500 } }), 201);
    assert.equal((await askedWith(key)).length, 1, 'the key\'s test and its list are one call');

    for (const [tag, status] of [['refused-', 'key_refused'], ['broken-', 'unavailable']] as const) {
      const bad = keyOf('openai', tag);
      const answer = await owner.browser.request('POST', AI_MODEL_LISTS_PATH, { body: { provider: 'openai', apiKey: bad } });
      assert.deepEqual([(answer.json as AiModelList).status, (answer.json as AiModelList).models], [status, []]);
      assert.equal(answer.text.includes(bad), false);
    }
    assert.equal((expectStatus(await owner.browser.request('POST', AI_MODEL_LISTS_PATH, { body: { provider: 'gemini', apiKey: keyOf('gemini', 'refused-') } }), 200) as AiModelList).status, 'key_refused');
    assert.equal((expectStatus(await owner.browser.request('POST', AI_MODEL_LISTS_PATH, { body: { provider: 'anthropic' } }), 200) as AiModelList).status, 'needs_key');
    assert.equal(codeOf(await owner.browser.request('POST', AI_MODEL_LISTS_PATH, { body: { provider: 'anthropic', apiKey: 'sk-proj-not-anthropic-key' } })), 'AI_KEY_FORMAT');
    // OpenAI-compatible endpoints keep their keyless `/models`.
    const compatible = expectStatus(await owner.browser.request('POST', AI_MODEL_LISTS_PATH, { body: { provider: 'openai_compatible', baseUrl: `${MOCK}/openai/v1` } }), 200) as AiModelList;
    assert.deepEqual(compatible.models.map((model) => model.id), ['llama3.1:8b', 'qwen2.5:7b-instruct']);
    assert.equal(compatible.priceList, null, 'Flux knows no price of an endpoint\'s models: their owner enters it');
  });
});

describe('a key, its models and its agents (#1218)', () => {
  let owner: Person;
  let agentId: string;
  let thread: Conversation;
  const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections: personalConnectionLookup(db), providerEnabled: true });

  before(async () => {
    owner = await person('model-list-owner');
    const ws = await workspace(owner, 'Listed models club');
    const place = await project(owner, ws.id, 'Lamp sensor listed', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });

  test('a key its provider refuses is not saved: "This key was refused by Anthropic"', async () => {
    const before = (expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[]).length;
    const refused = await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: keyOf('anthropic', 'refused-'), dailyBudgetCents: 500 } });
    assert.equal(refused.status, 400);
    assert.deepEqual([codeOf(refused), (refused.json as { error: string }).error], ['AI_KEY_REFUSED', 'This key was refused by Anthropic']);
    assert.equal((expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[]).length, before);
  });

  test('a key without a chosen model is refused with a 422 and nothing is saved or sent: Flux has no default model for a key', async () => {
    const before = (expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[]).length;
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      const apiKey = keyOf(provider);
      for (const model of [undefined, '']) {
        const refused = await owner.browser.request('POST', path, { body: { provider, apiKey, dailyBudgetCents: 500, ...(model === undefined ? {} : { model }) } });
        assert.equal(refused.status, 422, `${provider} ${JSON.stringify(model)}: ${refused.text}`);
        assert.equal(codeOf(refused), 'AI_MODEL_REQUIRED');
        assert.match((refused.json as { error: string }).error, /^Choose the model this key uses\./);
        assert.equal(refused.text.includes(apiKey), false);
      }
      assert.equal((await askedWith(apiKey)).length, 0, `${provider}: the key was never sent to its provider`);
    }
    assert.equal((expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[]).length, before);
  });

  test('the picker by family, newest first, with prices; Opus at once, an unpriced model after its owner enters a price; a run on Opus sends the listed id', async () => {
    const apiKey = keyOf('anthropic');
    const key = expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey, dailyBudgetCents: 500 } }), 201) as BackgroundComputeConnection;
    const group = (await runs.model(human(owner))).groups.find((item) => item.connection === key.id)!;
    assert.deepEqual(group.listing?.state, 'listed');
    assert.deepEqual(group.options.map((option) => [option.id, option.family, option.priced, option.note]), [
      ['claude-sonnet-5-7', 'Sonnet', false, 'Price unknown, enter it'],
      ['claude-sonnet-5-5', 'Sonnet', true, 'Input $2, output $10 per 1M tokens'],
      ['claude-sonnet-5', 'Sonnet', true, 'Input $2, output $10 per 1M tokens'],
      ['claude-fable-5-2', 'Fable', true, 'Input $8, output $40 per 1M tokens'],
      ['claude-fable-5-1', 'Fable', true, 'Input $10, output $50 per 1M tokens'],
      ['claude-opus-5-5', 'Opus', true, 'Input $4, output $20 per 1M tokens'],
      ['claude-haiku-4-5-20251001', 'Haiku', true, 'Input $1, output $5 per 1M tokens'],
    ]);
    assert.equal(group.options.find((option) => option.id === 'claude-sonnet-5-7')!.name, 'Claude Sonnet 5.7', 'the provider\'s own name where Flux has none');

    await runs.enable(human(owner), { agentId, connection: key.id, model: 'claude-opus-5-5' });
    await assert.rejects(chooseModel(runs, human(owner), { connection: key.id, model: 'claude-sonnet-5-7' }),
      { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: /Flux doesn't know the price of Claude Sonnet 5\.7 yet\. Enter it to use it with a daily budget\./ });
    // A price for a model Flux's table prices, or nonsense, is refused; the owner's price for the unpriced one is kept on the key.
    assert.equal(codeOf(await owner.browser.request('PUT', `${path}/${key.id}/model-price`, { body: { model: 'claude-opus-5-5', inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 } })), 'AI_PRICE_ALREADY_KNOWN');
    assert.equal(codeOf(await owner.browser.request('PUT', `${path}/${key.id}/model-price`, { body: { model: 'claude sonnet', inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 } })), 'AI_MODEL_INVALID');
    const priced = expectStatus(await owner.browser.request('PUT', `${path}/${key.id}/model-price`,
      { body: { model: 'claude-sonnet-5-7', inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 } }), 200) as BackgroundComputeConnection;
    assert.deepEqual(priced.modelPrices, { 'claude-sonnet-5-7': { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 } });
    const someone = await person('model-list-other');
    assert.equal((await someone.browser.request('PUT', `${path}/${key.id}/model-price`, { body: { model: 'claude-sonnet-5-8', inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 } })).status, 404);
    const option = (await runs.model(human(owner))).groups.find((item) => item.connection === key.id)!.options.find((item) => item.id === 'claude-sonnet-5-7')!;
    assert.deepEqual([option.priced, option.note], [true, 'Input $3, output $15 per 1M tokens']);
    assert.deepEqual((await chooseModel(runs, human(owner), { connection: key.id, model: 'claude-sonnet-5-7' })).current, { connection: key.id, model: 'claude-sonnet-5-7' });
    await chooseModel(runs, human(owner), { connection: key.id, model: 'claude-opus-5-5' });

    // A run on Opus goes to the provider with the model id the provider listed, at the table's Opus price.
    const compute = providerPersonalCompute({ enabled: true, policy: parsePrivateTargets(new URL(MOCK).hostname), timeoutMs: 5_000,
      baseUrls: { anthropic: `${MOCK}/anthropic` }, resolveKey: async (keyRef) => (keyRef === key.id ? apiKey : null) });
    const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: personalConnectionLookup(db), compute, stopPollMs: 20 });
    await providerRequests({}, '/__reset');
    await providerRequests({ wire: 'anthropic', text: 'Fact: the camera fails below 5 lux [S1].', usage: { input: 1_000, output: 100 } }, '/__script');
    const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    assert.equal(await processor.process(asked.run.id), 'completed');
    const sent = (await providerRequests()).filter((item) => item.path === '/anthropic/v1/messages');
    assert.deepEqual(sent.map((item) => (item.body as { model: string }).model), ['claude-opus-5-5']);
    const row = (await pool.query('SELECT model, charged_micros FROM personal_runs WHERE id = $1', [asked.run.id])).rows[0];
    assert.deepEqual(row, { model: 'claude-opus-5-5', charged_micros: Math.ceil((1_000 * 4_000_000 + 100 * 20_000_000) / 1_000_000) });
  });

  test('a model the provider retires shows as no longer offered and pauses its agent, never switched; Try again reads the list through the worker', async () => {
    const apiKey = keyOf('anthropic');
    const key = expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey, dailyBudgetCents: 500 } }), 201) as BackgroundComputeConnection;
    await chooseModel(runs, human(owner), { connection: key.id, model: 'claude-fable-5-2' });
    const tryAgain = async () => (expectStatus(await owner.browser.request('POST', `${path}/${key.id}/model-list`), 200) as { listing: AssistantModelListing }).listing;

    await keyLists({ key: apiKey, omit: ['claude-fable-5-2', 'claude-opus-5-5'] });
    assert.equal((await tryAgain()).state, 'listed');
    const status = await runs.status(human(owner));
    assert.deepEqual([status.state, status.unavailableReason], ['unavailable', 'model_retired']);
    const choice = await runs.model(human(owner));
    assert.deepEqual(choice.current, { connection: key.id, model: 'claude-fable-5-2' }, 'the agent keeps its model: nothing switches by itself');
    const group = choice.groups.find((item) => item.connection === key.id)!;
    // CA-2: the agent's model and the key's own stay shown as "no longer offered"; a stale pick of either says so.
    assert.deepEqual(group.options.filter((option) => option.retired).map((option) => [option.id, option.name]),
      [['claude-opus-5-5', 'Opus 5.5'], ['claude-fable-5-2', 'Fable 5.2']], 'the key\'s own model first, then the agent\'s: both no longer offered');
    assert.equal(group.options.find((option) => option.id === 'claude-fable-5-2')!.family, 'Fable');
    for (const [model, name] of [['claude-opus-5-5', 'Opus 5\\.5'], ['claude-fable-5-2', 'Fable 5\\.2']]) {
      await assert.rejects(chooseModel(runs, human(owner), { connection: key.id, model: model! }),
        { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: new RegExp(`${name} is no longer offered by Anthropic\\.`) });
    }
    // Choosing another model of the key goes on; a model back in the list is offered again.
    await chooseModel(runs, human(owner), { connection: key.id, model: 'claude-sonnet-5-5' });
    assert.equal((await runs.status(human(owner))).state, 'ready');
    await keyLists({ key: apiKey });
    await tryAgain();
    assert.equal((await runs.model(human(owner))).groups.find((item) => item.connection === key.id)!.options.some((option) => option.retired), false);
  });

  test('a list that can\'t be read: the key is saved, the picker says so and keeps the saved model; Try again reads it when the provider answers', async () => {
    const apiKey = keyOf('anthropic');
    await keyLists({ key: apiKey, fail: true });
    const key = expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey, dailyBudgetCents: 500 } }), 201) as BackgroundComputeConnection;
    await chooseModel(runs, human(owner), { connection: key.id, model: 'claude-sonnet-5' });
    const tryAgain = async () => (expectStatus(await owner.browser.request('POST', `${path}/${key.id}/model-list`), 200) as { listing: AssistantModelListing }).listing;
    let group = (await runs.model(human(owner))).groups.find((item) => item.connection === key.id)!;
    assert.equal(group.listing?.state, 'unavailable');
    assert.deepEqual(group.options.map((option) => option.id), ['claude-sonnet-5'],
      'until a list is read the key offers only its own model: Flux keeps no list of models of its own (founder direction, 2026-11-12)');
    assert.equal((await tryAgain()).state, 'unavailable');
    assert.equal((await runs.status(human(owner))).state, 'ready', 'the saved model keeps working');
    await keyLists({ key: apiKey });
    assert.deepEqual(await tryAgain(), { state: 'listed', checkedOn: new Date().toISOString().slice(0, 10) });
    group = (await runs.model(human(owner))).groups.find((item) => item.connection === key.id)!;
    assert.ok(group.options.some((option) => option.id === 'claude-opus-5-5'));
    assert.equal((await owner.browser.request('POST', `${path}/${randomUUID()}/model-list`)).status, 404);
  });

  test('the picker opening reads a list over 6 hours old again, through the worker', async () => {
    const apiKey = keyOf('anthropic');
    const key = expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey, dailyBudgetCents: 500 } }), 201) as BackgroundComputeConnection;
    await pool.query(`UPDATE background_compute_connections SET models_checked_at = now() - interval '7 hours' WHERE id = $1`, [key.id]);
    const checked = async () => (await pool.query('SELECT models_checked_at FROM background_compute_connections WHERE id = $1', [key.id])).rows[0].models_checked_at as Date;
    const stale = await checked();
    expectStatus(await owner.browser.request('GET', '/api/v1/personal-assistant/model'), 200);
    for (let tries = 0; tries < 100 && (await checked()).getTime() === stale.getTime(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await checked()).getTime() > stale.getTime(), 'the worker read the list again');
    assert.equal((await askedWith(apiKey)).length, 2, 'once when it was saved, once when it was stale');
  });
});
