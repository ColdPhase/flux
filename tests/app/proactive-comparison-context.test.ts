import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { createDatabase, proactiveOutboxRows } from '@flux/db';
import { recordEvent, type ComparisonProvider, type ComparisonSource } from '@flux/core';
import type { Conversation, Material, WorkItem, WorkResult } from '@flux/contracts';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { addMember, draft, expectStatus, grant, person, project, workspace } from './support/people.js';

const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const masterKey = readFileSync('/run/secrets/flux_background_key');

async function fixture() {
  const [owner, peer] = await Promise.all(['context-owner', 'context-peer'].map(person));
  const ws = await workspace(owner, 'Bounded comparison context');
  await addMember(owner, ws.id, peer, 'member');
  const projectId = (await project(owner, ws.id, 'Camera experiment', 'restricted')).id;
  await grant(owner, projectId, peer, 'contributor');
  const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string }).id;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`,
    { body: { agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
      maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 5 } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
    apiKey: `sk-ant-api03-${'context-fixture-'.repeat(5)}END8`, payerOrganization: 'Fixture payer', providerWorkspace: 'Fixture workspace',
    workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true, providerBillingAcknowledged: true,
    projectDataDisclosureAcknowledged: true, maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 5,
  } }), 201);
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  const negative = async (sources: Array<{ type: 'message'; id: string }> = []) => {
    const result = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/results`,
      { body: { title: 'Camera misses gestures at 5 lux', finding: 'negative', evidence: 'Only 38% detection in the human trial.', sources } }), 201) as WorkResult;
    const candidate = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0];
    return { result, candidateId: candidate?.id as string | undefined };
  };
  return { owner, peer, ws, projectId, agentId, rule, negative };
}

test('bounded current human context preserves explicit references and excludes private, draft, agent and other-project data', async () => {
  const f = await fixture();
  const canary = `EXCLUDED-CONTEXT-${randomUUID()}`;
  const privateNote = await draft(f.owner, f.ws.id, 'Private note', { body: canary });
  const privateSketch = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Private sketch', scope: 'private' } }), 201) as { id: string };
  expectStatus(await f.owner.browser.request('POST', `/api/v1/sketches/${privateSketch.id}/thoughts`,
    { body: { text: canary, x: 0, y: 0 } }), 201);
  const sketch = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Project test ideas', scope: 'project', projectId: f.projectId } }), 201) as { id: string };
  const { thought } = expectStatus(await f.owner.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: 'Repeat the ToF trial at 5 lux.', x: 0, y: 0 } }), 201) as { thought: { id: string; version: number } };
  expectStatus(await f.owner.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: canary, x: 200, y: 0, placement: { type: 'draft', id: privateNote.id } } }), 201);
  await pool.query(`INSERT INTO sketch_thoughts (id, workspace_id, sketch_id, text, x, y, created_by_agent_id)
    VALUES ($1,$2,$3,$4,400,0,$5)`, [randomUUID(), f.ws.id, sketch.id, canary, f.agentId]);
  const benchmark = expectStatus(await f.peer.browser.request('POST', `/api/v1/projects/${f.projectId}/results`,
    { body: { title: 'ToF human trial succeeds', finding: 'positive', evidence: 'Same gestures detected at 5 lux.' } }), 201) as WorkResult;
  const elsewhere = (await project(f.owner, f.ws.id, 'Another readable project', 'workspace')).id;
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${elsewhere}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Another project', body: canary } }), 201);
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.projectId}/docs`,
    { body: { title: 'Unpublished doc', body: canary, state: 'draft' } }), 201);
  const doc = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.projectId}/docs`,
    { body: { title: 'Human published benchmark', body: 'ToF sensor measured the same low-light gestures.', state: 'published' } }), 201) as { id: string };
  const dm = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/dms`,
    { body: { participantIds: [f.peer.id] } }), 201) as { id: string };
  expectStatus(await f.owner.browser.request('POST', `/api/v1/dms/${dm.id}/messages`,
    { body: { body: canary, clientMessageId: randomUUID() } }), 201);
  const work = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.projectId}/work`,
    { body: { title: 'Human sensor benchmark', outcome: 'Controlled human protocol. '.repeat(110) } }), 201) as WorkItem;
  await pool.query(`INSERT INTO project_work_items (id, workspace_id, project_id, title, created_by_kind, created_by_id)
    VALUES ($1,$2,$3,$4,'agent',$5)`, [randomUUID(), f.ws.id, f.projectId, canary, f.agentId]);
  const changedByAgent = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.projectId}/work`,
    { body: { title: 'Initially human work' } }), 201) as WorkItem;
  await pool.query('UPDATE project_work_items SET title=$1, version=2 WHERE id=$2', [canary, changedByAgent.id]);
  await db.transaction((tx) => recordEvent(tx, { kind: 'agent', id: f.agentId }, f.ws.id,
    'project.work_updated.v1', f.projectId, { workId: changedByAgent.id }));
  const material = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Human camera measurements', body: 'Camera A captured 38% at 5 lux.' } }), 201) as Material;
  const thread = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.projectId}/conversations`,
    { body: { body: 'Original explicit human test plan', clientMessageId: randomUUID() } }), 201) as Conversation;
  for (let i = 0; i < 15; i++) expectStatus(await f.peer.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
    { body: { body: `Human project update ${i}`, clientMessageId: randomUUID() } }), 201);
  const { result, candidateId } = await f.negative([{ type: 'message', id: thread.messages[0]!.id }]);
  assert.ok(candidateId);
  const rows = proactiveOutboxRows(db);
  const before = await rows.sourceSnapshot(result.id, f.rule.id);
  assert.deepEqual(await rows.sourceSnapshot(result.id, f.rule.id), before, 'metadata selection and fingerprint are deterministic');
  let supplied: ComparisonSource[] = [];
  const provider: ComparisonProvider = {
    async countInputTokens(input) { supplied = input.sources; return 300; },
    async createMessage(input) {
      return { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 100 }, answer: { kind: 'comparison' as const,
        fact: 'The camera captured 38% at 5 lux.', interpretation: 'A controlled ToF comparison may help.',
        suggestedAction: 'Compare the ToF sensor under the same human protocol.',
        citations: input.sources.map(({ type, id, version }) => ({ type, id, version,
          title: 'Model-invented source name', sketchId: randomUUID() })),
      } };
    },
  };
  const outcome = await dispatchProactiveComparison({ db, candidateId, masterKey, provider });
  assert.equal(outcome.status, 'proposal');
  assert.equal(supplied.filter((source) => source.type === 'message').length, 13, '12 recent messages plus the mandatory older explicit reference');
  for (const [type, id] of [['work', work.id], ['material', material.materialId], ['material', doc.id]])
    assert.ok(supplied.some((source) => source.type === type && source.id === id), 'unlinked current project evidence is supplied');
  assert.ok(supplied.some((source) => source.type === 'result' && source.id === benchmark.id));
  assert.deepEqual(supplied.find((source) => source.id === thought.id),
    { type: 'thought', id: thought.id, version: thought.version, sketchId: sketch.id, title: 'Repeat the ToF trial at 5 lux.', text: 'Repeat the ToF trial at 5 lux.' });
  const excerpt = supplied.find((source) => source.id === work.id)!;
  assert.equal(excerpt.excerpted, true);
  assert.ok(excerpt.originalCharacters! > excerpt.text.length);
  assert.match(excerpt.text, /Excerpt: remaining source text was omitted/);
  assert.ok(!JSON.stringify(supplied).includes(canary));
  const proposals = expectStatus(await f.peer.browser.request('GET', `/api/v1/projects/${f.projectId}/proactive-comparison-proposals`), 200) as Array<{ id: string; version: number; sources: Array<{ type: string; id: string; version: number; sketchId?: string; title?: string }> }>;
  assert.ok(proposals[0]!.sources.some((source) => source.type === 'work' && source.id === work.id && source.version === 1));
  assert.ok(proposals[0]!.sources.some((source) => source.type === 'thought' && source.id === thought.id && source.version === 1));
  assert.equal(proposals[0]!.sources.find((source) => source.type === 'thought')?.sketchId, sketch.id,
    'the server supplies the thought navigation identity rather than trusting the provider');
  assert.equal(proposals[0]!.sources.find((source) => source.type === 'thought')?.title, 'Repeat the ToF trial at 5 lux.',
    'the citation label comes from the inspected source revision rather than model output');
  expectStatus(await f.peer.browser.request('POST', `/api/v1/proactive-comparison-proposals/${proposals[0]!.id}/use`,
    { body: { expectedVersion: proposals[0]!.version, title: 'Follow the reviewed suggestion' } }), 200);
  assert.equal((await rows.sourceSnapshot(result.id, f.rule.id)).fingerprint, before.fingerprint,
    'work made from the agent proposal cannot enter its evidence snapshot');
});

test('an explicit thought uses its actual version and sketch identity; a text edit invalidates the queued snapshot', async () => {
  const f = await fixture();
  const sketch = expectStatus(await f.peer.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Human project hypotheses', scope: 'project', projectId: f.projectId } }), 201) as { id: string };
  const { thought } = expectStatus(await f.peer.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: 'Camera exposure may be too short.', x: 0, y: 0 } }), 201) as { thought: { id: string; version: number } };
  const result = expectStatus(await f.peer.browser.request('POST', `/api/v1/projects/${f.projectId}/results`,
    { body: { title: 'Human negative camera trial', finding: 'negative', sources: [{ type: 'thought', id: thought.id }] } }), 201) as WorkResult;
  const candidateId = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0].id as string;
  const before = await proactiveOutboxRows(db).sourceSnapshot(result.id, f.rule.id);
  assert.deepEqual(before.sources.find((source) => source.type === 'thought'),
    { type: 'thought', id: thought.id, version: 1, sketchId: sketch.id });
  expectStatus(await f.peer.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/thoughts/${thought.id}`,
    { body: { text: 'The exposure was already long enough.' }, headers: { 'If-Match': '"1"' } }), 200);
  const after = await proactiveOutboxRows(db).sourceSnapshot(result.id, f.rule.id);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.sources.find((source) => source.type === 'thought')?.version, 2);
  const provider: ComparisonProvider = { async countInputTokens() { throw new Error('must not read old context'); }, async createMessage() { throw new Error('must not call'); } };
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId, masterKey, provider }), { status: 'not_run', reason: 'SOURCE_CHANGED' });
});

test('unlinked work revisions invalidate queued context, and lost owner access cannot select a new candidate', async () => {
  const f = await fixture();
  const work = expectStatus(await f.peer.browser.request('POST', `/api/v1/projects/${f.projectId}/work`,
    { body: { title: 'Human benchmark', outcome: 'Measure at 5 lux.' } }), 201) as WorkItem;
  const { result, candidateId } = await f.negative();
  assert.ok(candidateId);
  const before = await proactiveOutboxRows(db).sourceSnapshot(result.id, f.rule.id);
  expectStatus(await f.peer.browser.request('PATCH', `/api/v1/work/${work.id}`,
    { body: { outcome: 'Measure at 10 lux instead.' }, headers: { 'If-Match': '"1"' } }), 200);
  assert.notEqual((await proactiveOutboxRows(db).sourceSnapshot(result.id, f.rule.id)).fingerprint, before.fingerprint);
  let calls = 0;
  const provider: ComparisonProvider = { async countInputTokens() { calls++; return 1; }, async createMessage() { calls++; throw new Error('must not call'); } };
  assert.deepEqual(await dispatchProactiveComparison({ db, candidateId, masterKey, provider }), { status: 'not_run', reason: 'SOURCE_CHANGED' });
  assert.equal(calls, 0);
  await grant(f.owner, f.projectId, f.owner, 'denied');
  assert.equal((await f.negative()).candidateId, undefined, 'a permitted peer result does not select context for an owner who lost access');
});
