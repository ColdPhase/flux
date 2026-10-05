import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { AgentStandingGrant } from '@flux/contracts';
import { pool } from './support/db.js';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { person } from './support/people.js';

// The owner's standing-grant controls (#152 T152-a): the HTTP calls the Connect page makes, observed through the
// agent's real OAuth bearer and MCP tools. Granting, narrowing, revoking and expiry apply to the agent's next call.

type Scene = Awaited<ReturnType<typeof actionScene>>;
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 24 * 3_600_000;

function grantsPath(f: Scene, grantId?: string) {
  return `/api/v1/agent-connections/${f.connectionId}/action-grants${grantId ? `/${grantId}` : ''}`;
}
async function ownerGrant(f: Scene, maximumUses: number, operation = 'work.create') {
  return expect(await f.owner.request('POST', grantsPath(f), { body: { clientCommandId: randomUUID(), projectId: f.projectId,
    operation, peerRequestClass: 'execute', maximumUses, expiresAt: later(DAY) } }), 201) as unknown as AgentStandingGrant;
}
/** One flux_create_task call under `grantId` with its own command ID unless one is given. */
function createTask(f: Scene, grantId: string, title: string, clientCommandId = randomUUID()) {
  return f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId, clientCommandId,
    peerRequestClass: 'execute', sources: [], task: { title } });
}
/** What the agent itself sees of its grants on its next bootstrap. */
async function agentGrants(f: Scene) {
  const bootstrap = toolValue(await f.tool('flux_bootstrap', { projectId: f.projectId, clientSessionId: randomUUID() }));
  return (bootstrap.grants as { items: (AgentStandingGrant & { remainingUses: number })[] }).items;
}
async function row(grantId: string) {
  return (await pool.query('SELECT used, maximum_uses, expires_at, revoked_at, generation FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0] as
    { used: number; maximum_uses: number; expires_at: Date; revoked_at: Date | null; generation: number };
}

test('an owner grant allows the agent\'s next MCP call; narrowing to the uses already made refuses the next one but keeps replays', async () => {
  const f = await actionScene(pool);
  // Nothing is granted yet: the call is refused before any effect.
  assert.equal(toolFailure(await createTask(f, randomUUID(), 'Before any grant')).code, 'AGENT_EXECUTION_UNAVAILABLE');
  const before = await f.tasks();

  const grant = await ownerGrant(f, 3);
  const first = randomUUID();
  const created = toolValue(await createTask(f, grant.id, 'Measured under a grant', first));
  assert.equal(created.replayed, false);
  assert.equal(await f.tasks(), before + 1);
  assert.equal(await f.used(grant.id), 1);

  // The owner narrows the grant to the one use already made. Same grant, same generation: only the limits change.
  const narrowed = expect(await f.owner.request('PATCH', grantsPath(f, grant.id), { body: { maximumUses: 1 } }), 200) as unknown as AgentStandingGrant;
  assert.deepEqual([narrowed.id, narrowed.maximumUses, narrowed.used, narrowed.generation, narrowed.revokedAt], [grant.id, 1, 1, grant.generation, null]);
  const listed = expect(await f.owner.request('GET', grantsPath(f)), 200) as unknown as { items: AgentStandingGrant[] };
  assert.equal(listed.items.find((item) => item.id === grant.id)?.maximumUses, 1, 'the owner\'s list shows the narrowed limit at once');
  const seen = (await agentGrants(f)).find((item) => item.id === grant.id);
  assert.deepEqual([seen?.maximumUses, seen?.remainingUses], [1, 0], 'the agent\'s next bootstrap shows the narrowed limit');

  // A lost answer can still be recovered: the replay returns the original task without a new effect or debit.
  assert.deepEqual(toolValue(await createTask(f, grant.id, 'Measured under a grant', first)), { ...created, replayed: true });
  // A new command is refused on the very next call, with nothing created or debited.
  assert.equal(toolFailure(await createTask(f, grant.id, 'Beyond the narrowed limit')).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.deepEqual([await f.tasks(), await f.used(grant.id)], [before + 1, 1]);
});

test('narrowing only ever narrows: wider, past, empty or unknown limits are refused and the grant is unchanged', async () => {
  const f = await actionScene(pool);
  const grant = await ownerGrant(f, 5);
  toolValue(await createTask(f, grant.id, 'One use before narrowing'));
  const path = grantsPath(f, grant.id);
  const refused = async (body: unknown, status: number, code?: string) => {
    const response = await f.owner.request('PATCH', path, { body });
    assert.equal(response.status, status, `${JSON.stringify(body)}: ${response.text}`);
    if (code) assert.equal((response.json as { code: string }).code, code);
  };
  await refused({ maximumUses: 6 }, 400, 'GRANT_NOT_NARROWER');
  await refused({ expiresAt: later(2 * DAY) }, 400, 'GRANT_NOT_NARROWER');
  await refused({ expiresAt: new Date(Date.now() - 60_000).toISOString() }, 400, 'GRANT_NOT_NARROWER');
  await refused({ maximumUses: 0 }, 400);
  await refused({}, 400);
  await refused({ maximumUses: 2, operation: 'work.update' }, 400, 'GRANT_NOT_NARROWER');
  await refused({ maximumUses: 2, projectId: randomUUID() }, 400, 'GRANT_NOT_NARROWER');
  const unchanged = await row(grant.id);
  assert.deepEqual([unchanged.maximum_uses, unchanged.used, unchanged.revoked_at], [5, 1, null]);
  assert.ok(Math.abs(unchanged.expires_at.getTime() - Date.parse(grant.expiresAt)) < 1000);

  // A real narrowing of both limits; repeating it is idempotent.
  const end = later(3_600_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    const narrowed = expect(await f.owner.request('PATCH', path, { body: { maximumUses: 2, expiresAt: end } }), 200) as unknown as AgentStandingGrant;
    assert.deepEqual([narrowed.maximumUses, narrowed.expiresAt, narrowed.generation], [2, end, grant.generation]);
  }
  toolValue(await createTask(f, grant.id, 'The last narrowed use'));
  assert.equal(toolFailure(await createTask(f, grant.id, 'Past the narrowed limit')).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(await f.used(grant.id), 2);
  await refused({ maximumUses: 1 }, 400, 'GRANT_NOT_NARROWER');
});

test('after its expiry passes the agent\'s next call is refused; the grant can no longer be narrowed', async () => {
  const f = await actionScene(pool);
  const grant = await ownerGrant(f, 5);
  const first = randomUUID();
  const created = toolValue(await createTask(f, grant.id, 'Before the grant ends', first));
  // The owner moves the end to two seconds from now through the same narrowing the Connect page uses.
  expect(await f.owner.request('PATCH', grantsPath(f, grant.id), { body: { expiresAt: later(2_000) } }), 200);
  await sleep(2_600);
  const before = await f.tasks();
  assert.equal(toolFailure(await createTask(f, grant.id, 'After the grant ended')).code, 'AGENT_EXECUTION_UNAVAILABLE');
  // An expired grant no longer covers even a replay of its earlier command.
  assert.equal(toolFailure(await createTask(f, grant.id, 'Before the grant ends', first)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.deepEqual([await f.tasks(), await f.used(grant.id)], [before, 1]);
  assert.ok(created.workId);
  assert.equal((await agentGrants(f)).some((item) => item.id === grant.id), false, 'the agent no longer sees the ended grant');
  const narrow = await f.owner.request('PATCH', grantsPath(f, grant.id), { body: { maximumUses: 1 } });
  assert.deepEqual([narrow.status, (narrow.json as { code: string }).code], [404, 'GRANT_NOT_FOUND']);
});

test('revoking refuses the agent\'s next call, including a replay; a revoked grant cannot be narrowed or revoked again', async () => {
  const f = await actionScene(pool);
  const grant = await ownerGrant(f, 5);
  const first = randomUUID();
  toolValue(await createTask(f, grant.id, 'Before revocation', first));
  const generation = (await row(grant.id)).generation;
  expect(await f.owner.request('DELETE', grantsPath(f, grant.id)), 204);
  const revoked = await row(grant.id);
  assert.ok(revoked.revoked_at); assert.equal(revoked.generation, generation + 1);
  const before = await f.tasks();
  assert.equal(toolFailure(await createTask(f, grant.id, 'After revocation')).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await createTask(f, grant.id, 'Before revocation', first)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(await f.tasks(), before);
  assert.equal((await agentGrants(f)).some((item) => item.id === grant.id), false);
  for (const [method, body] of [['PATCH', { maximumUses: 1 }], ['DELETE', undefined]] as const) {
    const response = await f.owner.request(method, grantsPath(f, grant.id), body ? { body } : {});
    assert.deepEqual([response.status, (response.json as { code: string }).code], [404, 'GRANT_NOT_FOUND']);
  }
});

test('another member, even a workspace owner and project manager, cannot see, add, narrow or revoke someone else\'s grants', async () => {
  const f = await actionScene(pool);
  const grant = await ownerGrant(f, 4);
  const peer = await person('grant-controls-peer');
  expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/members`, { body: { email: peer.email, role: 'owner' } }), 201);
  const project = expect(await peer.browser.request('GET', `/api/v1/projects/${f.projectId}`), 200);
  assert.equal(project.access, 'manager', 'the peer manages the project');

  // The Connect page lists only the caller's own connections, so the owner's connection is never shown to the peer.
  const peerConnections = expect(await peer.browser.request('GET', '/api/v1/agent-connections'), 200) as unknown as { id: string }[];
  assert.equal(peerConnections.some((item) => item.id === f.connectionId), false);
  for (const [method, path, body] of [
    ['GET', grantsPath(f), undefined],
    ['POST', grantsPath(f), { clientCommandId: randomUUID(), projectId: f.projectId, operation: 'work.create', peerRequestClass: 'execute', maximumUses: 9, expiresAt: later(DAY) }],
    ['PATCH', grantsPath(f, grant.id), { maximumUses: 1 }],
    ['DELETE', grantsPath(f, grant.id), undefined],
  ] as const) {
    const response = await peer.browser.request(method, path, body ? { body } : {});
    assert.equal(response.status, 404, `${method} ${path} by another member: ${response.text}`);
    assert.ok(!response.text.includes(grant.id), 'the refusal names no grant');
  }
  // Through the peer's own connection, the owner's grant is just as absent.
  const agent = expect(await peer.browser.request('POST', `/api/v1/workspaces/${f.workspaceId}/agents`, { body: { name: 'Peer agent', owner: 'self' } }), 201);
  expect(await peer.browser.request('POST', `/api/v1/projects/${f.projectId}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const own = expect(await peer.browser.request('POST', '/api/v1/agent-connections', { body: { agentId: agent.id, selectedProjectIds: [f.projectId],
    scopes: ['flux.context.read', 'flux.action.execute'] } }), 201);
  const ownPath = `/api/v1/agent-connections/${own.id}/action-grants`;
  assert.equal((expect(await peer.browser.request('GET', ownPath), 200) as { total: number }).total, 0);
  for (const [method, body] of [['PATCH', { maximumUses: 1 }], ['DELETE', undefined]] as const)
    assert.equal((await peer.browser.request(method, `${ownPath}/${grant.id}`, body ? { body } : {})).status, 404);

  // The owner's grant is untouched and still works for the owner's agent.
  const unchanged = await row(grant.id);
  assert.deepEqual([unchanged.maximum_uses, unchanged.used, unchanged.revoked_at], [4, 0, null]);
  toolValue(await createTask(f, grant.id, 'Still granted by its owner'));
  assert.equal(await f.used(grant.id), 1);
});

test('a grant cannot go above the connection\'s ceiling: its action scope, selected projects, operation classes and the 30-day limit', async () => {
  const f = await actionScene(pool);
  const create = (connectionId: string, changes: Record<string, unknown>) => f.owner.request('POST', `/api/v1/agent-connections/${connectionId}/action-grants`, { body: {
    clientCommandId: randomUUID(), projectId: f.projectId, operation: 'work.create', peerRequestClass: 'execute', maximumUses: 5, expiresAt: later(DAY), ...changes } });
  const refused = async (connectionId: string, changes: Record<string, unknown>, status: number, code?: string) => {
    const response = await create(connectionId, changes);
    assert.equal(response.status, status, `${JSON.stringify(changes)}: ${response.text}`);
    if (code) assert.equal((response.json as { code: string }).code, code);
  };
  // A read-and-suggest connection of the same agent and project has no action scope, so it has no grants.
  const readOnly = expect(await f.owner.request('POST', '/api/v1/agent-connections', { body: { agentId: f.agentId, selectedProjectIds: [f.projectId],
    scopes: ['flux.context.read', 'flux.proposal.write'] } }), 201);
  await refused(String(readOnly.id), {}, 404, 'CONNECTION_NOT_FOUND');
  // A project the owner manages and the agent contributes to, but that this connection did not select.
  const other = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`, { body: { name: 'Unselected project', visibility: 'restricted' } }), 201);
  expect(await f.owner.request('POST', `/api/v1/projects/${other.id}/grants`, { body: { principal: { kind: 'agent', id: f.agentId }, role: 'contributor' } }), 201);
  await refused(f.connectionId, { projectId: other.id }, 404, 'CONNECTION_NOT_FOUND');
  // Classes an operation does not have, and operations that do not exist.
  await refused(f.connectionId, { peerRequestClass: 'review' }, 400);
  await refused(f.connectionId, { operation: 'result.record', peerRequestClass: 'plan' }, 400);
  await refused(f.connectionId, { operation: 'decision.accept' }, 400);
  // Ends: in the past, or beyond the 30-day limit.
  await refused(f.connectionId, { expiresAt: new Date(Date.now() - 60_000).toISOString() }, 400, 'GRANT_EXPIRY_INVALID');
  await refused(f.connectionId, { expiresAt: later(31 * DAY) }, 400, 'GRANT_EXPIRY_INVALID');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_standing_grants WHERE connection_id = ANY($1)', [[f.connectionId, readOnly.id]])).rows[0].n, 0);

  // Inside the ceiling the same grant is accepted, and it covers only its own operation.
  const grant = expect(await create(f.connectionId, {}), 201);
  const update = await f.tool('flux_update_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: grant.id, clientCommandId: randomUUID(),
    peerRequestClass: 'execute', sources: [], workId: f.prerequisiteId, expectedVersion: 1, changes: { title: 'Not covered' } });
  assert.equal(toolFailure(update).code, 'AGENT_EXECUTION_UNAVAILABLE');
});
