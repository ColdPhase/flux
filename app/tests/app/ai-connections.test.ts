import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createDatabase, personalConnectionLookup, personalKeyResolver } from '@flux/db';
import { AI_MODEL_LISTS_PATH, type AiModelList, type BackgroundComputeConnection } from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { Browser } from './support/http.js';
import { expectStatus, person, workspace, type Person } from './support/people.js';
import { chooseModel, FakeQueue } from './support/personal-runs.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// Provider-neutral owner AI connections through the running API (#179, F-020 PROV-1/3/4): every
// provider kind is saved the same way under its own key format, model and price source; owner
// endpoints pass the SSRF guard when saved; a key whose budget is below one request is refused.
// Seeded keys carry the marker check_application.sh looks for in the API and worker logs. No real
// provider is called.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const COMPATIBLE = `${MOCK}/openai/v1`;
const path = '/api/v1/background-compute-connections';
const marker = 'owner-budget-key-';
const keys = {
  anthropic: `sk-ant-api03-${marker.repeat(3)}AN01`,
  openai: `sk-proj-${marker.repeat(3)}OA01`,
  openrouter: `sk-or-v1-${marker.repeat(3)}OR01`,
  gemini: `AIza${marker.repeat(3)}GE01`,
  openai_compatible: `local-${marker.repeat(3)}OC01`,
};
const consent = { dailyBudgetCents: 50 };
const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

function decrypt(blob: string, ownerId: string, connectionId: string) {
  const [, nonce, tag, encrypted] = blob.split('.');
  const decipher = createDecipheriv('aes-256-gcm', readFileSync('/run/secrets/flux_background_key'), Buffer.from(nonce!, 'base64url'));
  decipher.setAAD(Buffer.from(`flux-background-key:v1:${ownerId}:${connectionId}`));
  decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted!, 'base64url')), decipher.final()]).toString('utf8');
}
async function mock(pathname: string, body?: unknown) {
  const response = await fetch(`${MOCK}${pathname}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.json() as Promise<{ requests: RecordedProviderRequest[] }>;
}

describe('provider-neutral owner AI connections (#179)', () => {
  let owner: Person;
  beforeEach(() => mock('/__reset', {}));
  before(async () => { owner = await person('ai-connection-owner'); });

  test('every provider kind saves under its own key format, model and price source; the key never comes back', async () => {
    const cases: { body: Record<string, unknown>; key: string; expect: Partial<BackgroundComputeConnection> }[] = [
      { body: { provider: 'anthropic', model: 'claude-sonnet-5' }, key: keys.anthropic,
        expect: { provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: null,
          price: { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, source: 'table', checkedOn: '2026-11-12' } } },
      { body: { provider: 'openai', model: 'gpt-model', price: { inputMicrosPerMTok: 400_000, outputMicrosPerMTok: 1_600_000 } }, key: keys.openai,
        expect: { provider: 'openai', model: 'gpt-model', baseUrl: null, price: { inputMicrosPerMTok: 400_000, outputMicrosPerMTok: 1_600_000, source: 'owner', checkedOn: null } } },
      { body: { provider: 'gemini', model: 'gemini-model' }, key: keys.gemini, expect: { provider: 'gemini', model: 'gemini-model', price: null } },
      { body: { provider: 'openrouter', model: 'vendor/flux-test-model', price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 } }, key: keys.openrouter,
        expect: { provider: 'openrouter', model: 'vendor/flux-test-model', price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, source: 'owner', checkedOn: null } } },
      { body: { provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: `${COMPATIBLE}/`, price: { inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 } },
        key: keys.openai_compatible,
        expect: { provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: COMPATIBLE, price: { inputMicrosPerMTok: 0, outputMicrosPerMTok: 0, source: 'owner', checkedOn: null } } },
    ];
    for (const { body, key, expect } of cases) {
      const response = await owner.browser.request('POST', path, { body: { ...consent, ...body, apiKey: key } });
      const saved = expectStatus(response, 201, String(body.provider)) as BackgroundComputeConnection;
      for (const [field, value] of Object.entries(expect)) assert.deepEqual(saved[field as keyof BackgroundComputeConnection], value, `${body.provider} ${field}`);
      assert.deepEqual([saved.dailyBudgetCents, saved.today.spentMicros], [50, 0], 'one daily budget, nothing spent yet');
      assert.equal(saved.keyLastFour, key.slice(-4));
      assert.equal(response.text.includes(key), false, 'the key is never returned');
      const listed = await owner.browser.request('GET', path);
      assert.deepEqual((expectStatus(listed, 200) as BackgroundComputeConnection[]).find((item) => item.id === saved.id), saved);
      assert.equal(listed.text.includes(key), false);
      const stored = (await pool.query('SELECT encrypted_key FROM background_compute_connections WHERE id=$1', [saved.id])).rows[0].encrypted_key as string;
      assert.ok(stored.startsWith('v1.') && !stored.includes(key));
      assert.equal(decrypt(stored, owner.id, saved.id), key, 'custody is the same AEAD for every provider');
    }
    assert.equal((await mock('/__requests')).requests.length, 0, 'saving a connection calls no provider');
  });

  test('wrong key formats, models, URLs and prices are refused and nothing is stored', async () => {
    const before = expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[];
    const refusals: [Record<string, unknown>, string | null][] = [
      [{ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: keys.openai }, 'AI_KEY_FORMAT'],
      [{ provider: 'openai', model: 'gpt-model', apiKey: `sk-admin-${marker.repeat(3)}AD01` }, 'AI_KEY_FORMAT'],
      [{ provider: 'gemini', model: 'gemini-model', apiKey: keys.anthropic }, 'AI_KEY_FORMAT'],
      [{ provider: 'openrouter', model: 'vendor/search-model:online', apiKey: keys.openrouter }, 'AI_MODEL_INVALID'],
      [{ provider: 'openai', model: 'two words', apiKey: keys.openai }, 'AI_MODEL_INVALID'],
      [{ provider: 'openai', model: 'gpt-model', baseUrl: COMPATIBLE, apiKey: keys.openai }, 'AI_BASE_URL_INVALID'],
      [{ provider: 'openai_compatible', model: 'llama3.1:8b', apiKey: keys.openai_compatible }, 'AI_BASE_URL_INVALID'],
      [{ provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: 'https://user:pw@llm.example.org/v1', apiKey: keys.openai_compatible }, 'AI_BASE_URL_INVALID'],
      [{ provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: `${COMPATIBLE}?route=x`, apiKey: keys.openai_compatible }, 'AI_BASE_URL_INVALID'],
      [{ provider: 'anthropic', model: 'claude-sonnet-5', price: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }, apiKey: keys.anthropic }, 'AI_PRICE_ALREADY_KNOWN'],
      [{ provider: 'openai', model: 'gpt-model', price: { inputMicrosPerMTok: -1, outputMicrosPerMTok: 1 }, apiKey: keys.openai }, null],
      [{ provider: 'mistral', model: 'x', apiKey: keys.openai }, null],
      [{ model: 'claude-sonnet-5', apiKey: keys.anthropic }, null],
    ];
    for (const [body, code] of refusals) {
      const response = await owner.browser.request('POST', path, { body: { ...consent, ...body } });
      assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
      if (code) assert.equal(codeOf(response), code, JSON.stringify(body));
      for (const key of Object.values(keys)) assert.equal(response.text.includes(key), false, 'no key in an error body');
    }
    assert.deepEqual(expectStatus(await owner.browser.request('GET', path), 200), before, 'a refused save changes nothing');
  });

  test('SSRF guard when saved: private, loopback, link-local, ULA and metadata endpoints are refused unless the operator allows them', async () => {
    for (const baseUrl of ['http://10.0.0.5/v1', 'https://127.0.0.1/v1', 'https://localhost/v1', 'https://169.254.169.254/v1', 'https://[::1]/v1',
      'http://192.168.1.20:11434/v1', 'https://[fd00::1]/v1', 'https://100.64.0.1/v1', 'http://example.com/v1']) {
      const response = await owner.browser.request('POST', path, { body: { ...consent, provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl,
        price: { inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 }, apiKey: keys.openai_compatible } });
      assert.equal(response.status, 400, baseUrl);
      assert.equal(codeOf(response), 'AI_ENDPOINT_REFUSED', baseUrl);
      assert.equal(response.text.includes(keys.openai_compatible), false);
    }
    // The test stack's operator allowlist names the provider mock only (compose.test.yaml).
    expectStatus(await owner.browser.request('POST', path, { body: { ...consent, provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: COMPATIBLE,
      apiKey: keys.openai_compatible } }), 201);
  });

  test('model lists are read by the server without a key, through the same guard', async () => {
    const list = async (body: unknown, someone = owner.browser) => someone.request('POST', AI_MODEL_LISTS_PATH, { body });
    const compatible = expectStatus(await list({ provider: 'openai_compatible', baseUrl: COMPATIBLE }), 200) as AiModelList;
    assert.equal(compatible.status, 'listed');
    assert.deepEqual(compatible.models.map((model) => model.id), ['llama3.1:8b', 'qwen2.5:7b-instruct']);
    const listed = (await mock('/__requests')).requests;
    assert.deepEqual(listed.map((item) => [item.method, item.path, item.key]), [['GET', '/openai/v1/models', null]], 'no key, one listing request');
    for (const provider of ['anthropic', 'openai', 'gemini'])
      assert.equal((expectStatus(await list({ provider }), 200) as AiModelList).status, 'needs_key', provider);
    assert.equal((expectStatus(await list({ provider: 'openai_compatible', baseUrl: 'http://10.9.9.9/v1' }), 200) as AiModelList).status, 'refused');
    assert.equal((await list({ provider: 'anthropic', baseUrl: COMPATIBLE })).status, 400);
    assert.equal((await list({ provider: 'openai_compatible' })).status, 400);
    assert.equal((await list({ provider: 'openai_compatible', baseUrl: COMPATIBLE }, new Browser())).status, 401);
  });
});

describe('a key whose budget is below one request is refused when saved (#179 PROV-3)', () => {
  test('a provider\'s own listing or reported cost is never a reservation price', async () => {
    const owner = await person('ai-budget-owner');
    // 64,000 × $30/M + 4,000 × $60/M = $2.16 per request, above this key's $0.20 daily budget: it would wait for a day that never comes.
    assert.equal(codeOf(await owner.browser.request('POST', path, { body: { ...consent, provider: 'openai', model: 'gpt-model',
      price: { inputMicrosPerMTok: 30_000_000, outputMicrosPerMTok: 60_000_000 }, apiKey: keys.openai, dailyBudgetCents: 20 } })), 'AI_BUDGET_TOO_SMALL');
    // A model without a known price is saved without one; a runtime that needs a price will not use it.
    assert.equal((expectStatus(await owner.browser.request('POST', path, { body: { ...consent, provider: 'openrouter', model: 'vendor/priced-model',
      apiKey: keys.openrouter } }), 201) as BackgroundComputeConnection).price, null);
  });
});

describe('several connections per owner and the assistant\'s own one (#179 PROV-1, #68 switch-on steps 1-2)', () => {
  test('the lookup returns only the owner\'s own active connection, exactly the one named; the resolver opens only that key', async () => {
    const [owner, other] = await Promise.all(['prov1-owner', 'prov1-other'].map(person));
    const add = async (someone: Person, body: Record<string, unknown>) => expectStatus(await someone.browser.request('POST', path,
      { body: { ...consent, ...body } }), 201) as BackgroundComputeConnection;
    const first = await add(owner, { name: 'Work Anthropic', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: keys.anthropic });
    const second = await add(owner, { name: 'Home OpenRouter', provider: 'openrouter', model: 'vendor/flux-test-model',
      price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }, apiKey: keys.openrouter });
    const foreign = await add(other, { provider: 'openai', model: 'gpt-model', price: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }, apiKey: keys.openai });
    assert.equal(second.name, 'Home OpenRouter', 'adding never replaces');

    const lookup = personalConnectionLookup(db);
    assert.equal((await lookup.resolve(owner.id))?.id, second.id, 'without a choice: the newest, only to describe enabling');
    const named = await lookup.resolve(owner.id, first.id);
    assert.deepEqual([named?.id, named?.provider, named?.model, named?.keyRef, named?.dailyBudgetCents], [first.id, 'anthropic', 'claude-sonnet-5', first.id, 50]);
    assert.equal(await lookup.resolve(owner.id, foreign.id), null, 'another person\'s connection is never returned');
    assert.equal(await lookup.resolve(other.id, first.id), null);

    const resolveKey = personalKeyResolver(db, readFileSync('/run/secrets/flux_background_key'));
    assert.equal(await resolveKey(first.id), keys.anthropic);
    assert.equal(await resolveKey(second.id), keys.openrouter);
    assert.equal(await resolveKey('not-a-connection'), null);
    assert.equal(await personalKeyResolver(db, null)(first.id), null, 'without the instance key nothing can be opened');

    expectStatus(await owner.browser.request('DELETE', `${path}/${first.id}`), 204);
    assert.equal(await lookup.resolve(owner.id, first.id), null, 'a removed connection is gone for the assistant too: no fallback');
    assert.equal(await resolveKey(first.id), null);
    assert.equal((await lookup.resolve(owner.id))?.id, second.id);
  });
});

describe('a budget that one request of the assistant\'s model would not fit is refused when it is saved (#909)', () => {
  test('a Haiku key with the assistant on Fable: lowering to $0.20 is refused, $1.34 fits, and back on Haiku $0.20 fits', async () => {
    const owner = await person('budget-assistant-owner');
    const ws = await workspace(owner, 'Budget assistant club');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    const key = expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: keys.anthropic, dailyBudgetCents: 100 } }), 201) as BackgroundComputeConnection;
    const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections: personalConnectionLookup(db), providerEnabled: true });
    const me = { kind: 'human', id: owner.id } as const;
    await runs.enable(me, { agentId, connection: key.id, model: 'claude-haiku-4-5' });
    const lower = (cents: number) => owner.browser.request('PATCH', `${path}/${key.id}`, { body: { dailyBudgetCents: cents } });
    // One Haiku request with Anthropic's own web search (#954) is (64,000 + 50,000 for the results) × $1/M + 4,000 × $5/M = 14 cents; its
    // searches are charged as reported, not reserved (#1113): with the assistant on Haiku, $0.20 is accepted.
    expectStatus(await lower(20), 200);
    expectStatus(await lower(200), 200);
    // The assistant moves to Fable, whose one request is 114,000 × $10/M + 4,000 × $50/M = $1.34; it fits $2.00.
    await chooseModel(runs, me, { connection: key.id, model: 'claude-fable-5-1' });
    const refused = await lower(20);
    assert.equal(codeOf(refused), 'AI_BUDGET_TOO_SMALL', refused.text);
    assert.match((refused.json as { error: string }).error, /Fable 5\.1, your assistant's model on this key, can cost up to \$1\.34/);
    assert.equal(codeOf(await lower(133)), 'AI_BUDGET_TOO_SMALL');
    assert.equal((expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[]).find((item) => item.id === key.id)!.dailyBudgetCents, 200, 'the refused budget changed nothing');
    expectStatus(await lower(134), 200);
    // Back on the key's own cheap model, a small budget is fine again.
    await chooseModel(runs, me, { connection: key.id, model: 'claude-haiku-4-5' });
    expectStatus(await lower(20), 200);
  });

  test('#915: a budget saved while the assistant moves to another model is checked against the model it ends on', async () => {
    const owner = await person('budget-race-owner');
    const ws = await workspace(owner, 'Budget race club');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    const key = expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: keys.anthropic, dailyBudgetCents: 100 } }), 201) as BackgroundComputeConnection;
    const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections: personalConnectionLookup(db), providerEnabled: true });
    await runs.enable({ kind: 'human', id: owner.id }, { agentId, connection: key.id, model: 'claude-haiku-4-5' });
    // The model change takes the owner's assistant lock first. Hold it, as a change that has not committed yet would, and save the budget meanwhile.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`assistant-owner:${owner.id}`]);
      const saving = owner.browser.request('PATCH', `${path}/${key.id}`, { body: { dailyBudgetCents: 20 } });
      // The save waits for the lock; the model it will be checked against is not read before it has it.
      const waiting = () => pool.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [`assistant-owner:${owner.id}`]);
      for (let tries = 0; tries < 100 && !(await waiting()).rowCount; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await waiting()).rowCount, 1, 'the save is waiting for the lock');
      await holder.query(`UPDATE assistant_settings SET model = 'claude-fable-5-1' WHERE owner_user_id = $1`, [owner.id]);
      await holder.query('COMMIT');
      const refused = await saving;
      assert.equal(codeOf(refused), 'AI_BUDGET_TOO_SMALL', refused.text);
      assert.match((refused.json as { error: string }).error, /Fable 5\.1, your assistant's model on this key/);
    } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); }
    assert.equal((expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[]).find((item) => item.id === key.id)!.dailyBudgetCents, 100);
  });
});
