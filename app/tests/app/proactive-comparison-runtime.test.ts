import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  backgroundComparisonsEnabled, collectComparisonSourceChanges, COMPARISON_RECOVERY_JOB, COMPARISON_TICK_JOB, type ComparisonProvider, type Principal,
} from '@flux/core';
import { createDatabase } from '@flux/db';
import type { BackgroundComputeConnection, ProactiveComparisonRule, Project, Workspace } from '@flux/contracts';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { comparisonRuleUseCases } from '../../apps/server/src/proactive-comparison/routes.js';
import { registerComparisonWorker } from '../../apps/worker/src/proactive-comparison/index.js';
import { comparisonScheduling } from '../../apps/worker/src/proactive-comparison/scheduling-adapter.js';
import { comparisonSchedulingTick } from '../../apps/worker/src/proactive-comparison/scheduling.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { Browser } from './support/http.js';
import { expectStatus, person, project as createProject, workspace, type Person } from './support/people.js';

// The background comparison runtime switch (#58): `FLUX_BACKGROUND_COMPARISONS=on` lets owners enable
// rules and registers the worker's scheduling, dispatch and recovery jobs; off keeps both off.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

const ruleBody = (agentId: string) => ({ agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
  dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal', maxRunsPerDay: 1, periodBudgetCents: 25, perRunCents: 5 });
const connectionBody = {
  provider: 'anthropic', model: 'claude-sonnet-5', apiKey: `sk-ant-api03-${'owner-budget-key-'.repeat(4)}END9`,
  payerOrganization: 'Example payer org', providerWorkspace: 'Dedicated maker workspace', workspaceScopedKeyConfirmed: true,
  payerAuthorityConfirmed: true, providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
  maxRunsPerDay: 1, periodDays: 30, periodBudgetCents: 50, perRunCents: 5,
};
// No candidate is ready in these tests, so the provider is never called.
const neverCalled = {} as ComparisonProvider;

test('the switch accepts on, off or empty and refuses anything else', () => {
  assert.equal(backgroundComparisonsEnabled({}), false);
  assert.equal(backgroundComparisonsEnabled({ FLUX_BACKGROUND_COMPARISONS: '' }), false);
  assert.equal(backgroundComparisonsEnabled({ FLUX_BACKGROUND_COMPARISONS: 'off' }), false);
  assert.equal(backgroundComparisonsEnabled({ FLUX_BACKGROUND_COMPARISONS: 'on' }), true);
  for (const value of ['true', 'ON', 'yes', '1']) assert.throws(() => backgroundComparisonsEnabled({ FLUX_BACKGROUND_COMPARISONS: value }));
});

test('the API reads the switch once, with the rest of its configuration (#88)', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `runtime-switch-${'x'.repeat(40)}`,
    FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
  const load = (value: string | undefined) => loadServerConfig({ ...env, FLUX_BACKGROUND_COMPARISONS: value }, '/nonexistent/flux_background_key');
  assert.equal(load(undefined).backgroundComparisons, false);
  assert.equal(load('').backgroundComparisons, false);
  assert.equal(load('off').backgroundComparisons, false);
  assert.equal(load('on').backgroundComparisons, true);
  // A mistyped value stops the API at startup instead of silently leaving comparisons off or on.
  assert.throws(() => load('yes'), /FLUX_BACKGROUND_COMPARISONS must be empty, off or on/);
});

describe('rule activation follows the switch', () => {
  let owner: Person;
  let ws: Workspace;
  let project: Project;
  let rule: ProactiveComparisonRule;

  before(async () => {
    owner = await person('runtime-owner');
    ws = await workspace(owner, 'Runtime workspace');
    project = await createProject(owner, ws.id, 'Night light', 'restricted');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Runtime agent', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/proactive-comparison-rules`, { body: ruleBody(agentId) }), 201) as ProactiveComparisonRule;
    expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: connectionBody }), 201) as BackgroundComputeConnection;
  });

  test('the settings page can ask whether this instance runs comparisons; only a signed-in person', async () => {
    // The test deployment leaves FLUX_BACKGROUND_COMPARISONS empty.
    assert.deepEqual(expectStatus(await owner.browser.request('GET', '/api/v1/background-comparisons/runtime'), 200), { status: 'unavailable' });
    assert.equal((await new Browser().request('GET', '/api/v1/background-comparisons/runtime')).status, 401);
  });

  test('off: enabling fails closed and the rule stays paused', async () => {
    const principal: Principal = { kind: 'human', id: owner.id };
    await assert.rejects(comparisonRuleUseCases(db, false).setStatus(principal, rule.id, rule.version, 'enabled'),
      (error: { code?: string }) => error.code === 'BACKGROUND_RUNTIME_UNAVAILABLE');
    assert.equal((await pool.query('SELECT status FROM proactive_comparison_rules WHERE id=$1', [rule.id])).rows[0].status, 'paused');
  });

  test('on: the same checks pass and the rule is enabled, versioned', async () => {
    const principal: Principal = { kind: 'human', id: owner.id };
    const enabled = await comparisonRuleUseCases(db, true).setStatus(principal, rule.id, rule.version, 'enabled');
    assert.equal(enabled.status, 'enabled');
    assert.equal(enabled.version, rule.version + 1);
    // Pausing works whatever the switch says.
    const paused = await comparisonRuleUseCases(db, false).setStatus(principal, rule.id, enabled.version, 'paused');
    assert.equal(paused.status, 'paused');
  });
});

describe('the worker registers the comparison jobs only when switched on', () => {
  const fakeBoss = () => {
    const calls: string[] = [];
    const handlers = new Map<string, () => Promise<void>>();
    const boss = {
      work: async (name: string, handler: () => Promise<void>) => { calls.push(`work ${name}`); handlers.set(name, handler); return 'id'; },
      schedule: async (name: string, cron: string) => { calls.push(`schedule ${name} ${cron}`); },
      unschedule: async (name: string) => { calls.push(`unschedule ${name}`); },
    };
    return { boss, calls, handlers };
  };

  test('off: nothing is worked and earlier schedules are removed', async () => {
    const { boss, calls } = fakeBoss();
    assert.deepEqual(await registerComparisonWorker(boss as never, db, { enabled: false, masterKey: null, provider: neverCalled }), { enabled: false });
    assert.deepEqual(calls, [`unschedule ${COMPARISON_TICK_JOB}`, `unschedule ${COMPARISON_RECOVERY_JOB}`]);
  });

  test('on: the tick and recovery jobs are worked and scheduled, and a tick runs against the database', async () => {
    const { boss, calls, handlers } = fakeBoss();
    const lines: Record<string, unknown>[] = [];
    assert.deepEqual(await registerComparisonWorker(boss as never, db, { enabled: true, masterKey: null, provider: neverCalled, log: (line) => lines.push(line) }), { enabled: true });
    assert.deepEqual(calls, [`work ${COMPARISON_TICK_JOB}`, `work ${COMPARISON_RECOVERY_JOB}`,
      `schedule ${COMPARISON_TICK_JOB} * * * * *`, `schedule ${COMPARISON_RECOVERY_JOB} */10 * * * *`]);
    await handlers.get(COMPARISON_RECOVERY_JOB)!();
    assert.equal(lines.at(-1)?.job, COMPARISON_RECOVERY_JOB);
    assert.equal(typeof lines.at(-1)?.notRun, 'number');
  });
});

describe('switched on, the registered tick pays for a ready candidate exactly once', () => {
  test('a rule enabled through the switch, one negative result, two ticks at once: one paid request', async () => {
    const owner = await person('runtime-tick-owner');
    const ws = await workspace(owner, 'Runtime tick workspace');
    const prj = await createProject(owner, ws.id, 'Tick lamp', 'restricted');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Tick agent', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/proactive-comparison-rules`, { body: ruleBody(agentId) }), 201) as ProactiveComparisonRule;
    expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: connectionBody }), 201);
    // The production enabling path with the switch on: every check, then a new enabled version.
    const principal: Principal = { kind: 'human', id: owner.id };
    assert.equal((await comparisonRuleUseCases(db, true).setStatus(principal, rule.id, rule.version, 'enabled')).status, 'enabled');

    const start = new Date('2030-01-01T00:00:00Z');
    const unit = comparisonScheduling(db);
    const collect = async (now: Date) => { for (;;) { if ((await collectComparisonSourceChanges(unit, now)).processed < 100) return; } };
    await collect(start);
    const marker = `runtime-tick-${randomUUID()}`;
    const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Camera at 5 lux', body: `38% detected at 5 lux. ${marker}` } }), 201) as { materialId: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/results`,
      { body: { title: 'Camera missed the target', finding: 'negative', evidence: 'Target was 90%.', sources: [{ type: 'material', id: material.materialId, version: 1 }] } }), 201);
    await collect(start);
    await comparisonSchedulingTick(db, new Date(start.getTime() + 2 * 60_000));
    const queued = (await pool.query("SELECT id FROM proactive_comparison_outbox WHERE rule_id=$1 AND status='queued'", [rule.id])).rows;
    assert.equal(queued.length, 1, 'the negative result made one candidate');
    await comparisonDispatchFixtureDue(pool, queued[0].id);

    // A provider that counts this test's paid requests (its marker is in the cited material).
    let paid = 0;
    const provider: ComparisonProvider = {
      async countInputTokens() { return 100; },
      async createMessage(input) {
        if (input.sources.some((source) => source.text.includes(marker))) paid++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, answer: { kind: 'insufficient_evidence', reason: 'Runtime test: no matching sensor trial.' } };
      },
    };
    const handlers = new Map<string, () => Promise<void>>();
    const boss = { work: async (name: string, handler: () => Promise<void>) => { handlers.set(name, handler); return 'id'; }, schedule: async () => undefined, unschedule: async () => undefined };
    await registerComparisonWorker(boss as never, db, { enabled: true, masterKey: readFileSync('/run/secrets/flux_background_key'), provider, log: () => undefined });
    const tick = handlers.get(COMPARISON_TICK_JOB)!;
    // Two workers' ticks at once: the reservation lets exactly one of them pay.
    await Promise.all([tick(), tick()]);
    assert.equal(paid, 1, 'one paid request for one candidate');
    const settled = (await pool.query('SELECT status FROM proactive_comparison_outbox WHERE id=$1', [queued[0].id])).rows[0];
    assert.notEqual(settled.status, 'queued', 'the candidate is settled');
    // A later tick finds nothing ready for it, and pays nothing more.
    await tick();
    assert.equal(paid, 1);
  });
});
