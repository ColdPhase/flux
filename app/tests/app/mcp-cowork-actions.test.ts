import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Agent, AgentExecutionCommand, CoWorkRequestLimits, WorkItem } from '@flux/contracts';
import { COWORK_PLAYBOOK, coworkPlaybookTools } from '@flux/core';
import { coWorkRequestInTransaction } from '../../apps/server/src/co-work/requests.js';
import { db, pool } from './support/db.js';
import { agentConnection, approveWaiting, toolFailure, waits } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// The co-work MCP tools (#153): unit creation, unit claims and request claim/decline over the real OAuth bearer, the
// registry and the same internal compositions. Request admission is not an MCP tool yet, so that step uses the internal
// composition with the same bearer's claims. Not real-client evidence.
const LIMITS: CoWorkRequestLimits = { maximumRequests: 128, maximumDepth: 8, maximumReviewRounds: 16 };
const COWORK_TOOLS = [
  { name: 'flux_create_unit', operation: 'cowork.unit.create' },
  { name: 'flux_claim_unit', operation: 'cowork.claim' },
  { name: 'flux_renew_unit', operation: 'cowork.renew' },
  { name: 'flux_release_unit', operation: 'cowork.release' },
  { name: 'flux_complete_unit', operation: 'cowork.unit.complete' },
  { name: 'flux_transfer_unit', operation: 'cowork.unit.transfer' },
  { name: 'flux_decline_unit', operation: 'cowork.unit.decline' },
  { name: 'flux_defer_request', operation: 'cowork.request.respond' },
  { name: 'flux_claim_request', operation: 'cowork.request.claim' },
  { name: 'flux_decline_request', operation: 'cowork.request.respond' },
  { name: 'flux_resolve_request', operation: 'cowork.request.respond' },
  { name: 'flux_send_request', operation: 'cowork.request' },
];
type Role = 'execute' | 'review' | 'plan';

async function scene() {
  const hubert = await person('mcp-cowork-hubert'), marek = await person('mcp-cowork-marek');
  const ws = await workspace(hubert, 'MCP co-work');
  // Marek authorizes his own connection's standing grants, which needs project management (#152).
  await addMember(hubert, ws.id, marek, 'admin');
  const p = await project(hubert, ws.id, 'Shared outcome', 'restricted');
  await grant(hubert, p.id, marek, 'contributor');
  /** One OAuth-connected agent of `who`, with its MCP tools, bootstrap runtime and the bearer's claims for internal steps. */
  const connect = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as Agent;
    const connected = await agentConnection(pool, who.browser, String(agent.id), [p.id]);
    const binding = (await pool.query('SELECT id, client_id FROM agent_oauth_bindings WHERE connection_id=$1', [connected.connectionId])).rows;
    assert.equal(binding.length, 1);
    const claims = { ownerUserId: who.id, connectionId: connected.connectionId, clientId: String(binding[0].client_id),
      grantReferenceId: `flux-grant:${binding[0].id}` };
    const base = (role: Role, clientCommandId: string = randomUUID()) => ({ projectId: p.id,
      runtimeSessionId: connected.runtimeSessionId, clientCommandId, peerRequestClass: role });
    const internal = (operation: string, objectId: string, role: Role, payload: Record<string, unknown>): AgentExecutionCommand =>
      ({ runtimeSessionId: connected.runtimeSessionId, clientCommandId: randomUUID(), projectId: p.id,
        operation: operation as AgentExecutionCommand['operation'], peerRequestClass: role, audience: { kind: 'project', projectId: p.id },
        objectId, sources: [], payload: payload as AgentExecutionCommand['payload'] });
    /** A live claim on this connection's unit over MCP (flux_claim_unit). */
    const claimUnit = async (unitId: string, role: Role, expectedVersion = 1) => {
      const claimed = toolValue(await connected.tool('flux_claim_unit', { ...base(role), unitId, expectedVersion }));
      return claimed as { generation: number; version: number; lease: { id: string } | null };
    };
    return { ...connected, claims, base, internal, claimUnit };
  };
  const task = async (title: string) => expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`,
    { body: { title } }), 201) as WorkItem;
  const material = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Review criteria', body: 'Exact current revision' } }), 201) as { materialId: string };
  const units = async () => (await pool.query('SELECT id, work_id, role, assignment_connection_id, state, version FROM cowork_units WHERE workspace_id=$1 ORDER BY id',
    [ws.id])).rows;
  return { hubert, marek, ws, p, connect, task, material, units };
}
/** A strict schema refusal: the SDK reports it as a tool error or a JSON-RPC error, never a domain effect. */
function schemaRefused(message: Record<string, unknown> | null) {
  return !!message?.error || (message?.result as { isError?: boolean } | undefined)?.isError === true;
}

test('the co-work tools are registered as changes, listed with their operation and classes, and declared by the playbook', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex');
  const capabilities = codex.bootstrap.capabilities as { name: string; operation: string | null; classes: string[]; available: boolean }[];
  assert.deepEqual(capabilities.filter((item) => item.operation?.startsWith('cowork.')).map(({ name, operation, classes, available }) =>
    ({ name, operation, classes, available })), COWORK_TOOLS.map((tool) => ({ ...tool, classes: ['execute', 'review', 'plan'], available: true })),
  'exactly these co-work action tools are registered');
  assert.ok(capabilities.every((item) => !('requiredScope' in item)), 'there are no scopes to require (#859)');
  // The playbook names every co-work tool in a module and names no tool the server does not register.
  for (const { name } of COWORK_TOOLS) assert.ok(COWORK_PLAYBOOK.modules.some((module) => module.tools.includes(name)), `${name} is declared`);
  const catalog = capabilities.map((item) => item.name);
  assert.deepEqual(coworkPlaybookTools().filter((name) => !catalog.includes(name)), []);
  assert.equal(COWORK_PLAYBOOK.version, '1.13.0');
  assert.ok(!(codex.bootstrap.gaps as string[]).includes('coordination_unavailable'), 'admission, the inbox and resolution exist');

  // An agent set to Only read is told its change tools are not available now, and a call to one is refused before any effect.
  const reader = await f.connect(f.hubert, 'Hubert reader');
  expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/agent-connections/${reader.connectionId}`, { body: { mayDo: 'read' } }), 200);
  const told = toolValue(await reader.tool('flux_bootstrap', { projectId: f.p.id, clientSessionId: randomUUID() })) as { capabilities: { name: string; available: boolean }[] };
  const changing = told.capabilities.filter((item) => COWORK_TOOLS.some((tool) => tool.name === item.name && tool.operation !== null));
  assert.ok(changing.length > 0 && changing.every((item) => !item.available), 'every co-work change tool is unavailable to an agent that only reads');
  const a = await f.task('Native outcome A');
  const refused = toolFailure(await reader.tool('flux_create_unit', { ...reader.base('execute'), taskId: a.id, unitKey: 'take',
    expectedTaskVersion: a.version, assignmentConnectionId: reader.connectionId, parent: null }));
  assert.equal(refused.code, 'AGENT_ONLY_READS');
  assert.deepEqual(await f.units(), []);
});

test('flux_create_unit takes a task atomically: a retry replays, a re-issued intent returns the unit, a second connection is refused', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), claude = await f.connect(f.hubert, 'Hubert Claude');
  const a = await f.task('Native outcome A');
  const input = (clientCommandId: string, change: Record<string, unknown> = {}) => ({ ...codex.base('execute', clientCommandId),
    taskId: a.id, unitKey: 'take', expectedTaskVersion: a.version, assignmentConnectionId: codex.connectionId, parent: null, ...change });
  const first = randomUUID();
  const created = toolValue(await codex.tool('flux_create_unit', input(first)));
  assert.deepEqual({ ...created, unitId: undefined, runId: undefined }, { status: 'created', unitId: undefined, taskId: a.id, lineageTaskId: a.id,
    runId: undefined, role: 'execute', assignmentConnectionId: codex.connectionId, version: 1, state: 'pending' });
  assert.deepEqual(await f.units(), [{ id: created.unitId, work_id: a.id, role: 'execute', assignment_connection_id: codex.connectionId,
    state: 'pending', version: 1 }]);
  // A lost response is retried with the same command ID: the stored outcome, no second unit or debit.
  assert.deepEqual(toolValue(await codex.tool('flux_create_unit', input(first))), created);
  assert.equal(toolFailure(await codex.tool('flux_create_unit', input(first, { unitKey: 'take-2' }))).code, 'IDEMPOTENCY_CONFLICT');
  // The same intent under a new command ID returns the existing unit and spends one more use.
  assert.deepEqual(toolValue(await codex.tool('flux_create_unit', input(randomUUID()))), { ...created, status: 'existing' });
  // Another connection of the same owner cannot take the task while the unit is open.
  assert.equal(toolFailure(await claude.tool('flux_create_unit', { ...claude.base('execute'), taskId: a.id, unitKey: 'take',
    expectedTaskVersion: a.version, assignmentConnectionId: claude.connectionId, parent: null })).code, 'COWORK_UNIT_TAKEN');
  // Target controls: a guessed task, a stale task version.
  assert.equal(toolFailure(await codex.tool('flux_create_unit', { ...input(randomUUID()), taskId: randomUUID() })).code,
    'OBJECT_NOT_FOUND');
  assert.equal(toolFailure(await codex.tool('flux_create_unit', { ...input(randomUUID()), unitKey: 'other', expectedTaskVersion: a.version + 1 })).code,
    'COWORK_VERSION_CONFLICT');
  // The strict schema refuses copied prompts, a missing parent and lineage fields before any effect.
  for (const change of [{ prompt: 'take it' }, { parent: undefined }, { runId: randomUUID() }, { unitKey: 'has space' }]) {
    const value = input(randomUUID(), change);
    if ('parent' in change && change.parent === undefined) delete (value as Record<string, unknown>).parent;
    assert.ok(schemaRefused(await codex.tool('flux_create_unit', value)), JSON.stringify(change));
  }
  assert.equal((await f.units()).length, 1);
});

test('flux_claim_request and flux_decline_request act only on a request addressed to the caller\'s unit, under its live claim', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  // Codex takes task A and claims its root unit over MCP; it opens Marek's review unit over MCP with that parent fence.
  const root = toolValue(await codex.tool('flux_create_unit', { ...codex.base('execute'), taskId: a.id, unitKey: 'take',
    expectedTaskVersion: a.version, assignmentConnectionId: codex.connectionId, parent: null }));
  const rootClaim = await codex.claimUnit(String(root.unitId), 'execute');
  // A unit for another person's client waits for the sender's owner (C-18): Approve opens it.
  assert.ok(waits(await codex.tool('flux_create_unit', { ...codex.base('review'), taskId: a.id, unitKey: 'review',
    expectedTaskVersion: a.version, assignmentConnectionId: marekClaude.connectionId,
    parent: { unitId: root.unitId, generation: rootClaim.generation, leaseId: rootClaim.lease!.id } })), 'a unit for another person\'s client waits');
  const review = await approveWaiting(pool, f.hubert.browser, codex.connectionId, 'cowork.unit.create');
  assert.deepEqual([review.status, review.role, review.assignmentConnectionId, review.runId], ['created', 'review', marekClaude.connectionId, root.runId]);
  const reviewUnit = String(review.unitId);

  // Marek's own owner grants his request claim and respond. Without a live unit claim both are refused.
  const noClaim = { unitId: reviewUnit, generation: 1, leaseId: randomUUID(), requestId: randomUUID(), expectedRequestVersion: 1 };
  assert.equal(toolFailure(await marekClaude.tool('flux_claim_request', { ...marekClaude.base('review'), ...noClaim })).code, 'COWORK_CLAIM_LOST');
  assert.equal(toolFailure(await marekClaude.tool('flux_decline_request', { ...marekClaude.base('review'), ...noClaim, reason: 'scope' })).code,
    'COWORK_CLAIM_LOST');

  // Marek claims his unit over MCP and Codex addresses a review request to it (internal composition).
  const reviewClaim = await marekClaude.claimUnit(reviewUnit, 'review');
  const asked = await db.transaction((tx) => coWorkRequestInTransaction(tx, codex.claims, codex.internal('cowork.request', String(root.unitId),
    'execute', { generation: rootClaim.generation, leaseId: rootClaim.lease!.id, request: { unitId: reviewUnit,
      expectedUnitVersion: reviewClaim.version, recipientConnectionId: marekClaude.connectionId, intentKey: 'review-1', parentRequestId: null,
      kind: 'review', target: { type: 'work', id: a.id, version: a.version }, sourceRefs: [{ type: 'material', id: f.material.materialId, version: 1 }],
      criteriaRefs: [{ type: 'work', id: a.id, version: a.version }], priority: 1, peerUnblocking: true, lifetimeSeconds: 3600 } }),
  { limits: LIMITS }));
  const fence = { unitId: reviewUnit, generation: reviewClaim.generation, leaseId: reviewClaim.lease!.id, requestId: asked.requestId };

  // Over MCP: claim the request; a retry replays; claiming it again under the same live claim is refused.
  const first = randomUUID();
  const claimInput = { ...marekClaude.base('review', first), ...fence, expectedRequestVersion: 1 };
  const claimed = toolValue(await marekClaude.tool('flux_claim_request', claimInput));
  assert.deepEqual(claimed, { requestId: asked.requestId, version: 2, state: 'claimed', responseRef: null });
  assert.deepEqual(toolValue(await marekClaude.tool('flux_claim_request', claimInput)), claimed);
  assert.equal(toolFailure(await marekClaude.tool('flux_claim_request', { ...claimInput, clientCommandId: randomUUID(), expectedRequestVersion: 2 })).code,
    'COWORK_REQUEST_CLAIMED');
  // The sender cannot act on the recipient's unit: its role does not find it.
  assert.equal(toolFailure(await codex.tool('flux_decline_request', { ...codex.base('review'), ...fence, expectedRequestVersion: 2,
    reason: 'scope' })).code, 'COWORK_UNIT_NOT_FOUND');

  // The decline schema admits only a bounded reason; resolving with a response is not exposed.
  const declineInput = { ...marekClaude.base('review'), ...fence, expectedRequestVersion: 2, reason: 'capability' };
  for (const change of [{ reason: 'later' }, { outcome: 'resolved' }, { response: { title: 'Findings' } }, { outcome: 'declined' }])
    assert.ok(schemaRefused(await marekClaude.tool('flux_decline_request', { ...declineInput, clientCommandId: randomUUID(), ...change })),
      JSON.stringify(change));
  const declined = toolValue(await marekClaude.tool('flux_decline_request', declineInput));
  assert.deepEqual(declined, { requestId: asked.requestId, version: 3, state: 'declined', responseRef: null });
  assert.deepEqual(toolValue(await marekClaude.tool('flux_decline_request', declineInput)), declined, 'a retry replays the decline');
  const row = (await pool.query('SELECT state, version, reason, response_ref FROM cowork_requests WHERE id=$1', [asked.requestId])).rows[0];
  assert.deepEqual(row, { state: 'declined', version: 3, reason: 'capability', response_ref: null });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id=$1', [f.p.id])).rows[0].n, 0,
    'a decline publishes nothing');
  // A closed request cannot be declined again.
  assert.equal(toolFailure(await marekClaude.tool('flux_decline_request', { ...declineInput, clientCommandId: randomUUID(), expectedRequestVersion: 3 })).code,
    'COWORK_REQUEST_CLOSED');
});
