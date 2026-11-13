import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { apiKeySpendToday, createDatabase } from '@flux/db';
import { createPersonalRunProcessor, type Principal } from '@flux/core';
import { type AssistantRun, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { parsePrivateTargets, providerPersonalCompute } from '../../packages/agent-runtime/src/index.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { chooseModel, FakeConnections, FakeQueue } from './support/personal-runs.js';
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
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });

  test('a key without a known price cannot be picked: its daily budget could not hold, so nothing is turned on (#854)', async () => {
    const unpriced = randomUUID();
    connections.connect(owner.id, unpriced, { provider: 'gemini', model: 'gemini-model', price: null });
    await assert.rejects(runs.enable(human(owner), { agentId, connection: unpriced, model: 'gemini-model' }), { code: 'ASSISTANT_MODEL_UNAVAILABLE' });
    assert.equal((await runs.status(human(owner))).state, 'not_enabled');
    assert.equal((await runs.model(human(owner))).groups.some((group) => group.connection === unpriced), false, 'an unpriced key is not offered in the picker');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id=$1', [owner.id])).rows[0].n, 0);
  });

  for (const target of [
    // One request of a run without tools: 32,000 input and 4,000 output tokens at the key's price (#843 bounds).
    { provider: 'openai_compatible' as const, model: 'llama3.1:8b', baseUrl: `${MOCK}/openai/v1`, wire: 'openai',
      price: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner' as const, checkedOn: null }, reserved: 32_000 + 8_000, paths: ['/openai/v1/chat/completions'] },
    { provider: 'anthropic' as const, model: 'claude-sonnet-5', baseUrl: null, wire: 'anthropic',
      price: { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, source: 'table' as const, checkedOn: '2026-11-12' }, reserved: 64_000 + 40_000,
      paths: ['/anthropic/v1/messages/count_tokens', '/anthropic/v1/messages'] },
  ]) {
    test(`${target.provider}: the model of a key, a run that reserves against the key's daily budget when it starts, the answer names provider and model`, async () => {
      await mock('/__reset', {});
      const enabled = await runs.status(human(owner)).then((status) => status.enablement);
      if (enabled) { await runs.remove(human(owner)); agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id; }
      const connectionId = randomUUID();
      connections.connect(owner.id, connectionId, target);
      await runs.enable(human(owner), { agentId, connection: connectionId, model: target.model });
      const status = await runs.status(human(owner));
      assert.equal(status.state, 'ready');
      assert.deepEqual([status.enablement!.connection, status.enablement!.engine, status.enablement!.model], [connectionId, 'server', target.model]);
      assert.equal(status.today!.budgetCents, 1_000, 'the key\'s one daily budget');

      await mock('/__script', { wire: target.wire, text: 'Fact: the camera fails below 5 lux [S1].', usage: { input: 1_000, output: 100 } });
      const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
      assert.deepEqual(await row(asked.run.id), { status: 'queued', provider: target.provider, model: target.model, reserved_micros: 0, charged_micros: 0, cost_state: 'reserved' },
        'a request waiting its turn holds nothing yet');
      assert.equal(await processor.process(asked.run.id), 'completed');
      const charged = Math.ceil((1_000 * target.price.inputMicrosPerMTok + 100 * target.price.outputMicrosPerMTok) / 1_000_000);
      assert.deepEqual(await row(asked.run.id), { status: 'completed', provider: target.provider, model: target.model, reserved_micros: target.reserved, charged_micros: charged, cost_state: 'observed' });
      const sent = (await mock('/__requests')).requests;
      assert.deepEqual(sent.map((item) => item.path), target.paths);
      assert.ok(sent.every((item) => item.key === KEY));
      const run = expectStatus(await owner.browser.request('GET', `/api/v1/assistant-runs/${asked.run.id}`), 200) as AssistantRun;
      assert.deepEqual(run.answer!.provenance, { provider: target.provider, model: target.model });
      assert.equal(run.answer!.sources.length, 1);
      assert.equal(JSON.stringify(run).includes(KEY), false);
      assert.equal((await runs.status(human(owner))).today!.chargedMicros, charged, 'the key\'s day counts what its runs were charged');
    });
  }
});

// #192 review B1: a run is never charged above its reservation. Usage above the run's token
// limits, or a reconciled cost above the reservation, fails closed like a lost response: cost
// `unknown`, the whole reservation stays counted against the key's daily budget, nothing is posted.
describe('a personal run is never charged above its reservation (#179 PROV-3, #192 B1)', () => {
  let owner: Person;
  let ws: Workspace;
  let thread: Conversation;
  let agentId: string;
  const PRICE = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner' as const, checkedOn: null };
  // 32,000 × $1/M + 4,000 × $2/M = 40,000 micro-dollars: the largest request, reserved when the run starts.
  const RESERVED = 40_000;

  before(async () => {
    owner = await person('pr-bound-owner');
    ws = await createWorkspace(owner, 'Bounded assistant charges');
    const place = await createProject(owner, ws.id, 'Lamp sensor bound', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });

  async function runOn(target: { provider: 'openai_compatible' | 'openrouter'; model: string; baseUrl: string | null }, script: Record<string, unknown>) {
    await mock('/__reset', {});
    if ((await runs.status(human(owner))).enablement) { await runs.remove(human(owner)); agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id; }
    const key = randomUUID();
    connections.connect(owner.id, key, { ...target, price: PRICE });
    await runs.enable(human(owner), { agentId, connection: key, model: target.model });
    await mock('/__script', { wire: 'openai', text: 'Fact: the camera fails below 5 lux [S1].', ...script });
    const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    const outcome = await processor.process(asked.run.id);
    const stored = (await pool.query('SELECT status, reserved_micros, charged_micros, cost_state, input_tokens, output_tokens FROM personal_runs WHERE id=$1', [asked.run.id])).rows[0];
    // The answer of `/ai` is the asker's own: the run holds it, and nothing of it is public (#842).
    const run = expectStatus(await owner.browser.request('GET', `/api/v1/assistant-runs/${asked.run.id}`), 200) as AssistantRun;
    return { outcome, stored, posted: run.answer !== null };
  }

  const compatible = { provider: 'openai_compatible' as const, model: 'llama3.1:8b', baseUrl: `${MOCK}/openai/v1` };
  const openrouter = { provider: 'openrouter' as const, model: 'vendor/model', baseUrl: null };
  for (const [name, target, script] of [
    ['reported input above the 32,000-token bound (80,200 µ$ > 40,000 µ$)', compatible, { usage: { input: 80_000, output: 100 } }],
    ['reported output above the 4,000-token bound', compatible, { usage: { input: 1_000, output: 4_001 } }],
    ['an OpenRouter usage.cost above the reservation', openrouter, { usage: { input: 1_000, output: 100 }, cost: 0.040001 }],
    ['an OpenRouter usage.cost too large for the integer charge column', openrouter, { usage: { input: 1_000, output: 100 }, cost: 1_000_000 }],
    ['reported tokens too large for the integer token columns', compatible, { usage: { input: 3_000_000_000, output: 100 } }],
  ] as const) {
    test(`${name}: fails closed as unknown, the reservation stays counted, nothing is posted`, async () => {
      const { outcome, stored, posted } = await runOn(target, script);
      assert.equal(outcome, 'provider_failed');
      assert.deepEqual(stored, { status: 'provider_failed', reserved_micros: RESERVED, charged_micros: 0, cost_state: 'unknown', input_tokens: null, output_tokens: null });
      assert.equal(posted, false, 'the answer of an out-of-bounds response is withheld');
      const today = (await runs.status(human(owner))).today!;
      assert.deepEqual([today.chargedMicros, today.reservedMicros], [RESERVED, 0],
        'the key\'s daily budget counts the most an unknown run could have cost, and no charge above it');
    });
  }

  test('a reported cost at the reservation, and usage at the token limits, still reconcile as observed', async () => {
    const atCeiling = await runOn(openrouter, { usage: { input: 1_000, output: 100 }, cost: 0.04 });
    assert.deepEqual([atCeiling.outcome, atCeiling.stored, atCeiling.posted], ['completed',
      { status: 'completed', reserved_micros: RESERVED, charged_micros: RESERVED, cost_state: 'observed', input_tokens: 1_000, output_tokens: 100 }, true]);
    const atLimits = await runOn(compatible, { usage: { input: 32_000, output: 4_000 } });
    assert.deepEqual([atLimits.outcome, atLimits.stored, atLimits.posted], ['completed',
      { status: 'completed', reserved_micros: RESERVED, charged_micros: RESERVED, cost_state: 'observed', input_tokens: 32_000, output_tokens: 4_000 }, true]);
    const today = (await runs.status(human(owner))).today!;
    assert.deepEqual([today.chargedMicros, today.reservedMicros], [RESERVED, 0], 'the key of the last run was charged exactly its observed cost');
  });
});

// F-027 AST-11 (#596), Connect AI (#854): the model of an agent, picked from any of its owner's connections in one list grouped by
// connection, with Connect AI's default (the connection made first) preselected. The run is reserved, sent and recorded at the
// chosen model, and a change reaches the next request only. Picking a model of another connection moves the assistant there.
describe('the assistant\'s model from any connection (F-027 AST-11, #854)', () => {
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
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'human', id: viewer.id }, role: 'contributor' } }), 201);
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    // The key's models as its provider listed them (#1218): the only source of the picker's list.
    const listed = (id: string, family: string, createdAt: string) => ({ id, name: null, family, createdAt });
    connections.connect(owner.id, sonnet5, { provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: null, models: {
      listed: [listed('claude-sonnet-5', 'Sonnet', '2026-06-01T00:00:00Z'), listed('claude-sonnet-5-5', 'Sonnet', '2026-09-28T00:00:00Z'),
        listed('claude-opus-5-5', 'Opus', '2026-09-21T00:00:00Z'), listed('claude-haiku-5-5', 'Haiku', '2026-10-07T00:00:00Z'),
        listed('claude-fable-5-2', 'Fable', '2026-11-05T00:00:00Z')],
      listedAt: new Date(), checkedAt: new Date(), status: 'listed', prices: {}, retired: [] } });
  });

  test('AST-11.1/AST-11.5: the grouped list, a choice at turn-on, the request at the chosen model; a change reaches the next request only', async () => {
    let choice = await runs.model(human(owner));
    assert.deepEqual([choice.current, choice.default, choice.saved], [null, { connection: sonnet5, model: 'claude-sonnet-5' }, false]);
    assert.equal(choice.groups.length, 1);
    assert.deepEqual([choice.groups[0]!.connection, choice.groups[0]!.account, choice.groups[0]!.company], [sonnet5, 'api_key', 'Anthropic']);
    assert.deepEqual(choice.groups[0]!.options.map((option) => [option.id, option.name, option.note, option.callsTools]), [
      // By family, the family with the newest model first (#1218).
      ['claude-fable-5-2', 'Fable 5.2', 'Input $8, output $40 per 1M tokens', true],
      ['claude-haiku-5-5', 'Haiku 5.5', 'Input $0.50, output $2.50 per 1M tokens', true],
      ['claude-sonnet-5-5', 'Sonnet 5.5', 'Input $2, output $10 per 1M tokens', true],
      ['claude-sonnet-5', 'Sonnet 5', 'Input $2, output $10 per 1M tokens', true],
      ['claude-opus-5-5', 'Opus 5.5', 'Input $4, output $20 per 1M tokens', true],
    ]);
    // A model outside the key's list, or another provider's, is refused at turn-on and nothing is turned on.
    for (const bad of ['gpt-6-sol', 'sonnet', '--model']) {
      await assert.rejects(runs.enable(human(owner), { agentId, connection: sonnet5, model: bad }),
        { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Your API key doesn\'t offer that model. Nothing was turned on.' }, bad);
    }
    // A plan the person is not signed in to is not theirs to pick.
    await assert.rejects(runs.enable(human(owner), { agentId, connection: 'claude_plan', model: 'sonnet' }),
      { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Sign in to Claude first. Nothing was turned on.' });
    assert.equal((await runs.status(human(owner))).state, 'not_enabled');

    await mock('/__reset', {});
    const enabled = await runs.enable(human(owner), { agentId, connection: sonnet5, model: 'claude-haiku-5-5' });
    assert.deepEqual([enabled.model.connection, enabled.model.model], [sonnet5, 'claude-haiku-5-5']);
    choice = await runs.model(human(owner));
    assert.deepEqual([choice.current, choice.saved], [{ connection: sonnet5, model: 'claude-haiku-5-5' }, true]);

    await mock('/__script', { wire: 'anthropic', text: 'Fact: the camera fails below 5 lux [S1].', usage: { input: 1_000, output: 100 } });
    const first = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    // The next request is sent with the new model; this one keeps Haiku even though the choice changes before it runs.
    choice = await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-sonnet-5' });
    assert.deepEqual(choice.current, { connection: sonnet5, model: 'claude-sonnet-5' });
    assert.deepEqual(await row(first.run.id), { status: 'queued', provider: 'anthropic', model: 'claude-haiku-5-5', reserved_micros: 0, charged_micros: 0, cost_state: 'reserved' });
    assert.equal(await processor.process(first.run.id), 'completed');
    const sent = (await mock('/__requests')).requests.filter((item) => item.path === '/anthropic/v1/messages');
    assert.equal((sent[0]!.body as { model: string }).model, 'claude-haiku-5-5', 'the request sent before the change used Haiku');
    assert.deepEqual([(await row(first.run.id)).reserved_micros, (await row(first.run.id)).charged_micros], [16_000 + 10_000, 500 + 250], 'reserved and charged at the Haiku table price');
    const second = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
    assert.equal(await processor.process(second.run.id), 'completed');
    assert.equal(((await mock('/__requests')).requests.filter((item) => item.path === '/anthropic/v1/messages').at(-1)!.body as { model: string }).model, 'claude-sonnet-5');
  });

  test('AST-11.1: another provider\'s model, a bad id or a connection the person does not have is refused with the exact copy and the previous model stays', async () => {
    const refusals: [{ connection: string; model: string }, string][] = [
      [{ connection: sonnet5, model: 'gpt-6-sol' }, 'Your API key doesn\'t offer that model. It is still Sonnet 5.'],
      [{ connection: sonnet5, model: 'not a model id' }, 'Your API key doesn\'t offer that model. It is still Sonnet 5.'],
      [{ connection: randomUUID(), model: 'claude-sonnet-5' }, 'Connect that API key first. It is still Sonnet 5.'],
      [{ connection: 'chatgpt_plan', model: 'gpt-6.1-sol' }, 'Sign in to ChatGPT first. It is still Sonnet 5.'],
    ];
    for (const [pick, message] of refusals) {
      await assert.rejects(chooseModel(runs, human(owner), pick), { code: 'ASSISTANT_MODEL_UNAVAILABLE', message }, JSON.stringify(pick));
    }
    assert.deepEqual((await runs.model(human(owner))).current, { connection: sonnet5, model: 'claude-sonnet-5' });
    // Choosing the same model again changes nothing; a costly model is fine: there is no per-request limit (#843).
    const version = (await runs.status(human(owner))).enablement!.version;
    await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-sonnet-5' });
    assert.equal((await runs.status(human(owner))).enablement!.version, version);
    await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-fable-5-2' });
    await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-sonnet-5' });
  });

  test('#854: several connections at once; the picker is grouped by connection in the order they were made, and a model of another moves the assistant there', async () => {
    const other = await person('pr-model-several-owner');
    const first = randomUUID();
    const second = randomUUID();
    connections.connect(other.id, first, { provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: `${MOCK}/openai/v1`,
      price: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner', checkedOn: null } });
    connections.connect(other.id, second, { provider: 'openai', model: 'gpt-6-luna' });
    const choice = await runs.model(human(other));
    assert.deepEqual(choice.groups.map((group) => group.connection), [first, second], 'one group per connection, the first made first');
    assert.deepEqual(choice.default, { connection: first, model: 'llama3.1:8b' }, 'Connect AI\'s default is the connection made first');
    assert.deepEqual(choice.groups[0]!.options.map((option) => [option.id, option.name]), [['llama3.1:8b', 'llama3.1:8b']], 'an own endpoint offers only its own model');
    assert.deepEqual(choice.groups[1]!.options.map((option) => [option.id, option.callsTools]), [['gpt-6-luna', true]],
      'a key whose provider has not listed its models yet offers only its own model: Flux keeps no list of its own (#1218)');
  });

  test('AST-11.2: only the owner reads or changes the model; anyone else gets their own empty answer or a refusal', async () => {
    for (const someone of [viewer, guest]) {
      const theirs = await runs.model(human(someone));
      assert.deepEqual([theirs.groups, theirs.current, theirs.default, theirs.saved], [[], null, null, false]);
      await assert.rejects(runs.updateAgent(human(someone), agentId, { connection: sonnet5, model: 'claude-haiku-5-5' }), { code: 'AGENT_NOT_FOUND' }, 'another person\'s agent is not found');
    }
    assert.deepEqual((await runs.model(human(owner))).current, { connection: sonnet5, model: 'claude-sonnet-5' }, 'nobody else changed it');
    // Over HTTP (the API container's own lookup does not hold this test's fake keys): a viewer or guest sees nothing of the owner's.
    for (const [someone, current] of [[viewer, null], [guest, null], [owner, { connection: sonnet5, model: 'claude-sonnet-5' }]] as const) {
      const read = expectStatus(await someone.browser.request('GET', '/api/v1/personal-assistant/model'), 200) as { groups: unknown[]; current: unknown };
      assert.deepEqual([read.groups, read.current], [[], current], 'the API container offers this account no list; only the owner sees their own stored model');
    }
    for (const someone of [viewer, guest]) {
      const refused = await someone.browser.request('PATCH', `/api/v1/my-agents/${agentId}`, { body: { connection: sonnet5, model: 'claude-haiku-5-5' } });
      assert.equal(refused.status, 404, refused.text);
      assert.equal((refused.json as { code: string }).code, 'AGENT_NOT_FOUND');
    }
    const anonymous = await fetch(`${process.env.FLUX_API_URL ?? 'http://api:8080'}/api/v1/personal-assistant/model`);
    assert.equal(anonymous.status, 401);
  });
});

// #854, #843: no payer switching and one daily budget. A removed key pauses its assistant even when another connection exists;
// a request that finds the key's budget used waits, queued, for the key's next day, and nothing is sent to anyone.
describe('no payer switching; the API key\'s one daily budget pauses a request until the next day (#854, #843)', () => {
  let owner: Person;
  let ws: Workspace;
  let thread: Conversation;
  let agentId: string;

  before(async () => {
    owner = await person('pr-budget-owner');
    ws = await createWorkspace(owner, 'Budget assistant');
    const place = await createProject(owner, ws.id, 'Lamp sensor budget', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
  });

  test('a removed key stops its assistant; it never switches to the owner\'s other connection and nothing is sent', async () => {
    const used = randomUUID();
    const spare = randomUUID();
    connections.connect(owner.id, used, { provider: 'anthropic', model: 'claude-sonnet-5' });
    connections.connect(owner.id, spare, { provider: 'openai', model: 'gpt-6-luna' });
    await runs.enable(human(owner), { agentId, connection: used, model: 'claude-sonnet-5' });
    connections.disconnect(owner.id, used);
    const status = await runs.status(human(owner));
    assert.deepEqual([status.state, status.unavailableReason, status.enablement!.connection], ['unavailable', 'connection_changed', used]);
    const before = (await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id=$1', [owner.id])).rows[0].n;
    await assert.rejects(runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' }), { code: 'PERSONAL_RUN_UNAVAILABLE' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id=$1', [owner.id])).rows[0].n, before, 'nothing ran on the spare key');
    // Only the owner's own pick moves it: then the next request goes to the other connection.
    await chooseModel(runs, human(owner), { connection: spare, model: 'gpt-6-luna' });
    assert.equal((await runs.status(human(owner))).state, 'ready');
    await runs.remove(human(owner));
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
  });

  test('at the key\'s budget a request waits for the next day, with one line and no switch; the assistant reads "capped"', async () => {
    const tiny = randomUUID();
    // A model whose one request is above the key's whole budget would wait for a day that never comes: it is refused.
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 10 });
    await assert.rejects(runs.enable(human(owner), { agentId, connection: tiny, model: 'claude-sonnet-5' }), /can cost more than this key's daily budget/);
    // One request with tools and Anthropic's own web search (#954): (64,000 + 50,000 for the results) × $2/M + 4,000 × $10/M = $0.268;
    // the searches themselves are charged as reported, not reserved (#1113).
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 26 });
    await assert.rejects(runs.enable(human(owner), { agentId, connection: tiny, model: 'claude-sonnet-5' }), /can cost more than this key's daily budget/);
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 27 });
    await runs.enable(human(owner), { agentId, connection: tiny, model: 'claude-sonnet-5' });
    // $0.10 left of the day: less than one largest request of Sonnet 5 (32,000 × $2/M + 4,000 × $10/M = $0.104).
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 10 });
    const status = await runs.status(human(owner));
    assert.deepEqual([status.state, status.today!.budgetCents], ['capped', 10]);
    const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    assert.equal(asked.run.status, 'queued');
    assert.equal(asked.run.endReason, 'budget');
    assert.ok(asked.run.resumesAt && Date.parse(asked.run.resumesAt) > Date.now(), 'it resumes when the key\'s next day starts');
    assert.equal(queue.runIds.includes(asked.run.id), false, 'a paused request is not dispatched now');
    assert.equal(await processor.process(asked.run.id), 'skipped', 'the worker does not start it before its resume time');
    assert.equal((await row(asked.run.id)).status, 'queued');
    await runs.stop(human(owner), asked.run.id);
    await runs.remove(human(owner));
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
  });

  test('#910: a key\'s day ends at the next local midnight, also on a day the clocks change', async () => {
    const resets = async (timeZone: string, at: string) => (await apiKeySpendToday(db, randomUUID(), undefined, { dailyBudgetCents: 500, timeZone }, new Date(at)))!.resetsAt.toISOString();
    // Warsaw leaves summer time on 25 Oct 2026 (a 25-hour day) and enters it on 28 Mar 2027 (a 23-hour day): 24 hours on would be an hour off.
    assert.equal(await resets('Europe/Warsaw', '2026-10-25T10:00:00Z'), '2026-10-25T23:00:00.000Z');
    assert.equal(await resets('Europe/Warsaw', '2027-03-28T10:00:00Z'), '2027-03-28T22:00:00.000Z');
    assert.equal(await resets('Europe/Warsaw', '2026-11-07T10:00:00Z'), '2026-11-07T23:00:00.000Z');
    assert.equal(await resets('UTC', '2026-11-07T10:00:00Z'), '2026-11-08T00:00:00.000Z');
  });

  test('#915: where the clocks go back at midnight (Havana, 1 Nov 2026) the day begins at the first midnight, and the day before ends there', async () => {
    const window = async (at: string) => (await apiKeySpendToday(db, randomUUID(), undefined, { dailyBudgetCents: 500, timeZone: 'America/Havana' }, new Date(at)))!.resetsAt.toISOString();
    // Midnight of 1 Nov comes twice: 04:00Z (summer time) and 05:00Z (winter time). The eve ends at the first.
    assert.equal(await window('2026-10-31T12:00:00Z'), '2026-11-01T04:00:00.000Z');
    // The day that follows begins at the same instant, so its first hour counts in it, and it ends at the next midnight, which is single.
    assert.equal(await window('2026-11-01T04:30:00Z'), '2026-11-02T05:00:00.000Z');
    assert.equal(await window('2026-11-01T05:30:00Z'), '2026-11-02T05:00:00.000Z');
    assert.equal(await window('2026-11-01T20:00:00Z'), '2026-11-02T05:00:00.000Z');
  });
});
