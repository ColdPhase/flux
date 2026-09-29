import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { ComparisonProvider } from '@flux/core';
import type { Material } from '@flux/contracts';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());
const masterKey = readFileSync('/run/secrets/flux_background_key');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function promptly<T>(promise: Promise<T>, context: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${context} waited for the provider response`)), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const [admin, owner] = await Promise.all(['cancel-admin', 'cancel-owner'].map(person));
  const ws = await workspace(admin, 'In-flight comparison cancellation');
  await addMember(admin, ws.id, owner, 'member');
  const projectId = (await project(admin, ws.id, 'Camera measurements', 'restricted')).id;
  await grant(admin, projectId, owner, 'contributor');
  const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string }).id;
  const agentGrantId = (expectStatus(await admin.browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201) as { id: string }).id;
  const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`,
    { body: { agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
      maxRunsPerDay: 3, periodBudgetCents: 15, perRunCents: 5 } }), 201) as { id: string; version: number };
  const connection = expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
    apiKey: `sk-ant-api03-${'cancellation-fixture-'.repeat(4)}END8`,
    payerOrganization: 'Local fixture payer', providerWorkspace: 'Local fixture workspace',
    workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true,
    providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
    maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 15, perRunCents: 5,
  } }), 201) as { id: string };
  // Production activation still fails closed. This fixture enables only its isolated rule.
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  const material = expectStatus(await admin.browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Camera A measurements', body: '38% gesture detection at 5 lux.' } }), 201) as Material;
  const work = expectStatus(await admin.browser.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title: 'Run a controlled sensor benchmark', outcome: 'Measure the same gestures at 5 lux.' } }), 201) as { id: string; version: number };
  const sketch = expectStatus(await admin.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
    { body: { title: 'Human test ideas', scope: 'project', projectId } }), 201) as { id: string };
  const { thought } = expectStatus(await admin.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: 'Check sensor exposure at 5 lux.', x: 0, y: 0 } }), 201) as { thought: { id: string; version: number } };
  const result = expectStatus(await admin.browser.request('POST', `/api/v1/projects/${projectId}/results`,
    { body: { title: 'Low-light trial failed', finding: 'negative', evidence: 'The camera missed gestures.',
      sources: [{ type: 'material', id: material.materialId, version: 1 }] } }), 201) as { id: string };
  const candidateId = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0].id as string;
  return { admin, owner, projectId, rule, connection, agentGrantId, material, work, sketch, thought, candidateId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const changes: Array<{ name: string; phase: 'count' | 'message'; reason: string; change(f: Fixture): Promise<unknown> }> = [
  { name: 'pause during token counting', phase: 'count', reason: 'AUTHORIZATION_CHANGED',
    async change(f) { expectStatus(await f.owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${f.rule.id}`,
      { body: { expectedVersion: f.rule.version, status: 'paused' } }), 200); } },
  { name: 'pause during a message', phase: 'message', reason: 'AUTHORIZATION_CHANGED',
    async change(f) { expectStatus(await f.owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${f.rule.id}`,
      { body: { expectedVersion: f.rule.version, status: 'paused' } }), 200); } },
  { name: 'permanent rule revocation', phase: 'message', reason: 'AUTHORIZATION_CHANGED',
    async change(f) { expectStatus(await f.owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${f.rule.id}`,
      { body: { expectedVersion: f.rule.version, status: 'revoked' } }), 200); } },
  { name: 'key connection revocation', phase: 'message', reason: 'AUTHORIZATION_CHANGED',
    async change(f) { expectStatus(await f.owner.browser.request('DELETE', `/api/v1/background-compute-connections/${f.connection.id}`), 204); } },
  { name: 'agent grant removal', phase: 'message', reason: 'ACCESS_CHANGED',
    async change(f) { expectStatus(await f.admin.browser.request('DELETE', `/api/v1/projects/${f.projectId}/grants/${f.agentGrantId}`), 204); } },
  { name: 'owner project access loss', phase: 'message', reason: 'ACCESS_CHANGED',
    async change(f) { await grant(f.admin, f.projectId, f.owner, 'denied'); } },
  { name: 'source revision', phase: 'message', reason: 'SOURCE_CHANGED',
    async change(f) { expectStatus(await f.admin.browser.request('PATCH', `/api/v1/materials/${f.material.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'The original measurement was corrected.' } }), 200); } },
  { name: 'unlinked human work revision', phase: 'message', reason: 'SOURCE_CHANGED',
    async change(f) { expectStatus(await f.admin.browser.request('PATCH', `/api/v1/work/${f.work.id}`,
      { body: { outcome: 'Repeat at 10 lux instead.', expectedVersion: f.work.version }, headers: { 'If-Match': `"${f.work.version}"` } }), 200); } },
  { name: 'unlinked human thought revision', phase: 'message', reason: 'SOURCE_CHANGED',
    async change(f) { expectStatus(await f.admin.browser.request('PATCH', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`,
      { body: { text: 'Exposure was already long enough.' }, headers: { 'If-Match': `"${f.thought.version}"` } }), 200); } },
];

for (const scenario of changes) {
  test(`in-flight ${scenario.name} commits promptly, aborts the request and ignores a late answer`, async () => {
    const f = await fixture();
    const entered = deferred<AbortSignal>();
    const release = deferred<void>();
    const calls: string[] = [];
    const provider: ComparisonProvider = {
      async countInputTokens(input) {
        calls.push('count');
        if (scenario.phase === 'count') { entered.resolve(input.signal); await release.promise; }
        return 100;
      },
      async createMessage(input) {
        calls.push('message');
        entered.resolve(input.signal);
        // Deliberately ignores AbortSignal: even a misbehaving adapter cannot publish late.
        await release.promise;
        return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 }, answer: {
          fact: 'The camera missed gestures.', interpretation: 'The sensor may need a longer exposure.',
          suggestedAction: 'Compare another sensor under the same conditions.',
          citations: input.sources.map(({ type, id, version }) => ({ type, id, version })),
        } };
      },
    };
    const running = dispatchProactiveComparison({ db, candidateId: f.candidateId, masterKey, provider });
    try {
      const signal = await promptly(entered.promise, 'dispatch');
      await promptly(scenario.change(f), scenario.name);
      assert.deepEqual(await promptly(running, 'cancellation'),
        { status: scenario.phase === 'count' ? 'not_run' : 'unknown', reason: scenario.reason });
      assert.equal(signal.aborted, true, 'the adapter receives cancellation');
      release.resolve();
      // Drain the deliberately late promise, then inspect persistence and replay behavior.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_proposals WHERE outbox_id=$1',
        [f.candidateId])).rows[0].n, 0);
      assert.deepEqual((await pool.query('SELECT status, reserved_cents, usage_estimated_cents FROM proactive_comparison_outbox WHERE id=$1',
        [f.candidateId])).rows[0], scenario.phase === 'count'
        ? { status: 'cancelled', reserved_cents: 0, usage_estimated_cents: 0 }
        : { status: 'unknown', reserved_cents: 5, usage_estimated_cents: null });
      assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: f.candidateId, masterKey, provider }),
        { status: 'blocked', reason: 'NOT_QUEUED' }, 'a stopped candidate cannot silently retry');
      assert.deepEqual(calls, scenario.phase === 'count' ? ['count'] : ['count', 'message']);
    } finally { release.resolve(); await running; }
  });
}

test('the final locked check rejects a response after a rapid pause and resume', async () => {
  const f = await fixture();
  const provider: ComparisonProvider = {
    async countInputTokens() { return 100; },
    async createMessage(input) {
      expectStatus(await f.owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${f.rule.id}`,
        { body: { expectedVersion: f.rule.version, status: 'paused' } }), 200);
      // Resume only the fixture: production enabling remains blocked by runtime acceptance.
      await pool.query("UPDATE proactive_comparison_rules SET status='enabled', version=version+1 WHERE id=$1", [f.rule.id]);
      return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 }, answer: {
        fact: 'The camera missed gestures.', interpretation: 'Check exposure.', suggestedAction: 'Compare another sensor.',
        citations: input.sources.map(({ type, id, version }) => ({ type, id, version })),
      } };
    },
  };
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: f.candidateId, masterKey, provider }),
    { status: 'unknown', reason: 'AUTHORIZATION_CHANGED' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_proposals WHERE outbox_id=$1',
    [f.candidateId])).rows[0].n, 0, 'reenabling a newer rule cannot revive the old call');
});

test('an input-token refusal records not-run with zero usage and releases only its unspent reservation', async () => {
  const f = await fixture();
  let messages = 0;
  const provider: ComparisonProvider = {
    async countInputTokens() { return 8_001; },
    async createMessage() { messages++; throw new Error('must not start a paid request'); },
  };
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: f.candidateId, masterKey, provider }),
    { status: 'not_run', reason: 'INPUT_TOKEN_LIMIT' });
  assert.equal(messages, 0);
  const row = (await pool.query(`SELECT status, reserved_cents, reserved_at, connection_id,
    usage_input_tokens, usage_output_tokens, usage_estimated_cents, failure_code, finished_at
    FROM proactive_comparison_outbox WHERE id=$1`, [f.candidateId])).rows[0];
  assert.deepEqual({ ...row, finished_at: !!row.finished_at }, { status: 'cancelled', reserved_cents: 0,
    reserved_at: null, connection_id: null, usage_input_tokens: 0, usage_output_tokens: 0,
    usage_estimated_cents: 0, failure_code: 'INPUT_TOKEN_LIMIT', finished_at: true });
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: f.candidateId, masterKey, provider }),
    { status: 'blocked', reason: 'NOT_QUEUED' });
  assert.equal(messages, 0, 'the not-run candidate is not retried automatically');
});
