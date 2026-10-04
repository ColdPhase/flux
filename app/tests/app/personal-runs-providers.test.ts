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
