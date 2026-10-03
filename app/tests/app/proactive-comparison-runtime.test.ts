import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { backgroundComparisonsEnabled, COMPARISON_RECOVERY_JOB, COMPARISON_TICK_JOB, type ComparisonProvider, type Principal } from '@flux/core';
import { createDatabase } from '@flux/db';
import type { BackgroundComputeConnection, ProactiveComparisonRule, Project, Workspace } from '@flux/contracts';
import { comparisonRuleUseCases } from '../../apps/server/src/proactive-comparison/routes.js';
import { registerComparisonWorker } from '../../apps/worker/src/proactive-comparison/index.js';
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
