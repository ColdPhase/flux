import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

test('a standing work.create grant creates one planned native task through MCP; retries and repeated intents never duplicate it', async () => {
  const f = await actionScene(pool);
  const capabilities = f.bootstrap.capabilities as { name: string; operation: string | null; classes: string[]; available: boolean }[];
  assert.deepEqual(capabilities.filter((item) => item.operation !== null && /^(work|result|decision)\./.test(item.operation)).map(({ name, operation, available }) => ({ name, operation, available })),
    [{ name: 'flux_create_task', operation: 'work.create', available: true }, { name: 'flux_update_task', operation: 'work.update', available: true },
      { name: 'flux_record_result', operation: 'result.record', available: true }, { name: 'flux_propose_decision', operation: 'decision.propose', available: true }]);
  const create = await f.grant('work.create', 'plan');
  const command = (clientCommandId: string, title = 'Compare against the baseline') => ({ projectId: f.projectId,
    runtimeSessionId: f.runtimeSessionId, grantId: create.id, clientCommandId, peerRequestClass: 'plan', sources: [f.source],
    task: { title, criteria: ['The comparison names both runs'], dependencyIds: [f.prerequisiteId],
      planIntent: { ...f.source, intentKey: 'compare-step' } } });
  const before = await f.tasks();
  const first = randomUUID();
  const created = toolValue(await f.tool('flux_create_task', command(first)));
  assert.equal(created.replayed, false);
  const task = await f.read(String(created.workId));
  assert.equal(task.version, created.version);
  assert.deepEqual([task.title, task.criteria, task.dependencyIds, task.planIntent],
    ['Compare against the baseline', ['The comparison names both runs'], [f.prerequisiteId], { ...f.source, intentKey: 'compare-step' }]);
  assert.deepEqual([(task.createdBy as { kind: string }).kind, (task.createdBy as { id: string }).id], ['agent', f.agentId]);
  assert.deepEqual((task.links as { role: string; to: unknown }[]).filter((link) => link.role === 'source').map((link) => link.to),
    [{ type: 'material', id: f.source.materialId, version: f.source.version }], 'the cited plan revision is linked as the task source');
  assert.equal(await f.tasks(), before + 1);
  assert.equal(await f.used(create.id), 1);

  // A lost response is retried with the same command ID: the stored outcome, no second task or debit.
  assert.deepEqual(toolValue(await f.tool('flux_create_task', command(first))), { ...created, replayed: true });
  assert.equal(await f.tasks(), before + 1);
  assert.equal(await f.used(create.id), 1);
  assert.equal(toolFailure(await f.tool('flux_create_task', command(first, 'Another title'))).code, 'IDEMPOTENCY_CONFLICT');
  // Another planner run repeats the same intent with a new command ID: the existing task, never a duplicate.
  const repeated = toolValue(await f.tool('flux_create_task', command(randomUUID())));
  assert.equal(repeated.workId, created.workId);
  assert.equal(await f.tasks(), before + 1);
  assert.equal(toolFailure(await f.tool('flux_create_task', command(randomUUID(), 'A different task for the same intent'))).code, 'TASK_INTENT_CONFLICT');
  assert.equal(await f.tasks(), before + 1);

  // A changed plan revision is refused before any effect; the task keeps its original revision.
  const edited = expect(await f.owner.request('PATCH', `/api/v1/materials/${f.source.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: f.source.version, body: 'Step one: measure twice.' } }), 200);
  assert.equal(Number(edited.version), f.source.version + 1);
  assert.equal(toolFailure(await f.tool('flux_create_task', command(randomUUID()))).code, 'SOURCE_VERSION_CONFLICT');
  assert.equal(await f.tasks(), before + 1);

  // Revoking the grant stops the next action immediately; nothing is created or debited.
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}/action-grants/${create.id}`), 204);
  const revoked = command(randomUUID(), 'After revocation');
  revoked.sources = [{ ...f.source, version: f.source.version + 1 }];
  revoked.task.planIntent = { materialId: f.source.materialId, version: f.source.version + 1, intentKey: 'after-revocation' };
  assert.equal(toolFailure(await f.tool('flux_create_task', revoked)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(await f.tasks(), before + 1);
});

test('a standing work.update grant changes a task at its read version and keeps prerequisite and version rules', async () => {
  const f = await actionScene(pool);
  const update = await f.grant('work.update', 'execute');
  const target = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`,
    { body: { title: 'Run the comparison', dependencyIds: [f.prerequisiteId] } }), 201);
  const change = (expectedVersion: number, changes: Record<string, unknown>, clientCommandId = randomUUID()) => ({ projectId: f.projectId,
    runtimeSessionId: f.runtimeSessionId, grantId: update.id, clientCommandId, peerRequestClass: 'execute', sources: [],
    workId: target.id, expectedVersion, changes });
  const unmet = toolFailure(await f.tool('flux_update_task', change(Number(target.version), { status: 'in_progress' })));
  assert.equal(unmet.code, 'TASK_PREREQUISITES_UNMET');
  assert.equal(await f.used(update.id), 0, 'a refused change debits nothing');
  const prerequisite = await f.read(f.prerequisiteId);
  expect(await f.owner.request('PATCH', `/api/v1/work/${f.prerequisiteId}`,
    { body: { status: 'done' }, headers: { 'if-match': `"${prerequisite.version}"` } }), 200);
  assert.equal(toolFailure(await f.tool('flux_update_task', change(Number(target.version) + 5, { status: 'in_progress' }))).code, 'VERSION_CONFLICT');
  const first = randomUUID();
  const started = toolValue(await f.tool('flux_update_task', change(Number(target.version),
    { status: 'in_progress', criteria: ['Both runs are attached'] }, first)));
  assert.equal(started.replayed, false);
  const task = await f.read(String(target.id));
  assert.deepEqual([task.status, task.criteria, task.version], ['in_progress', ['Both runs are attached'], started.version]);
  assert.equal(await f.used(update.id), 1);
  assert.deepEqual(toolValue(await f.tool('flux_update_task', change(Number(target.version),
    { status: 'in_progress', criteria: ['Both runs are attached'] }, first))), { ...started, replayed: true });
  assert.equal(await f.used(update.id), 1);
  // Another command on a project task outside the update grant's project would never reach the domain.
  assert.equal(toolFailure(await f.tool('flux_update_task', { ...change(Number(started.version), { title: 'Elsewhere' }), workId: randomUUID() })).code,
    'OBJECT_NOT_FOUND');
  // A change cannot rewrite the immutable plan intent; the strict tool schema rejects the field outright.
  const rejected = await f.tool('flux_update_task', change(Number(started.version), { planIntent: null }));
  assert.equal((rejected?.result as { isError?: boolean } | undefined)?.isError ?? !!rejected?.error, true);
  assert.equal(await f.used(update.id), 1);
});

test('standing result and decision grants record a finding that finishes a task and propose a decision, never accept it', async () => {
  const f = await actionScene(pool);
  const results = await f.grant('result.record', 'execute');
  const decisions = await f.grant('decision.propose', 'plan');
  const prerequisite = await f.read(f.prerequisiteId);
  const base = (grantId: string, peerRequestClass: string, clientCommandId: string = randomUUID()) => ({ projectId: f.projectId,
    runtimeSessionId: f.runtimeSessionId, grantId, clientCommandId, peerRequestClass, sources: [f.source] });
  const finding = (clientCommandId?: string) => ({ ...base(results.id, 'execute', clientCommandId), result: { title: 'Baseline measured',
    finding: 'negative', evidence: 'Runtime stayed at four hours', workIds: [f.prerequisiteId],
    finishes: { workId: f.prerequisiteId, expectedVersion: Number(prerequisite.version) } } });
  const first = randomUUID();
  const recorded = toolValue(await f.tool('flux_record_result', finding(first)));
  assert.equal(recorded.replayed, false);
  const result = expect(await f.owner.request('GET', `/api/v1/results/${recorded.resultId}`), 200);
  assert.deepEqual([result.title, result.finding, (result.createdBy as { id: string }).id], ['Baseline measured', 'negative', f.agentId]);
  assert.equal((await f.read(f.prerequisiteId)).status, 'done', 'the result finished the task it names');
  assert.deepEqual(toolValue(await f.tool('flux_record_result', finding(first))), { ...recorded, replayed: true });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id=$1', [f.projectId])).rows[0].n, 1);
  const planClass = await f.tool('flux_record_result', { ...finding(), peerRequestClass: 'plan' });
  assert.ok(planClass?.error || (planClass?.result as { isError?: boolean } | undefined)?.isError, 'a result needs an execute-class grant');
  assert.equal(await f.used(results.id), 1);

  const proposal = { ...base(decisions.id, 'plan'), decision: { title: 'Keep the four-hour baseline', rationale: 'The measured runtime holds',
    affects: [f.prerequisiteId] } };
  const proposed = toolValue(await f.tool('flux_propose_decision', proposal));
  const decision = expect(await f.owner.request('GET', `/api/v1/decisions/${proposed.decisionId}`), 200);
  assert.deepEqual([decision.status, (decision.proposedBy as { id: string }).id, decision.decidedBy], ['proposed', f.agentId, null],
    'an agent proposal stays proposed for a person to decide');
  assert.equal(await f.used(decisions.id), 1);
  // A decision.propose grant authorizes nothing else: it cannot record a result.
  assert.equal(toolFailure(await f.tool('flux_record_result', { ...finding(), grantId: decisions.id })).code, 'AGENT_EXECUTION_UNAVAILABLE');
});
