import assert from 'node:assert/strict';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createDatabase, personalConnectionLookup, personalKeyResolver } from '@flux/db';
import { AI_MODEL_LISTS_PATH, type AiModelList, type BackgroundComputeConnection, type Material, type ProactiveComparisonProposal,
  type WorkResult } from '@flux/contracts';
import { parsePrivateTargets, providerComparison } from '../../packages/agent-runtime/src/index.js';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// Provider-neutral owner AI connections through the running API (#179, F-020 PROV-1/3/4): every
// provider kind is saved the same way under its own key format, model and price source; owner
// endpoints pass the SSRF guard when saved; a connection without a known price cannot be enabled;
// the worker dispatches each connection on its own wire format against the Docker provider mock.
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
const consent = { payerOrganization: 'Fixture payer', providerWorkspace: 'Fixture workspace', workspaceScopedKeyConfirmed: true,
  payerAuthorityConfirmed: true, providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
  maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 20 };
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
          price: { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, source: 'table', checkedOn: '2026-10-02' } } },
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
      // Each saved connection is marked for background comparisons, so `current` is the one just saved (PROV-1).
      const response = await owner.browser.request('POST', path, { body: { ...consent, ...body, apiKey: key, useForBackground: true } });
      const saved = expectStatus(response, 201, String(body.provider)) as BackgroundComputeConnection;
      for (const [field, value] of Object.entries(expect)) assert.deepEqual(saved[field as keyof BackgroundComputeConnection], value, `${body.provider} ${field}`);
      assert.equal(saved.consentVersion, 'o-007-2026-10-02');
      assert.equal(saved.keyLastFour, key.slice(-4));
      assert.equal(response.text.includes(key), false, 'the key is never returned');
      const current = await owner.browser.request('GET', `${path}/current`);
      assert.deepEqual(expectStatus(current, 200), saved);
      assert.equal(current.text.includes(key), false);
      const stored = (await pool.query('SELECT encrypted_key FROM background_compute_connections WHERE id=$1', [saved.id])).rows[0].encrypted_key as string;
      assert.ok(stored.startsWith('v1.') && !stored.includes(key));
      assert.equal(decrypt(stored, owner.id, saved.id), key, 'custody is the same AEAD for every provider');
    }
    assert.equal((await mock('/__requests')).requests.length, 0, 'saving a connection calls no provider');
  });

  test('wrong key formats, models, URLs and prices are refused and nothing is stored', async () => {
    const before = expectStatus(await owner.browser.request('GET', `${path}/current`), 200) as BackgroundComputeConnection;
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
    assert.deepEqual(expectStatus(await owner.browser.request('GET', `${path}/current`), 200), before, 'a refused save changes nothing');
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

describe('enabling and dispatch on any provider (#179 PROV-2/PROV-3)', () => {
  let owner: Person;
  let peer: Person;
  let projectId: string;
  let ruleId: string;
  let material: Material;
  const masterKey = readFileSync('/run/secrets/flux_background_key');
  // The worker's adapter registry, with Anthropic's fixed URL replaced by the mock for this test only.
  const providers = providerComparison({ policy: parsePrivateTargets(new URL(MOCK).hostname), baseUrls: { anthropic: `${MOCK}/anthropic` }, timeoutMs: 5_000 });
  // Each new connection is marked for background comparisons (PROV-1: adding one never replaces another).
  const connect = async (body: Record<string, unknown>) => expectStatus(await owner.browser.request('POST', path,
    { body: { ...consent, ...body, useForBackground: true } }), 201) as BackgroundComputeConnection;
  const enable = async () => {
    const rule = (await pool.query('SELECT version FROM proactive_comparison_rules WHERE id=$1', [ruleId])).rows[0] as { version: number };
    return owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${ruleId}`, { body: { expectedVersion: rule.version, status: 'enabled' } });
  };
  const negative = async (title: string) => {
    const result = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/results`, { body: { title, finding: 'negative',
      evidence: 'Camera misses at 5 lux', sources: [{ type: 'material', id: material.materialId, version: 1 }] } }), 201) as WorkResult;
    const candidateId = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0].id as string;
    await comparisonDispatchFixtureDue(pool, candidateId);
    return { result, candidateId };
  };
  const answer = (resultId: string) => JSON.stringify({ outcome: { kind: 'comparison', fact: 'Sensor A misses gestures in low light.',
    interpretation: 'Exposure may be too short.', suggestedAction: 'Compare a second sensor in the same test.',
    citations: [{ type: 'result', id: resultId, version: 1 }] } });

  before(async () => {
    [owner, peer] = await Promise.all(['ai-dispatch-owner', 'ai-dispatch-peer'].map(person));
    const ws = await workspace(owner, 'Provider-neutral comparison');
    await addMember(owner, ws.id, peer, 'member');
    projectId = (await project(owner, ws.id, 'Sensors on any provider', 'restricted')).id;
    await grant(owner, projectId, peer, 'contributor');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Provider-neutral agent', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    ruleId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`,
      { body: { agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison', dataScope: 'current_project_published',
        permittedEffect: 'quiet_project_proposal', maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 20 } }), 201) as { id: string }).id;
    material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Sensor measurement', body: 'Camera A captured 38% of gestures at 5 lux.' } }), 201) as Material;
  });
  beforeEach(() => mock('/__reset', {}));

  test('a connection without a known price cannot be enabled; a model whose request exceeds the allowance is refused', async () => {
    await connect({ provider: 'gemini', model: 'gemini-model', apiKey: keys.gemini });
    assert.equal(codeOf(await enable()), 'BACKGROUND_PRICE_UNKNOWN');
    // PROV-3: a provider's own listing or reported cost is never a reservation price.
    assert.equal((await connect({ provider: 'openrouter', model: 'vendor/priced-model', apiKey: keys.openrouter })).price, null);
    assert.equal(codeOf(await enable()), 'BACKGROUND_PRICE_UNKNOWN');
    // 8,000 × $30/M + 1,200 × $60/M = $0.312 per request, above the $0.20 allowance.
    await connect({ provider: 'openai', model: 'gpt-model', price: { inputMicrosPerMTok: 30_000_000, outputMicrosPerMTok: 60_000_000 }, apiKey: keys.openai });
    assert.equal(codeOf(await enable()), 'BACKGROUND_BUDGET_TOO_LOW');
    await connect({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: keys.anthropic });
    assert.equal(codeOf(await enable()), 'BACKGROUND_RUNTIME_UNAVAILABLE', 'a priced connection reaches the last gate');
  });

  test('the worker sends each connection on its own wire format; reservation and usage use its price', async () => {
    // Controlled local compute only: production activation stays off (see the test above).
    await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [ruleId]);
    const runs: { body: Record<string, unknown>; key: string; wire: 'anthropic' | 'openai'; reserved: number; observed: number }[] = [
      // 8,000 × $10/M + 1,200 × $40/M = $0.128 → 13 cents; 300 × $10/M + 90 × $40/M = $0.0066 → 1 cent.
      { body: { provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: COMPATIBLE, price: { inputMicrosPerMTok: 10_000_000, outputMicrosPerMTok: 40_000_000 } },
        key: keys.openai_compatible, wire: 'openai', reserved: 13, observed: 1 },
      // The table price: $0.028 → O-007's 5-cent floor; 300 × $2/M + 90 × $10/M → 1 cent.
      { body: { provider: 'anthropic', model: 'claude-sonnet-5' }, key: keys.anthropic, wire: 'anthropic', reserved: 5, observed: 1 },
    ];
    for (const run of runs) {
      await mock('/__reset', {});
      const connection = await connect({ ...run.body, apiKey: run.key });
      const { result, candidateId } = await negative(`Low-light failure on ${connection.provider}`);
      await mock('/__script', { wire: run.wire, text: answer(result.id), usage: { input: 300, output: 90 } });
      const outcome = await dispatchProactiveComparison({ db, candidateId, masterKey, provider: providers });
      assert.equal(outcome.status, 'proposal', connection.provider);
      const sent = (await mock('/__requests')).requests;
      assert.deepEqual(sent.map((item) => item.wire), run.wire === 'anthropic' ? ['anthropic', 'anthropic'] : ['openai'],
        'Anthropic adds its token count; the Chat Completions wire format has none');
      assert.ok(sent.every((item) => item.key === run.key), 'the owner\'s decrypted key, sent only to the provider');
      const body = sent.at(-1)!.body as Record<string, unknown>;
      assert.equal(body.model, connection.model);
      if (run.wire === 'openai') assert.equal((body.response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
      const row = (await pool.query('SELECT reserved_cents, usage_input_tokens, usage_output_tokens, usage_estimated_cents, connection_id FROM proactive_comparison_outbox WHERE id=$1',
        [candidateId])).rows[0];
      assert.deepEqual(row, { reserved_cents: run.reserved, usage_input_tokens: 300, usage_output_tokens: 90, usage_estimated_cents: run.observed, connection_id: connection.id });
      const proposals = expectStatus(await peer.browser.request('GET', `/api/v1/projects/${projectId}/proactive-comparison-proposals`), 200) as ProactiveComparisonProposal[];
      const proposal = proposals.find((item) => item.resultId === result.id)!;
      assert.deepEqual([proposal.computeSource, proposal.provider, proposal.model], ['owner_background_connection', connection.provider, connection.model]);
    }
    // No key in any stored candidate, proposal, event or job.
    for (const table of ['proactive_comparison_outbox', 'proactive_comparison_proposals', 'events', 'pgboss.job']) {
      const leaked = await pool.query(`SELECT count(*)::int AS n FROM ${table} t WHERE row_to_json(t)::text LIKE $1`, [`%${marker}%`]);
      assert.equal(leaked.rows[0].n, 0, table);
    }
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
    assert.deepEqual([first.usedForBackground, second.usedForBackground, second.name], [true, false, 'Home OpenRouter'], 'adding never replaces');

    const lookup = personalConnectionLookup(db);
    assert.equal((await lookup.resolve(owner.id))?.id, second.id, 'without a choice: the newest, only to describe enabling');
    const named = await lookup.resolve(owner.id, first.id);
    assert.deepEqual([named?.id, named?.provider, named?.model, named?.keyRef, named?.payer.organization], [first.id, 'anthropic', 'claude-sonnet-5', first.id, 'Fixture payer']);
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
    assert.equal(expectStatus(await owner.browser.request('GET', `${path}/current`), 200), null, 'and background comparisons stop');
  });
});
