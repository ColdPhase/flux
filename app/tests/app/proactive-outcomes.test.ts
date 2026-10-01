import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { comparisonOutcomeRows, createDatabase } from '@flux/db';
import type { ComparisonProvider, ComparisonSource } from '@flux/core';
import type { BackgroundComputeUsage, Page, ProactiveComparisonOutcome } from '@flux/contracts';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const masterKey = readFileSync('/run/secrets/flux_background_key');

async function fixture() {
  const [owner, peer, viewer, outsider] = await Promise.all(['outcome-owner', 'outcome-peer', 'outcome-viewer', 'outcome-outsider'].map(person));
  const ws = await workspace(owner, 'Quiet comparison outcomes');
  for (const other of [peer, viewer, outsider]) await addMember(owner, ws.id, other, 'member');
  const projectId = (await project(owner, ws.id, 'Low-light comparison', 'restricted')).id;
  await grant(owner, projectId, peer, 'contributor'); await grant(owner, projectId, viewer, 'viewer');
  const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string }).id;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`,
    { body: { agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
      maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 5 } }), 201) as { id: string };
  const connection = expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
    apiKey: `sk-ant-api03-${'outcome-fixture-secret-'.repeat(4)}END8`, payerOrganization: 'Private payer', providerWorkspace: 'Private workspace',
    workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true, providerBillingAcknowledged: true,
    projectDataDisclosureAcknowledged: true, maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 5,
  } }), 201) as { id: string };
  // Only the isolated fixture enables dispatch; production activation remains unavailable.
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  const sketch = expectStatus(await peer.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
    { body: { title: 'Project test ideas', scope: 'project', projectId } }), 201) as { id: string };
  const { thought } = expectStatus(await peer.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: 'Compare the sensor under the same 5 lux trial.', x: 0, y: 0 } }), 201) as { thought: { id: string; version: number } };
  const work = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title: 'Human measurement protocol', outcome: 'Use the same controlled measurement. '.repeat(100) } }), 201) as { id: string };
  const negative = async () => {
    const result = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/results`,
      { body: { title: 'Camera missed gestures', finding: 'negative', evidence: '38% detected at 5 lux.' } }), 201) as { id: string };
    const candidateId = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0].id as string;
    await comparisonDispatchFixtureDue(pool, candidateId);
    return { result, candidateId };
  };
  const list = async (who = peer, query = '') => expectStatus(await who.browser.request('GET',
    `/api/v1/projects/${projectId}/proactive-comparison-outcomes${query}`), 200) as Page<ProactiveComparisonOutcome>;
  const usage = async (who = owner) => expectStatus(await who.browser.request('GET', '/api/v1/background-compute-usage'), 200) as BackgroundComputeUsage;
  return { owner, peer, viewer, outsider, ws, projectId, agentId, rule, connection, sketch, thought, work, negative, list, usage };
}

test('quiet insufficient evidence keeps the full actual inspected vector, pages and dismisses without work or compute', async () => {
  const f = await fixture();
  const { result, candidateId } = await f.negative();
  let sends = 0;
  let inspected: ComparisonSource[] = [];
  const provider: ComparisonProvider = {
    async countInputTokens(input) { inspected = input.sources; return 100; },
    async createMessage() { sends++; return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 70 },
      answer: { kind: 'insufficient_evidence', reason: 'There is no comparable sensor measurement in this evidence.' } }; },
  };
  const outcome = await dispatchProactiveComparison({ db, candidateId, masterKey, provider });
  assert.equal(outcome.status, 'insufficient_evidence');
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId, masterKey: null, provider }), outcome, 'completed replay needs no key or new request');
  assert.equal(sends, 1);
  const page = await f.list(f.viewer, '?limit=1&offset=0');
  assert.deepEqual([page.total, page.limit, page.offset], [1, 1, 0]);
  const item = page.items[0]!;
  assert.equal(item.kind, 'insufficient_evidence');
  assert.deepEqual(item.inspectedSources!.map(({ type, id, version }) => ({ type, id, version })),
    inspected.map(({ type, id, version }) => ({ type, id, version })));
  const excerpt = item.inspectedSources!.find((source) => source.id === f.work.id)!;
  assert.equal(excerpt.excerpted, true); assert.ok(excerpt.originalCharacters! > 2000);
  assert.ok(!JSON.stringify(page).includes('Private payer'));
  assert.ok(!JSON.stringify(page).includes('estimatedCents'));
  assert.ok(item.inspectedSources!.every((source) => !('text' in source)));
  assert.deepEqual((await f.list(f.peer, '?limit=1&offset=1')).items, []);
  assert.equal((await f.outsider.browser.request('GET', `/api/v1/projects/${f.projectId}/proactive-comparison-outcomes`)).status, 404);
  if (item.kind !== 'insufficient_evidence') throw new Error('expected insufficient outcome');
  const path = `/api/v1/proactive-comparison-outcomes/${item.id}`;
  assert.equal((await f.viewer.browser.request('PATCH', path, { body: { expectedVersion: 1, status: 'dismissed' } })).status, 403);
  assert.equal((await f.outsider.browser.request('PATCH', path, { body: { expectedVersion: 1, status: 'dismissed' } })).status, 404);
  assert.equal((await f.peer.browser.request('PATCH', path, { body: { expectedVersion: 1, status: 'used' } })).status, 400);
  const dismissed = expectStatus(await f.peer.browser.request('PATCH', path, { body: { expectedVersion: 1, status: 'dismissed' } }), 200) as { version: number; status: string };
  assert.deepEqual(dismissed, { ...dismissed, version: 2, status: 'dismissed' });
  assert.equal((await f.peer.browser.request('PATCH', path, { body: { expectedVersion: 1, status: 'dismissed' } })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1', [f.projectId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE source_id=$1', [result.id])).rows[0].n, 0);
  assert.equal(sends, 1);
  const usage = await f.usage();
  assert.deepEqual([usage.startedRequestsToday, usage.conservativeCountedCents, usage.observedEstimatedCents,
    usage.unknownPossibleCents, usage.inFlightCents], [1, 5, 1, 0, 0]);
  assert.equal(usage.candidates[0]!.status, 'completed'); assert.ok(usage.candidates[0]!.startedAt);
  assert.deepEqual((await f.usage(f.peer)).candidates, [], 'another person cannot read the payer’s accounting');
  const foreignSelector = expectStatus(await f.peer.browser.request('GET', `/api/v1/background-compute-usage?ownerId=${f.owner.id}`), 200) as BackgroundComputeUsage;
  assert.deepEqual(foreignSelector.candidates, [], 'an extra query field cannot select another owner');
});

test('truncated and malformed paid answers retain usage and publish only fixed safe insufficient copy', async () => {
  const f = await fixture();
  for (const stopReason of ['max_tokens', 'end_turn']) {
    const { candidateId } = await f.negative();
    const provider: ComparisonProvider = { async countInputTokens() { return 100; }, async createMessage() {
      return { stopReason, usage: { inputTokens: 100, outputTokens: 70 }, answer: stopReason === 'max_tokens'
        ? { kind: 'insufficient_evidence', reason: 'UNTRUSTED-TRUNCATED-RAW-COPY' } : null };
    } };
    assert.equal((await dispatchProactiveComparison({ db, candidateId, masterKey, provider })).status, 'insufficient_evidence');
  }
  const page = await f.list();
  assert.equal(page.total, 2);
  assert.ok(page.items.every((item) => item.kind === 'insufficient_evidence' && item.reason ===
    'The response did not provide a complete, valid comparison grounded in the inspected sources.'));
  assert.equal((await f.usage()).observedEstimatedCents, 2);
});

test('unopenable inspected and cited references lose their titles; legacy complete vectors remain unknown', async () => {
  const f = await fixture();
  const { candidateId } = await f.negative();
  const provider: ComparisonProvider = { async countInputTokens() { return 100; }, async createMessage(input) {
    return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 }, answer: { kind: 'comparison',
      fact: 'The camera misses gestures.', interpretation: 'A comparison needs a repeated protocol.', suggestedAction: 'Repeat the trial.',
      citations: input.sources.filter((source) => source.type === 'result' || source.type === 'thought')
        .map(({ type, id, version }) => ({ type, id, version })) } };
  } };
  assert.equal((await dispatchProactiveComparison({ db, candidateId, masterKey, provider })).status, 'proposal');
  const before = (await f.list()).items[0]!;
  assert.ok(before.inspectedSources!.length > (before.kind === 'comparison' ? before.proposal.sources.length : 0), 'the inspected vector is not the cited subset');
  expectStatus(await f.peer.browser.request('DELETE', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`,
    { headers: { 'If-Match': `"${f.thought.version}"` } }), 204);
  const afterDelete = (await f.list()).items[0]!;
  assert.equal(afterDelete.unavailableSourcesCount, 1);
  assert.ok(!JSON.stringify(afterDelete).includes('Compare the sensor under the same 5 lux trial.'));
  const compatible = expectStatus(await f.peer.browser.request('GET', `/api/v1/projects/${f.projectId}/proactive-comparison-proposals`), 200);
  assert.ok(!JSON.stringify(compatible).includes(f.thought.id), 'the compatible proposal route applies current reference checks too');
  await pool.query('UPDATE proactive_comparison_outbox SET inspected_sources=NULL WHERE id=$1', [candidateId]);
  assert.equal((await f.list()).items[0]!.inspectedSources, null, 'legacy data never invents a complete inspected vector');
});

test('terminal pre-paid refusals persist zero usage without retry, while owner accounting survives access loss and disconnection', async () => {
  const f = await fixture();
  const first = await f.negative();
  let calls = 0;
  const provider: ComparisonProvider = { async countInputTokens() { calls++; return 100; }, async createMessage() { calls++; throw new Error('must not dispatch'); } };
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: first.candidateId, masterKey: null, provider }), { status: 'not_run', reason: 'KEY_UNAVAILABLE' });
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: first.candidateId, masterKey, provider }), { status: 'blocked', reason: 'NOT_QUEUED' });
  assert.equal(calls, 0);
  const initial = await f.usage();
  assert.deepEqual([initial.startedRequestsToday, initial.conservativeCountedCents, initial.observedEstimatedCents], [0, 0, 0]);
  assert.deepEqual(initial.candidates[0]!.observedUsage, { inputTokens: 0, outputTokens: 0, estimatedCents: 0 });
  assert.deepEqual(initial.candidates[0]!.context, { projectTitle: 'Low-light comparison', resultTitle: 'Camera missed gestures' });
  assert.equal(initial.candidates[0]!.reservedAt, null); assert.equal(initial.candidates[0]!.startedAt, null);
  await grant(f.owner, f.projectId, f.owner, 'denied');
  expectStatus(await f.owner.browser.request('DELETE', `/api/v1/background-compute-connections/${f.connection.id}`), 204);
  const afterLoss = await f.usage();
  assert.equal(afterLoss.candidates[0]!.context, null);
  assert.ok(!JSON.stringify(afterLoss).includes('Low-light comparison'));
  assert.ok(!JSON.stringify(afterLoss).includes('Camera missed gestures'));
  assert.deepEqual(afterLoss.candidates.map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'context'))), initial.candidates.map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'context'))));
  assert.equal(afterLoss.currentLimits, null); assert.equal(afterLoss.candidates.length, 1);
  assert.ok(!JSON.stringify(afterLoss).includes('38% detected')); assert.ok(!JSON.stringify(afterLoss).includes('cipher'));
  assert.equal((await f.owner.browser.request('GET', `/api/v1/projects/${f.projectId}/proactive-comparison-outcomes`)).status, 404);
});


test('usage metadata requires the exact project/result pair and follows current names', async () => {
  const f = await fixture();
  const { result } = await f.negative();
  const foreign = await project(f.owner, f.ws.id, 'Private parallel protocol', 'restricted');
  const foreignResult = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${foreign.id}/results`,
    { body: { title: 'Private sensor threshold', finding: 'positive' } }), 201) as { id: string };
  assert.equal(await comparisonOutcomeRows(db).usageContext(f.projectId, foreignResult.id), null);
  assert.equal(await comparisonOutcomeRows(db).usageContext(f.projectId, randomUUID()), null);
  await pool.query('UPDATE projects SET name=$1 WHERE id=$2', ['Renamed low-light protocol', f.projectId]);
  await pool.query('UPDATE project_results SET title=$1 WHERE id=$2', ['Rechecked camera miss rate', result.id]);
  const usage = await f.usage();
  assert.deepEqual(usage.candidates[0]!.context, { projectTitle: 'Renamed low-light protocol', resultTitle: 'Rechecked camera miss rate' });
  assert.ok(!JSON.stringify(usage).includes('Private sensor threshold'));
  assert.equal((await f.usage(f.peer)).candidates.length, 0);
  await pool.query('UPDATE proactive_comparison_outbox SET result_id=$1 WHERE id=$2', [foreignResult.id, usage.candidates[0]!.id]);
  const misbound = await f.usage();
  assert.equal(misbound.candidates[0]!.context, null);
  assert.equal(misbound.candidates.length, usage.candidates.length);
  assert.equal(misbound.conservativeCountedCents, usage.conservativeCountedCents);
  assert.ok(!JSON.stringify(misbound).includes('Private sensor threshold'));
});
