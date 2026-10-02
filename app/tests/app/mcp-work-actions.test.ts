import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { publicOrigin, register, uniqueEmail } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue } from './support/mcp.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

const actionScope = 'flux.context.read flux.proposal.write flux.action.execute offline_access';

/** A failed tool result carries only the domain code and message. */
function toolFailure(message: Record<string, unknown> | null) {
  const result = message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  assert.equal(result?.isError, true, `expected a tool error: ${JSON.stringify(message)}`);
  return JSON.parse(result!.content![0]!.text ?? '') as { code: string; error: string };
}

async function scene() {
  const { browser: owner } = await register(uniqueEmail('mcp-task-owner'), 'correct horse battery staple');
  const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'MCP task actions' } }), 201);
  const project = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
    { body: { name: 'Planned project', visibility: 'restricted' } }), 201);
  const projectId = String(project.id);
  const agent = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`,
    { body: { name: 'Planning agent', owner: 'self' } }), 201);
  expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const plan = expect(await owner.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Release plan', body: 'Step one: measure. Step two: compare.' } }), 201);
  const source = { materialId: String(plan.materialId), version: Number(plan.version) };
  const prerequisite = expect(await owner.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title: 'Measure the baseline' } }), 201);
  const connection = expect(await owner.request('POST', '/api/v1/agent-connections', { body: { agentId: agent.id,
    selectedProjectIds: [projectId], scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] } }), 201);
  const connectionId = String(connection.id);
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
    ['flux.context.read', 'flux.proposal.write', 'flux.action.execute', 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const tokens = await oauthToken(owner, connectionId, clientId, redirectUri,
    await beginOauth(owner, clientId, redirectUri, { prompt: 'consent', scope: actionScope }));
  const grant = async (operation: 'work.create' | 'work.update' | 'result.record' | 'decision.propose', peerRequestClass: 'execute' | 'plan', maximumUses = 5) =>
    expect(await owner.request('POST', `/api/v1/agent-connections/${connectionId}/action-grants`, { body: {
      clientCommandId: randomUUID(), projectId, operation, peerRequestClass, maximumUses,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as { id: string; used: number };
  let call = 100;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await mcp(tokens.access_token, call++, 'tools/call', { name, arguments: args });
    assert.equal(response.status, 200, `MCP ${name} returned ${response.status}`);
    return response.message;
  };
  const bootstrap = toolValue(await tool('flux_bootstrap', { projectId, clientSessionId: randomUUID() }));
  const runtimeSessionId = (bootstrap.runtime as { id: string }).id;
  const read = async (workId: string) => expect(await owner.request('GET', `/api/v1/work/${workId}`), 200);
  const used = async (grantId: string) => (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0].used as number;
  const tasks = async () => (await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1', [projectId])).rows[0].n as number;
  return { owner, projectId, agentId: String(agent.id), connectionId, source, prerequisiteId: String(prerequisite.id), bootstrap,
    runtimeSessionId, grant, tool, read, used, tasks };
}

test('a standing work.create grant creates one planned native task through MCP; retries and repeated intents never duplicate it', async () => {
  const f = await scene();
  const capabilities = f.bootstrap.capabilities as { name: string; operation: string | null; classes: string[]; available: boolean }[];
  assert.deepEqual(capabilities.filter((item) => item.operation !== null).map(({ name, operation, available }) => ({ name, operation, available })),
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
  const f = await scene();
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
  const f = await scene();
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
