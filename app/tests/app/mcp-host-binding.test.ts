import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentMcpPolicyPath, type AgentMcpPolicy } from '@flux/contracts';
import { pool } from './support/db.js';
import { actionScene, agentConnection } from './support/mcp-actions.js';
import { expect, mcp, toolValue } from './support/mcp.js';

test('host binding narrows the bearer before discovery, reads, bootstrap and committed receipt replay', async () => {
  const f = await actionScene(pool);
  const other = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`,
    { body: { name: 'Other selected project', visibility: 'restricted' } }), 201);
  const otherGrant = expect(await f.owner.request('POST', `/api/v1/projects/${other.id}/grants`,
    { body: { principal: { kind: 'agent', id: f.agentId }, role: 'contributor' } }), 201);
  const connection = await agentConnection(pool, f.owner, f.agentId, [f.projectId, String(other.id)]);
  const query = (connectionId: string, projectId: string) => new URLSearchParams({ flux_connection: connectionId, flux_project: projectId }).toString();
  const call = (q: string, method: string, params: Record<string, unknown> = {}) => mcp(connection.accessToken, 1, method, params, { query: q });
  const own = query(connection.connectionId, f.projectId), another = query(connection.connectionId, String(other.id));
  for (const q of [query(randomUUID(), f.projectId), query(connection.connectionId, randomUUID()),
    `flux_connection=${connection.connectionId}`, `${own}&flux_project=${f.projectId}`]) {
    for (const method of ['resources/list', 'tools/list']) assert.equal((await call(q, method)).status, 403);
  }
  const listed = await call(own, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
  assert.deepEqual((toolValue(listed.message).projects as { id: string }[]).map(row => row.id), [f.projectId]);
  const invalidBootstrap = await call(own, 'tools/call', { name: 'flux_bootstrap', arguments: { projectId: other.id, clientSessionId: randomUUID() } });
  assert.equal((invalidBootstrap.message?.result as { isError?: boolean })?.isError, true);
  const grant = await connection.grant('work.create', 'plan', 1);
  const command = { projectId: f.projectId, runtimeSessionId: connection.runtimeSessionId, grantId: grant.id,
    clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [f.source], task: { title: 'Bound task', criteria: ['Compare both runs'],
      dependencyIds: [], planIntent: { ...f.source, intentKey: 'host-bound' } } };
  const created = toolValue((await call(own, 'tools/call', { name: 'flux_create_task', arguments: command })).message);
  const refusedReplay = await call(another, 'tools/call', { name: 'flux_create_task', arguments: command });
  assert.equal((refusedReplay.message?.result as { isError?: boolean })?.isError, true);
  assert.equal(toolValue((await call(own, 'tools/call', { name: 'flux_create_task', arguments: command })).message).workId, created.workId);
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grant.id])).rows[0].used, 1);
  const path = agentMcpPolicyPath(connection.connectionId);
  const policy = (expect(await f.owner.request('GET', path), 200) as { policy: AgentMcpPolicy }).policy;
  expect(await f.owner.request('PATCH', path, { body: { enabledCapabilityIds: policy.enabledCapabilityIds,
    enabledEntryIds: policy.enabledEntryIds, selectedProjectIds: [String(other.id)] }, headers: { 'if-match': `"mcp-policy-${policy.version}"` } }), 200);
  assert.equal((await call(own, 'resources/list')).status, 403, 'changed selection also ends discovery on Resume');
  // Re-granting a selection cannot substitute for the project ACL: revoked access refuses even resource bytes.
  expect(await f.owner.request('DELETE', `/api/v1/projects/${other.id}/grants/${otherGrant.id}`), 204);
  assert.equal((await call(another, 'resources/list')).status, 403);
});
