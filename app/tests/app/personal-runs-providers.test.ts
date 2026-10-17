import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { createPersonalRunProcessor, type Principal } from '@flux/core';
import { PERSONAL_RUN_CONSENT_VERSION, type AssistantAnswer, type Conversation, type Page, type Project, type Workspace } from '@flux/contracts';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// One provider-neutral path for personal runs (#68, #179 F-020 PROV-2/PROV-3): the same use cases,
// worker processor, rechecks, reservation and commit, with the REAL adapter registry selecting the
// wire format by the connection's provider, against the Docker provider mock. The connection lookup
// is the test fake (production still composes none, #68); no real provider is called.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());

const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const KEY = `local-${'owner-budget-key-'.repeat(3)}PR01`;
const connections = new FakeConnections();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const compute = providerPersonalCompute({ enabled: true, policy: parsePrivateTargets(new URL(MOCK).hostname), timeoutMs: 5_000,
  baseUrls: { anthropic: `${MOCK}/anthropic`, openrouter: `${MOCK}/openai/v1` }, resolveKey: async (keyRef) => (keyRef.startsWith('test-key-ref-') ? KEY : null) });
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20 });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

async function mock(path: string, body?: unknown) {
  const response = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.json() as Promise<{ requests: RecordedProviderRequest[] }>;
}
async function row(runId: string) {
  return (await pool.query('SELECT status, provider, model, reserved_micros, charged_micros, cost_state FROM personal_runs WHERE id=$1', [runId])).rows[0];
}

describe('personal runs on any provider through the same path (#179)', () => {
  let owner: Person;
  let ws: Workspace;
  let place: Project;
  let thread: Conversation;
  let agentId: string;

  before(async () => {
    owner = await person('pr-provider-owner');
    ws = await createWorkspace(owner, 'Provider-neutral assistant');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });

  test('a connection without a known price, or one too costly for the per-run limit, cannot be enabled or run', async () => {
    connections.connect(owner.id, randomUUID(), { provider: 'gemini', model: 'gemini-model', price: null });
    await assert.rejects(runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId }), { code: 'PERSONAL_RUN_PRICE_UNKNOWN' });
    // 16,000 × $30/M + 1,500 × $60/M = $0.57 per run, above the $0.50 maximum per-run limit.
    connections.connect(owner.id, randomUUID(), { provider: 'openai', model: 'gpt-model', price: { inputMicrosPerMTok: 30_000_000, outputMicrosPerMTok: 60_000_000, source: 'owner', checkedOn: null } });
    await assert.rejects(runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, perRunCents: 50 }), { code: 'PERSONAL_RUN_COST_OVER_LIMIT' });
    assert.equal((await runs.status(human(owner))).state, 'not_enabled');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id=$1', [owner.id])).rows[0].n, 0);
  });

  for (const target of [
    { provider: 'openai_compatible' as const, model: 'llama3.1:8b', baseUrl: `${MOCK}/openai/v1`, wire: 'openai',
      price: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner' as const, checkedOn: null }, reserved: 16_000 + 3_000, paths: ['/openai/v1/chat/completions'] },
    { provider: 'anthropic' as const, model: 'claude-sonnet-5', baseUrl: null, wire: 'anthropic',
      price: { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, source: 'table' as const, checkedOn: '2026-10-02' }, reserved: 47_000,
      paths: ['/anthropic/v1/messages/count_tokens', '/anthropic/v1/messages'] },
  ]) {
    test(`${target.provider}: consent names the connection, the run reserves its largest request, the answer names provider and model`, async () => {
      await mock('/__reset', {});
      const enabled = await runs.status(human(owner)).then((status) => status.enablement);
      if (enabled) await runs.remove(human(owner));
      const connectionId = randomUUID();
      connections.connect(owner.id, connectionId, target);
      const status = await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, perRunCents: 6, dailyCapCents: 100 });
      assert.equal(status.state, 'ready');
      assert.deepEqual([status.disclosure.provider, status.disclosure.model, status.disclosure.price, status.disclosure.maxRunMicros],
        [target.provider, target.model, target.price, target.reserved]);
      assert.deepEqual([status.enablement!.consent.provider, status.enablement!.consent.model], [target.provider, target.model]);

      await mock('/__script', { wire: target.wire, text: 'Fact: the camera fails below 5 lux [S1].', usage: { input: 1_000, output: 100 } });
      const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
      assert.deepEqual(await row(asked.run.id), { status: 'queued', provider: target.provider, model: target.model, reserved_micros: target.reserved, charged_micros: 0, cost_state: 'reserved' });
      assert.equal(await processor.process(asked.run.id), 'completed');
      const charged = Math.ceil((1_000 * target.price.inputMicrosPerMTok + 100 * target.price.outputMicrosPerMTok) / 1_000_000);
      assert.deepEqual(await row(asked.run.id), { status: 'completed', provider: target.provider, model: target.model, reserved_micros: target.reserved, charged_micros: charged, cost_state: 'observed' });
      const sent = (await mock('/__requests')).requests;
      assert.deepEqual(sent.map((item) => item.path), target.paths);
      assert.ok(sent.every((item) => item.key === KEY));
      const answers = expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`), 200) as Page<AssistantAnswer>;
      const answer = answers.items.find((item) => item.runId === asked.run.id)!;
      assert.deepEqual(answer.provenance, { provider: target.provider, model: target.model });
      assert.equal(answer.sources.length, 1);
      assert.equal(JSON.stringify(answers).includes(KEY), false);
    });
  }
});

// #192 review B1: a run is never charged above its reservation. Usage above the run's token
// limits, or a reconciled cost above the reservation, fails closed like a lost response: cost
// `unknown`, the whole reservation stays counted against the daily cap, nothing is posted.
describe('a personal run is never charged above its reservation (#179 PROV-3, #192 B1)', () => {
  let owner: Person;
  let thread: Conversation;
  let agentId: string;
  const PRICE = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner' as const, checkedOn: null };
  // 16,000 × $1/M + 1,500 × $2/M = 19,000 micro-dollars, within the $0.06 per-run limit.
  const RESERVED = 19_000;
  let unknownRuns = 0;
  let chargedToday = 0;

  before(async () => {
    owner = await person('pr-bound-owner');
    const ws = await createWorkspace(owner, 'Bounded assistant charges');
    const place = await createProject(owner, ws.id, 'Lamp sensor bound', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });

  async function runOn(target: { provider: 'openai_compatible' | 'openrouter'; model: string; baseUrl: string | null }, script: Record<string, unknown>) {
    await mock('/__reset', {});
    if ((await runs.status(human(owner))).enablement) await runs.remove(human(owner));
    connections.connect(owner.id, randomUUID(), { ...target, price: PRICE });
    const status = await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, perRunCents: 6, dailyCapCents: 100 });
    assert.equal(status.disclosure.maxRunMicros, RESERVED);
    await mock('/__script', { wire: 'openai', text: 'Fact: the camera fails below 5 lux [S1].', ...script });
    const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    const outcome = await processor.process(asked.run.id);
    const stored = (await pool.query('SELECT status, reserved_micros, charged_micros, cost_state, input_tokens, output_tokens FROM personal_runs WHERE id=$1', [asked.run.id])).rows[0];
    const answers = expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`), 200) as Page<AssistantAnswer>;
    return { outcome, stored, posted: answers.items.some((item) => item.runId === asked.run.id) };
  }

  const compatible = { provider: 'openai_compatible' as const, model: 'llama3.1:8b', baseUrl: `${MOCK}/openai/v1` };
  const openrouter = { provider: 'openrouter' as const, model: 'vendor/model', baseUrl: null };
  for (const [name, target, script] of [
    ['reported input above the 16,000-token limit (the review reproduction: 40,200 µ$ > 19,000 µ$)', compatible, { usage: { input: 40_000, output: 100 } }],
    ['reported output above the 1,500-token limit', compatible, { usage: { input: 1_000, output: 1_501 } }],
    ['an OpenRouter usage.cost above the reservation', openrouter, { usage: { input: 1_000, output: 100 }, cost: 0.019001 }],
    ['an OpenRouter usage.cost too large for the integer charge column', openrouter, { usage: { input: 1_000, output: 100 }, cost: 1_000_000 }],
    ['reported tokens too large for the integer token columns', compatible, { usage: { input: 3_000_000_000, output: 100 } }],
  ] as const) {
    test(`${name}: fails closed as unknown, the reservation stays counted, nothing is posted`, async () => {
      const { outcome, stored, posted } = await runOn(target, script);
      assert.equal(outcome, 'provider_failed');
      assert.deepEqual(stored, { status: 'provider_failed', reserved_micros: RESERVED, charged_micros: 0, cost_state: 'unknown', input_tokens: null, output_tokens: null });
      assert.equal(posted, false, 'the answer of an out-of-bounds response is withheld');
      unknownRuns++;
      const today = (await runs.status(human(owner))).today!;
      assert.deepEqual([today.chargedMicros, today.reservedMicros], [chargedToday, unknownRuns * RESERVED],
        'the daily cap counts the whole reservation of every unknown run and no charge above it');
    });
  }

  test('a reported cost at the reservation, and usage at the token limits, still reconcile as observed', async () => {
    const atCeiling = await runOn(openrouter, { usage: { input: 1_000, output: 100 }, cost: 0.019 });
    assert.deepEqual([atCeiling.outcome, atCeiling.stored, atCeiling.posted], ['completed',
      { status: 'completed', reserved_micros: RESERVED, charged_micros: RESERVED, cost_state: 'observed', input_tokens: 1_000, output_tokens: 100 }, true]);
    const atLimits = await runOn(compatible, { usage: { input: 16_000, output: 1_500 } });
    assert.deepEqual([atLimits.outcome, atLimits.stored, atLimits.posted], ['completed',
      { status: 'completed', reserved_micros: RESERVED, charged_micros: RESERVED, cost_state: 'observed', input_tokens: 16_000, output_tokens: 1_500 }, true]);
    chargedToday += 2 * RESERVED;
    const today = (await runs.status(human(owner))).today!;
    assert.deepEqual([today.chargedMicros, today.reservedMicros], [chargedToday, unknownRuns * RESERVED]);
  });
});

// F-027 AST-11 (#596): the assistant's model on an API key. The list is the connection's own model and the provider's models that
// have a table price; the run is reserved, sent and recorded at the chosen model, and a change reaches the next request only.
describe('the assistant\'s model on an API key (F-027 AST-11, #596)', () => {
  let owner: Person; let viewer: Person; let guest: Person;
  let thread: Conversation;
  let agentId: string;
  const sonnet5 = randomUUID();

  before(async () => {
    owner = await person('pr-model-owner');
    viewer = await person('pr-model-viewer');
    guest = await person('pr-model-guest');
    const ws = await createWorkspace(owner, 'Assistant model');
    const place = await createProject(owner, ws.id, 'Lamp sensor model', 'workspace');
    expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: viewer.email, role: 'member' } }), 201);
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'human', id: viewer.id }, role: 'viewer' } }), 201);
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    connections.connect(owner.id, sonnet5, { provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: null });
  });

  test('AST-11.1/AST-11.5: the list, a choice at turn-on, the reservation and the request at the chosen model; a change reaches the next request only', async () => {
    let choice = await runs.model(human(owner));
    assert.deepEqual([choice.engine, choice.account, choice.company, choice.current, choice.default, choice.saved], ['server', 'api_key', 'Anthropic', 'claude-sonnet-5', 'claude-sonnet-5', false]);
    assert.deepEqual(choice.options.map((option) => [option.id, option.name, option.note, option.callsTools]), [
      ['claude-sonnet-5', 'Sonnet 5', 'Your connection\'s model', true],
      ['claude-sonnet-5-5', 'Sonnet 5.5', 'Input $2, output $10 per 1M tokens', true],
      ['claude-haiku-4-5', 'Haiku 4.5', 'Input $1, output $5 per 1M tokens', true],
      ['claude-fable-5-1', 'Fable 5.1', 'Input $10, output $50 per 1M tokens', true],
    ]);
    // A model outside the list, or from another provider, is refused at turn-on and nothing is turned on.
    for (const bad of ['gpt-6-sol', 'sonnet', '--model']) {
      await assert.rejects(runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, model: bad }),
        { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Your API key\'s provider doesn\'t offer that model. Nothing was turned on.' }, bad);
    }
    assert.equal((await runs.status(human(owner))).state, 'not_enabled');

    await mock('/__reset', {});
    const status = await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, model: 'claude-haiku-4-5', perRunCents: 6, dailyCapCents: 100 });
    assert.deepEqual([status.enablement!.model, status.disclosure.model, status.disclosure.maxRunMicros], ['claude-haiku-4-5', 'claude-haiku-4-5', 16_000 + 7_500],
      'the disclosure names the chosen model and its table price');
    assert.deepEqual([status.enablement!.consent.model], ['claude-sonnet-5'], 'the consent still names the connection');
    choice = await runs.model(human(owner));
    assert.deepEqual([choice.current, choice.saved], ['claude-haiku-4-5', true]);

    await mock('/__script', { wire: 'anthropic', text: 'Fact: the camera fails below 5 lux [S1].', usage: { input: 1_000, output: 100 } });
    const first = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    // The next request is sent with the new model; this one keeps Haiku even though the choice changes before it runs.
    choice = await runs.chooseModel(human(owner), { model: 'claude-sonnet-5' });
    assert.equal(choice.current, 'claude-sonnet-5');
    assert.deepEqual(await row(first.run.id), { status: 'queued', provider: 'anthropic', model: 'claude-haiku-4-5', reserved_micros: 23_500, charged_micros: 0, cost_state: 'reserved' });
    assert.equal(await processor.process(first.run.id), 'completed');
    const sent = (await mock('/__requests')).requests.filter((item) => item.path === '/anthropic/v1/messages');
    assert.equal((sent[0]!.body as { model: string }).model, 'claude-haiku-4-5', 'the request sent before the change used Haiku');
    assert.equal((await row(first.run.id)).charged_micros, 1_000 + 500, 'charged at the Haiku table price');
    const second = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
    assert.deepEqual(await row(second.run.id), { status: 'queued', provider: 'anthropic', model: 'claude-sonnet-5', reserved_micros: 47_000, charged_micros: 0, cost_state: 'reserved' });
    assert.equal(await processor.process(second.run.id), 'completed');
    assert.equal(((await mock('/__requests')).requests.filter((item) => item.path === '/anthropic/v1/messages').at(-1)!.body as { model: string }).model, 'claude-sonnet-5');
  });

  test('AST-11.1: a model that costs more than the per-request limit, another provider\'s model or a bad id is refused with the exact copy and the previous model stays', async () => {
    const refusals: [string, string][] = [
      ['claude-fable-5-1', 'One request to Fable 5.1 can cost more than your per-request limit. It is still Sonnet 5.'],
      ['gpt-6-sol', 'Your API key\'s provider doesn\'t offer that model. It is still Sonnet 5.'],
      ['not a model id', 'Your API key\'s provider doesn\'t offer that model. It is still Sonnet 5.'],
    ];
    for (const [model, message] of refusals) {
      await assert.rejects(runs.chooseModel(human(owner), { model }), { code: 'ASSISTANT_MODEL_UNAVAILABLE', message }, model);
    }
    assert.equal((await runs.model(human(owner))).current, 'claude-sonnet-5');
    // Choosing the same model again changes nothing.
    const version = (await runs.status(human(owner))).enablement!.version;
    await runs.chooseModel(human(owner), { model: 'claude-sonnet-5' });
    assert.equal((await runs.status(human(owner))).enablement!.version, version);
  });

  test('AST-11.1: a connection on its own endpoint offers only its own model (no other has a table price) and a model without tool calling says so', async () => {
    const other = await person('pr-model-endpoint-owner');
    connections.connect(other.id, randomUUID(), { provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: `${MOCK}/openai/v1`,
      price: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner', checkedOn: null } });
    const own = await runs.model(human(other));
    assert.deepEqual(own.options.map((option) => [option.id, option.name]), [['llama3.1:8b', 'llama3.1:8b']]);
    connections.connect(other.id, randomUUID(), { provider: 'openai', model: 'gpt-6-luna' });
    const openai = await runs.model(human(other));
    assert.deepEqual(openai.options.map((option) => [option.id, option.callsTools]), [['gpt-6-luna', true], ['gpt-6-sol', true], ['gpt-6.1-sol', false], ['gpt-6-astra', false]],
      'GPT-6.1 Sol and GPT-6 Astra can answer but can\'t make changes on Chat Completions (AST-8.3)');
  });

  test('AST-11.2: only the owner reads or changes the model; anyone else gets their own empty answer or a refusal', async () => {
    for (const someone of [viewer, guest]) {
      const theirs = await runs.model(human(someone));
      assert.deepEqual([theirs.engine, theirs.company, theirs.options, theirs.saved], [null, null, [], false]);
      await assert.rejects(runs.chooseModel(human(someone), { model: 'claude-haiku-4-5' }), { code: 'PERSONAL_RUN_NOT_ENABLED' });
    }
    assert.equal((await runs.model(human(owner))).current, 'claude-sonnet-5', 'nobody else changed it');
    // Over HTTP (the API container composes no connections): a viewer or guest sees nothing of the owner's, and cannot change anything.
    for (const [someone, current] of [[viewer, ''], [guest, ''], [owner, 'claude-sonnet-5']] as const) {
      const read = expectStatus(await someone.browser.request('GET', '/api/v1/personal-assistant/model'), 200) as { options: unknown[]; current: string };
      assert.deepEqual([read.options, read.current], [[], current], 'the API container offers this account no list; only the owner sees their own stored model');
    }
    for (const someone of [viewer, guest]) {
      const refused = await someone.browser.request('PUT', '/api/v1/personal-assistant/model', { body: { model: 'claude-haiku-4-5' } });
      assert.equal(refused.status, 409, refused.text);
      assert.equal((refused.json as { code: string }).code, 'PERSONAL_RUN_NOT_ENABLED');
    }
    const anonymous = await fetch(`${process.env.FLUX_API_URL ?? 'http://api:8080'}/api/v1/personal-assistant/model`);
    assert.equal(anonymous.status, 401);
  });
});

