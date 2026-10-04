import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PgBoss } from 'pg-boss';
import { COMPARISON_RECOVERY_JOB, COMPARISON_TICK_JOB } from '@flux/core';
import { createDatabase } from '@flux/db';
import type { BackgroundComputeConnection, Material, ProactiveComparisonRule, WorkResult } from '@flux/contracts';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { signIn } from './support/http.js';
import { addMember, draft, expectStatus, grant, password, person, project, workspace } from './support/people.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// The background comparison operator switch in the running app (#58, T58-b), around the switched-on
// browser journey `e2e/background-comparisons.e2e.ts`. scripts/check_application.sh runs:
//   prepare  API and worker with FLUX_BACKGROUND_COMPARISONS empty (the default): nothing is
//            scheduled and enabling is refused; then one owner, peer, project, agent, provider-mock
//            connection and paused rule for the switched-on journey.
//   off      after that journey, API and worker restarted with the switch empty again: the jobs are
//            unscheduled, and the same rule, still enabled, with a ready candidate spends nothing.
// The provider is the Compose `providermock` (an OpenAI-compatible endpoint the worker's operator
// allowlist admits), never a real provider. Nothing here is a provider, billing or quality pass.

const stateFile = join(process.env.FLUX_TEST_STATE_DIR ?? '/state', 'background-comparisons.json');
const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const phase = process.argv[2];

export interface SwitchState {
  ownerEmail: string; peerEmail: string; workspaceId: string; projectId: string; ruleId: string; connectionId: string;
  agentId: string; materialId: string; key: string; model: string; marker: string; canary: string;
  /** Before this instant no comparison could run; any later dispatch must be this check's own. */
  preparedAt: string;
  /** Set by the switched-on journey: the one comparison it paid for. */
  paidResultId?: string;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);

async function mockRequests() {
  return ((await (await fetch(`${MOCK}/__requests`)).json()) as { requests: RecordedProviderRequest[] }).requests;
}
async function schedules() {
  return (await pool.query<{ name: string; cron: string }>('SELECT name, cron FROM pgboss.schedule WHERE name = ANY($1) ORDER BY name',
    [[COMPARISON_TICK_JOB, COMPARISON_RECOVERY_JOB]])).rows;
}
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

try {
  if (phase === 'prepare') {
    // Earlier suites leave fixture rules enabled (some forced in SQL) with fixture keys of real
    // providers. Switching the worker on must not dispatch them, so only this check's rule can run;
    // their queued candidates then stop at reservation (RULE_STOPPED) without a provider call.
    const paused = await pool.query("UPDATE proactive_comparison_rules SET status='paused', updated_at=now() WHERE status='enabled'");
    await fetch(`${MOCK}/__reset`, { method: 'POST', body: '{}' });

    const owner = await person('switch-owner');
    const peer = await person('switch-peer');
    const ws = await workspace(owner, 'Low-light sensor lab');
    await addMember(owner, ws.id, peer, 'member');
    const prj = await project(owner, ws.id, 'Night gesture lamp', 'restricted');
    await grant(owner, prj.id, peer, 'contributor');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Sensor comparison helper', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    // The same marker check_application.sh looks for in the API, worker and provider-mock logs.
    const key = `local-${'owner-budget-key-'.repeat(3)}RT58`;
    const model = 'llama3.1:8b';
    // $10/M input and $40/M output: 8,000 × $10/M + 1,200 × $40/M reserves 13 cents per request.
    const connection = expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
      name: 'Lab comparison endpoint', provider: 'openai_compatible', model, baseUrl: `${MOCK}/openai/v1`, apiKey: key,
      price: { inputMicrosPerMTok: 10_000_000, outputMicrosPerMTok: 40_000_000 }, useForBackground: true,
      payerOrganization: 'Lab payer', providerWorkspace: 'Lab workspace', workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true,
      providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
      maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 20 } }), 201) as BackgroundComputeConnection;
    const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/proactive-comparison-rules`, { body: {
      agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison', dataScope: 'current_project_published',
      permittedEffect: 'quiet_project_proposal', maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 20 } }), 201) as ProactiveComparisonRule;
    assert.equal(rule.status, 'paused');
    const marker = `switch-evidence-${randomUUID()}`;
    const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/materials`, { body: {
      clientMutationId: randomUUID(), title: 'Gesture capture at 5 lux',
      body: `Camera A recognized 38% of 20 gestures at 5 lux; the target is 90%. ${marker}` } }), 201) as Material;
    // A private capture in the same workspace: it must never reach the provider or the proposal.
    const canary = `private-canary-${randomUUID()}`;
    await draft(owner, ws.id, 'Private sensor notes', { body: `Not for the project: ${canary}` });

    // Switched off: nothing is scheduled, the runtime reports unavailable and enabling is refused.
    assert.deepEqual(await schedules(), [], 'no comparison job is scheduled while the switch is off');
    assert.deepEqual(expectStatus(await owner.browser.request('GET', '/api/v1/background-comparisons/runtime'), 200), { status: 'unavailable' });
    const refused = await owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${rule.id}`, { body: { expectedVersion: rule.version, status: 'enabled' } });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(codeOf(refused), 'BACKGROUND_RUNTIME_UNAVAILABLE');
    assert.deepEqual((await pool.query('SELECT status, version FROM proactive_comparison_rules WHERE id=$1', [rule.id])).rows[0],
      { status: 'paused', version: rule.version });

    const preparedAt = (await pool.query<{ now: Date }>('SELECT now()')).rows[0]!.now.toISOString();
    await writeFile(stateFile, JSON.stringify({ ownerEmail: owner.email, peerEmail: peer.email, workspaceId: ws.id, projectId: prj.id,
      ruleId: rule.id, connectionId: connection.id, agentId, materialId: material.materialId, key, model, marker, canary,
      preparedAt } satisfies SwitchState));
    console.log(`background-comparisons: switched off, nothing scheduled and enabling refused; ${paused.rowCount} earlier fixture rules paused`);
  } else if (phase === 'off') {
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as SwitchState;
    assert.ok(state.paidResultId, 'the switched-on journey recorded its paid comparison');
    // The worker removes the schedules an earlier switched-on run left behind.
    await until('the comparison schedules to be removed', async () => (await schedules()).length === 0, 60_000);
    const startedAt = (await pool.query<{ now: Date }>('SELECT now()')).rows[0]!.now;
    const owner = (await signIn(state.ownerEmail, password)).browser;
    const peer = (await signIn(state.peerEmail, password)).browser;
    assert.deepEqual(expectStatus(await owner.request('GET', '/api/v1/background-comparisons/runtime'), 200), { status: 'unavailable' });
    // The journey left the rule enabled, as an operator switching a running instance off would.
    const rule = (await pool.query<{ status: string; version: number }>('SELECT status, version FROM proactive_comparison_rules WHERE id=$1', [state.ruleId])).rows[0]!;
    assert.equal(rule.status, 'enabled');
    const requestsBefore = await mockRequests();
    assert.equal(requestsBefore.length, 1, 'only the switched-on comparison reached the provider');

    // A contributor's negative result still creates its candidate (the rule is enabled) ...
    const result = expectStatus(await peer.request('POST', `/api/v1/projects/${state.projectId}/results`, { body: {
      title: 'Third low-light trial missed the target', finding: 'negative', evidence: 'Camera A recognized 41% of gestures at 5 lux; target was 90%.',
      sources: [{ type: 'material', id: state.materialId, version: 1 }] } }), 201) as WorkResult;
    const candidates = (await pool.query<{ id: string }>('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows;
    assert.equal(candidates.length, 1);
    const candidateId = candidates[0]!.id;
    // ... and is made fully ready: past its quiet window, every event collected, no pending project change.
    await comparisonDispatchFixtureDue(pool, candidateId);
    await pool.query('DELETE FROM proactive_comparison_project_changes WHERE project_id=$1', [state.projectId]);
    // A tick job sent by hand: switched on, the worker consumes one within seconds; off, nobody works the queue.
    const boss = new PgBoss({ connectionString, migrate: false });
    boss.on('error', (error) => console.error(error));
    await boss.start();
    const tickJob = await boss.send(COMPARISON_TICK_JOB, {});
    await boss.stop();
    assert.ok(tickJob);

    // Longer than one scheduler minute, so a scheduled tick would have run.
    await new Promise((resolve) => setTimeout(resolve, 75_000));
    const row = (await pool.query('SELECT status, reserved_cents, dispatch_started_at, usage_input_tokens, proposal_id, insufficient_outcome_id FROM proactive_comparison_outbox WHERE id=$1',
      [candidateId])).rows[0];
    assert.deepEqual(row, { status: 'queued', reserved_cents: 0, dispatch_started_at: null, usage_input_tokens: null, proposal_id: null, insufficient_outcome_id: null },
      'switched off, a ready candidate is never reserved or dispatched');
    assert.deepEqual(await mockRequests(), requestsBefore, 'switched off, no provider request');
    assert.equal((await pool.query('SELECT state FROM pgboss.job WHERE id=$1', [tickJob])).rows[0]?.state, 'created', 'nobody works the tick queue');
    const otherTicks = await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = ANY($1) AND id <> $2 AND created_on >= $3",
      [[COMPARISON_TICK_JOB, COMPARISON_RECOVERY_JOB], tickJob, startedAt]);
    assert.equal(otherTicks.rows[0].n, 0, 'no scheduled comparison job was created');
    const dispatched = await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE dispatch_started_at >= $1', [startedAt]);
    assert.equal(dispatched.rows[0].n, 0, 'no comparison of any owner was dispatched');

    // Pausing works whatever the switch says; enabling again is refused while it is off.
    const pausedRule = expectStatus(await owner.request('PATCH', `/api/v1/proactive-comparison-rules/${state.ruleId}`,
      { body: { expectedVersion: rule.version, status: 'paused' } }), 200) as ProactiveComparisonRule;
    assert.equal(pausedRule.status, 'paused');
    const refused = await owner.request('PATCH', `/api/v1/proactive-comparison-rules/${state.ruleId}`, { body: { expectedVersion: pausedRule.version, status: 'enabled' } });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(codeOf(refused), 'BACKGROUND_RUNTIME_UNAVAILABLE');
    console.log('background-comparisons: switched off again, the jobs are unscheduled and an enabled rule with a ready candidate spent nothing for 75 s');
  } else {
    throw new Error('Usage: background-comparisons-switch.ts prepare|off');
  }
} finally {
  await pool.end();
}
