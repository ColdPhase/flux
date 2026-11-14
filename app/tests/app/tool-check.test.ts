import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { tablePrice, type AiPrice, type AiProviderKind, type BackgroundComputeConnection } from '@flux/contracts';
import { costMicros, type Principal, type ToolChecking } from '@flux/core';
import { apiKeyCheckRows, apiKeySpendToday, createDatabase, personalConnectionLookup, personalKeyResolver } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { largestToolCheckMicros, parsePrivateTargets, providerToolCheck } from '../../packages/agent-runtime/src/index.js';
import { expectStatus, person, workspace, type Person } from './support/people.js';
import { chooseModel, FakeQueue } from './support/personal-runs.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';
import type { ToolCheckRequest } from './support/key-list-mock.js';
import { offeredTools, type ToolWire } from './support/tool-answers.js';

// Only models that call tools can be agents, decided by ONE check for every provider (RT-1 rule 2, #1441): when a key is added in Connect AI, and
// when another model of a key's list is chosen for an agent, the server sends the provider one small request on that model with one tool, `ping`,
// that the model is asked to call. Called: accepted. Not called, or the request refused or failed: 422 `AI_TOOLS_REQUIRED`, "This model can't use
// tools. Choose another." The request is charged to the key's day like any other.
//
//   (a) the check through the REAL adapters of each wire format against the provider mock (`providermock`, mode `tool`),
//   (b) Connect AI through the running API, whose check goes to the key-list mock under `/lists/…` (`FLUX_TEST_PROVIDER_LISTS`),
//   (c) choosing another model of a stored key for an agent, with the key opened for that one request, and the day's spend that counts them all.
//
// No real provider is called: nothing here proves how a real model answers the check.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const policy = parsePrivateTargets(new URL(MOCK).hostname);
const COMPATIBLE = `${MOCK}/openai/v1`;
const path = '/api/v1/background-compute-connections';
const MESSAGE = 'This model can\'t use tools. Choose another.';
/** The marker check_application.sh looks for in the API and worker logs: a key never reaches a log, the check's request included. */
const marker = 'owner-budget-key-';
const OWNER_PRICE: AiPrice = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, source: 'owner', checkedOn: null };
const price = { inputMicrosPerMTok: OWNER_PRICE.inputMicrosPerMTok, outputMicrosPerMTok: OWNER_PRICE.outputMicrosPerMTok };
/** What the key-list mock reports for a check: 60 tokens in, 8 out (`TOOL_ANSWER_USAGE`). */
const MOCK_USAGE = { inputTokens: 60, outputTokens: 8 };

async function control(pathname: string, body?: unknown) {
  const response = await fetch(`${MOCK}${pathname}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ requests: RecordedProviderRequest[]; checks?: ToolCheckRequest[] }>;
}
const script = (wire: 'anthropic' | 'openai', patch: Record<string, unknown>) => control('/__script', { wire, ...patch });
/** What the adapters sent to the provider mock with this key. */
const sentWith = async (key: string) => (await control('/__requests')).requests.filter((item) => item.key === key);
/** The checks Connect AI and the agents' model choice sent to the key-list mock with this key, in order. */
const checksWith = async (key: string) => ((await control('/__key-lists')).checks ?? []).filter((item) => item.key === key);

interface Wire {
  label: string; provider: AiProviderKind; model: string; baseUrl: string | null; key: string;
  /** Where the provider mock receives it, which mock script it takes and how the tools are written on that wire format. */
  path: string; on: 'anthropic' | 'openai'; toolWire: ToolWire; bound: string;
}
const WIRES: Wire[] = [
  { label: 'Anthropic Messages', provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: null, key: `sk-ant-api03-${marker.repeat(3)}TCA1`,
    path: '/anthropic/v1/messages', on: 'anthropic', toolWire: 'anthropic', bound: 'max_tokens' },
  { label: 'OpenAI Responses', provider: 'openai', model: 'gpt-model', baseUrl: null, key: `sk-proj-${marker.repeat(3)}TCO1`,
    path: '/openai/v1/responses', on: 'openai', toolWire: 'responses', bound: 'max_output_tokens' },
  { label: 'Chat Completions as OpenRouter', provider: 'openrouter', model: 'vendor/flux-test-model', baseUrl: null, key: `sk-or-v1-${marker.repeat(3)}TCR1`,
    path: '/openai/v1/chat/completions', on: 'openai', toolWire: 'chat', bound: 'max_tokens' },
  { label: 'Chat Completions as Gemini', provider: 'gemini', model: 'gemini-model', baseUrl: null, key: `AIza${marker.repeat(3)}TCG1`,
    path: '/openai/v1/chat/completions', on: 'openai', toolWire: 'chat', bound: 'max_tokens' },
  { label: 'Chat Completions of an OpenAI-compatible endpoint', provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: COMPATIBLE, key: `local-${marker.repeat(3)}TCC1`,
    path: '/openai/v1/chat/completions', on: 'openai', toolWire: 'chat', bound: 'max_tokens' },
];
const NAMED_BASE_URLS = { anthropic: `${MOCK}/anthropic`, openai: COMPATIBLE, openrouter: COMPATIBLE, gemini: COMPATIBLE };
const adapters = providerToolCheck({ policy, baseUrls: NAMED_BASE_URLS, timeoutMs: 2_000 });
const probeOf = (wire: Wire, model = wire.model) => ({ provider: wire.provider, baseUrl: wire.baseUrl, model, price, key: { apiKey: wire.key } });

for (const wire of WIRES) {
  describe(`the check on ${wire.label} (the real adapter, the Docker mock; no provider pass)`, () => {
    beforeEach(() => control('/__reset', {}));

    test('a model that calls ping is accepted: one request, one tool named ping, charged at the usage the provider reported', async () => {
      await script(wire.on, { mode: 'tool', usage: { input: 70, output: 9 } });
      const result = await adapters(probeOf(wire));
      assert.deepEqual(result, { callsTools: true, chargedMicros: costMicros({ inputTokens: 70, outputTokens: 9 }, price) });
      const [one, ...rest] = await sentWith(wire.key);
      assert.equal(rest.length, 0, 'exactly one request');
      assert.equal(one!.path, wire.path);
      assert.equal(one!.method, 'POST');
      const body = one!.body as Record<string, unknown>;
      assert.deepEqual(offeredTools(wire.toolWire, body), ['ping'], 'one tool, named ping');
      assert.equal(body.model, wire.model);
      assert.equal(body[wire.bound], 256, 'the output bound of the check');
      assert.equal(JSON.stringify(result).includes(wire.key), false);
    });

    test('a model that answers in words is refused, and its request is charged all the same', async () => {
      await script(wire.on, { mode: 'success', usage: { input: 70, output: 9 } });
      assert.deepEqual(await adapters(probeOf(wire)), { callsTools: false, chargedMicros: costMicros({ inputTokens: 70, outputTokens: 9 }, price) });
      assert.equal((await sentWith(wire.key)).length, 1);
    });

    test('a refusal or a failure of the provider refuses the model, and a cost nobody can know counts the most one check can cost', async () => {
      const most = largestToolCheckMicros(price);
      assert.ok(most > 0);
      for (const patch of [{ status: 500 }, { status: 429 }, { status: 400, errorMessage: 'This model does not support tools.' }, { status: 401 }]) {
        await control('/__reset', {});
        await script(wire.on, { mode: 'status', ...patch });
        assert.deepEqual(await adapters(probeOf(wire)), { callsTools: false, chargedMicros: most }, JSON.stringify(patch));
        assert.equal((await sentWith(wire.key)).length, 1, `${JSON.stringify(patch)}: nothing is sent again`);
      }
      // An answer that is not even JSON, and one that never comes, are the same refusal.
      await control('/__reset', {});
      await script(wire.on, { mode: 'malformed' });
      assert.equal((await adapters(probeOf(wire))).callsTools, false);
    });

    test('usage that cannot be right (more input than a check could carry) counts the most one check can cost', async () => {
      await script(wire.on, { mode: 'tool', usage: { input: 50_000, output: 9 } });
      assert.deepEqual(await adapters(probeOf(wire)), { callsTools: true, chargedMicros: largestToolCheckMicros(price) });
    });
  });
}

describe('the check of a stored key (the sealed key is opened for that one request)', () => {
  beforeEach(() => control('/__reset', {}));

  test('the key resolved for the connection is the one sent; a key that cannot be opened is refused with no request and no cost', async () => {
    const wire = WIRES[0]!;
    const connectionId = randomUUID();
    const resolved: string[] = [];
    const stored = providerToolCheck({ policy, baseUrls: NAMED_BASE_URLS, timeoutMs: 2_000,
      resolveStoredKey: async (ref) => { resolved.push(ref); return ref === connectionId ? wire.key : null; } });
    await script('anthropic', { mode: 'tool' });
    assert.equal((await stored({ ...probeOf(wire), key: { connectionId } })).callsTools, true);
    assert.deepEqual(resolved, [connectionId], 'opened once, for this connection');
    assert.equal((await sentWith(wire.key)).length, 1);
    // A revoked key, or one on a server without its instance key, resolves to nothing: nothing is sent, nothing is charged.
    const model = 'claude-no-key-model';
    assert.deepEqual(await stored({ ...probeOf(wire, model), key: { connectionId: randomUUID() } }), { callsTools: false, chargedMicros: 0 });
    assert.deepEqual(await providerToolCheck({ policy, baseUrls: NAMED_BASE_URLS })({ ...probeOf(wire, model), key: { connectionId } }), { callsTools: false, chargedMicros: 0 });
    assert.equal((await control('/__requests')).requests.filter((item) => (item.body as { model?: string } | null)?.model === model).length, 0, 'no request');
  });
});

// --- (b) Connect AI ------------------------------------------------------------------------------------------------------------------

const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;
const messageOf = (response: { json: unknown }) => (response.json as { error?: string } | null)?.error;

describe('Connect AI checks the key\'s model before it saves the key (#1441)', () => {
  let owner: Person;
  before(async () => { owner = await person('tool-check-connect'); });
  beforeEach(() => control('/__reset', {}));

  const connect = (wire: Wire, model: string, extra: Record<string, unknown> = {}) => owner.browser.request('POST', path, { body: {
    dailyBudgetCents: 50, provider: wire.provider, model, apiKey: wire.key, price, ...(wire.baseUrl ? { baseUrl: wire.baseUrl } : {}), ...extra } });
  const saved = async () => (expectStatus(await owner.browser.request('GET', path), 200) as BackgroundComputeConnection[]).map((item) => item.id).sort();
  const checkRows = async () => Number((await pool.query(`SELECT count(*) AS n FROM api_key_checks c JOIN background_compute_connections k ON k.id = c.connection_id
    WHERE k.owner_user_id = $1`, [owner.id])).rows[0].n);

  for (const wire of WIRES) {
    const ok = wire.provider === 'openai_compatible' ? wire.model : `${wire.model}-tc-ok`;
    test(`${wire.provider}: a model that calls ping is saved with its check, charged to the key's day from the start; one that does not is refused and nothing is saved`, async () => {
      // The compatible endpoint is the provider mock itself (its script decides); the named providers' checks go to the key-list mock, which decides
      // by the model's id: `-tc-no-tools` answers in words and `-tc-check-fails` with a 500.
      const compatible = wire.provider === 'openai_compatible';
      if (compatible) await script('openai', { mode: 'tool', usage: { input: 60, output: 8 } });
      const was = { saved: await saved(), rows: await checkRows() };
      const created = expectStatus(await connect(wire, ok), 201, wire.provider) as BackgroundComputeConnection;
      const charged = costMicros(MOCK_USAGE, price);
      assert.equal(created.today.spentMicros, charged, 'the check is on the key\'s day in the answer that saves the key');
      assert.deepEqual((await pool.query('SELECT model, calls_tools, charged_micros FROM api_key_checks WHERE connection_id = $1', [created.id])).rows,
        [{ model: ok, calls_tools: true, charged_micros: String(charged) }], 'one row: recorded in the same transaction as the key');
      assert.equal((await apiKeySpendToday(db, created.id))!.chargedMicros, charged, 'and counted by the key\'s spend today');
      const sent = compatible ? (await sentWith(wire.key)).map((item) => ({ key: item.key, tools: offeredTools(wire.toolWire, item.body) }))
        : (await checksWith(wire.key)).filter((item) => item.model === ok).map((item) => ({ key: item.key, tools: item.tools }));
      assert.deepEqual(sent, [{ key: wire.key, tools: ['ping'] }], 'one request, with the key being added and the one tool');

      // A model that answers in words, or whose request fails: refused with the same words and code, and nothing is saved.
      const refusals: { model: string; first?: () => Promise<unknown> }[] = compatible
        ? [{ model: wire.model, first: () => script('openai', { mode: 'success' }) }, { model: wire.model, first: () => script('openai', { mode: 'status', status: 500 }) }]
        : [{ model: `${wire.model}-tc-no-tools` }, { model: `${wire.model}-tc-check-fails` }];
      for (const { model, first } of refusals) {
        await first?.();
        const refused = await connect(wire, model, { name: `Refused ${model}` });
        assert.equal(refused.status, 422, refused.text);
        assert.equal(codeOf(refused), 'AI_TOOLS_REQUIRED');
        assert.equal(messageOf(refused), MESSAGE);
        assert.equal(refused.text.includes(wire.key), false, 'no key in the refusal');
      }
      assert.deepEqual(await saved(), [...was.saved, created.id].sort(), 'only the model that calls ping was saved');
      assert.equal(await checkRows(), was.rows + 1, 'a refused key keeps no check: there is no connection to charge it to');
    });
  }

  test('a model without a known price is not saved (#1424), so no check is sent for it', async () => {
    const wire = WIRES[3]!;
    const unpriced = await owner.browser.request('POST', path, { body: { dailyBudgetCents: 50, provider: 'gemini', model: 'gemini-tc-unpriced', apiKey: wire.key } });
    assert.equal(unpriced.status, 422, unpriced.text);
    assert.equal(codeOf(unpriced), 'AI_PRICE_REQUIRED');
    assert.deepEqual((await checksWith(wire.key)).filter((item) => item.model === 'gemini-tc-unpriced'), [], 'no request');
  });

  test('a key its provider refuses is refused before any check is sent', async () => {
    const key = `sk-ant-api03-${marker.repeat(3)}refused`;
    const refused = await owner.browser.request('POST', path, { body: { dailyBudgetCents: 50, provider: 'anthropic', model: 'claude-sonnet-5', apiKey: key } });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(codeOf(refused), 'AI_KEY_REFUSED');
    assert.deepEqual(await checksWith(key), []);
  });
});

// --- (c) choosing another model of a key -------------------------------------------------------------------------------------------

describe('putting an agent on another model of a key checks that model once (#1441)', () => {
  const KEY = `sk-ant-api03-${marker.repeat(3)}TCM1`;
  const masterKey = readFileSync('/run/secrets/flux_background_key');
  const rows = apiKeyCheckRows(db);
  const toolChecking: ToolChecking = {
    check: providerToolCheck({ policy, resolveStoredKey: personalKeyResolver(db, masterKey), timeoutMs: 5_000,
      baseUrls: { anthropic: `${MOCK}/lists/anthropic`, openai: `${MOCK}/lists/openai/v1`, openrouter: `${MOCK}/lists/openrouter/v1`, gemini: `${MOCK}/lists/gemini/v1beta/openai` } }),
    passed: rows.passed, record: rows.record,
  };
  const SONNET = tablePrice('anthropic', 'claude-sonnet-5')!;
  const SONNET_5_5 = tablePrice('anthropic', 'claude-sonnet-5-5')!;
  const OPUS = tablePrice('anthropic', 'claude-opus-5-5')!;
  const check = (model: { inputMicrosPerMTok: number; outputMicrosPerMTok: number }) => costMicros(MOCK_USAGE, model);
  let owner: Person; let me: Principal; let agentId: string; let key: BackgroundComputeConnection;
  let runs: ReturnType<typeof personalRunUseCases>;
  const count = async () => (await checksWith(KEY)).length;
  const modelOf = async () => (await runs.getAgent(me, agentId)).model.model;

  before(async () => {
    owner = await person('tool-check-choose');
    me = { kind: 'human', id: owner.id };
    const ws = await workspace(owner, 'Tool check club');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Checked', owner: 'self' } }), 201) as { id: string }).id;
    key = expectStatus(await owner.browser.request('POST', path, { body: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: KEY, dailyBudgetCents: 100 } }), 201) as BackgroundComputeConnection;
    runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections: personalConnectionLookup(db), providerEnabled: true, toolChecking });
  });

  test('the model chosen when the key was added passed then; another that does not call ping is refused, costs its request and changes nothing', async () => {
    assert.equal(await count(), 1, 'the check of Connect AI');
    await runs.enable(me, { agentId, connection: key.id, model: 'claude-sonnet-5' });
    assert.equal(await count(), 1, 'a model that passed is not checked again');
    await control('/__key-lists', { key: KEY, noTools: ['claude-opus-5-5'] });
    await assert.rejects(chooseModel(runs, me, { connection: key.id, model: 'claude-opus-5-5' }),
      { status: 422, code: 'AI_TOOLS_REQUIRED', message: MESSAGE });
    assert.equal(await modelOf(), 'claude-sonnet-5', 'the agent stays on its model');
    const sent = (await checksWith(KEY)).at(-1)!;
    assert.deepEqual([await count(), sent.model, sent.tools, sent.key], [2, 'claude-opus-5-5', ['ping'], KEY], 'one request, with the key opened for it');
    assert.deepEqual((await pool.query('SELECT model, calls_tools, charged_micros FROM api_key_checks WHERE connection_id = $1 ORDER BY checked_at', [key.id])).rows,
      [{ model: 'claude-sonnet-5', calls_tools: true, charged_micros: String(check(SONNET)) },
        { model: 'claude-opus-5-5', calls_tools: false, charged_micros: String(check(OPUS)) }], 'the refused check is kept: it cost its request');
    assert.equal((await apiKeySpendToday(db, key.id))!.chargedMicros, check(SONNET) + check(OPUS), 'both count on the key\'s day');
  });

  test('a refusal is not a pass: the same model is asked again, accepted when it calls ping, and then never asked again', async () => {
    await control('/__key-lists', { key: KEY });
    await chooseModel(runs, me, { connection: key.id, model: 'claude-opus-5-5' });
    assert.equal(await modelOf(), 'claude-opus-5-5');
    assert.equal(await count(), 3);
    await chooseModel(runs, me, { connection: key.id, model: 'claude-sonnet-5-5' });
    assert.equal(await count(), 4, 'a model of the key that was never checked is checked');
    // Back to a model that passed (the one chosen when the key was added, then the two of this test), and the one the agent is on: no request.
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']) {
      await chooseModel(runs, me, { connection: key.id, model });
      assert.equal(await modelOf(), model);
    }
    assert.equal(await count(), 4, 'no second check for a model that passed');
    assert.equal((await apiKeySpendToday(db, key.id))!.chargedMicros, check(SONNET) + 2 * check(OPUS) + check(SONNET_5_5));
  });

  test('a model that is not on the key\'s list, or has no price, is refused as before and is never sent to the provider', async () => {
    const before = await count();
    await assert.rejects(chooseModel(runs, me, { connection: key.id, model: 'claude-not-listed' }), { code: 'ASSISTANT_MODEL_UNAVAILABLE' });
    await assert.rejects(chooseModel(runs, me, { connection: key.id, model: 'claude-sonnet-5-7' }), { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: /doesn't know the price/ });
    assert.equal(await count(), before);
  });

  test('a check is on its own day of the key: yesterday\'s does not count today', async () => {
    const spent = (await apiKeySpendToday(db, key.id))!.chargedMicros;
    await pool.query(`INSERT INTO api_key_checks (id, connection_id, model, checked_at, charged_micros, calls_tools) VALUES ($1, $2, 'claude-sonnet-5', now() - interval '2 days', 999999, true)`,
      [randomUUID(), key.id]);
    assert.equal((await apiKeySpendToday(db, key.id))!.chargedMicros, spent);
  });

  test('revoking a key keeps its checks (they are part of what it spent) and opens no more of its sealed key', async () => {
    expectStatus(await owner.browser.request('DELETE', `${path}/${key.id}`), 204);
    // A revoked key stays as a row with its key wiped, so its checks stay with it; they go with the key's row only when its owner is deleted (ON DELETE CASCADE).
    assert.ok(Number((await pool.query('SELECT count(*) AS n FROM api_key_checks WHERE connection_id = $1', [key.id])).rows[0].n) >= 4);
    assert.equal(await personalKeyResolver(db, masterKey)(key.id), null, 'and its sealed key opens no more');
  });
});
