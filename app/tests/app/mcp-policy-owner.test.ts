import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentMcpPolicyPath, type AgentConnection, type AgentMcpPolicy, type SaveAgentMcpPolicy } from '@flux/contracts';
import { pool } from './support/db.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, person, project, secondSession, workspace } from './support/people.js';

// Actual owner sessions and API/SQL. This verifies owner management only; the
// MCP dispatcher, relay and action/revocation races require their own integration.
const off: SaveAgentMcpPolicy = { enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] };

async function fixture() {
  const owner = await person('Switch owner');
  const ws = await workspace(owner, 'MCP permissions');
  const place = await project(owner, ws.id, 'Original selected project', 'restricted');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Own local client', owner: 'self' } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connection = expectStatus(await owner.browser.request('POST', '/api/v1/agent-connections',
    { body: { agentId: agent.id, selectedProjectIds: [place.id], scopes: ['flux.context.read'] } }), 201) as AgentConnection;
  const path = agentMcpPolicyPath(connection.id);
  const get = async (browser = owner.browser) => {
    const response = await browser.request('GET', path);
    const result = expectStatus(response, 200) as { connection: AgentConnection; policy: AgentMcpPolicy };
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), `"mcp-policy-${result.policy.version}"`);
    return result;
  };
  const save = (input: SaveAgentMcpPolicy, version: number, browser = owner.browser) => browser.request('PATCH', path,
    { body: input, headers: { 'if-match': `"mcp-policy-${version}"` } });
  return { owner, ws, place, agent, connection, path, get, save };
}

test('ordinary owner can save all Off and empty projects, read them back, and restore original reads without changing consent', async () => {
  const f = await fixture(); const original = await f.get();
  assert.equal(original.policy.version, 1);
  assert.ok(original.policy.enabledEntryIds.includes('tool:flux_get_doc'));
  const saved = expectStatus(await f.save(off, 1), 200) as { policy: AgentMcpPolicy };
  assert.deepEqual(saved.policy, { connectionId: f.connection.id, version: 2, ...off });
  assert.deepEqual((await f.get()).policy, saved.policy, 'all Off remains manageable');
  const originalInput: SaveAgentMcpPolicy = { enabledCapabilityIds: original.policy.enabledCapabilityIds,
    enabledEntryIds: original.policy.enabledEntryIds, selectedProjectIds: original.policy.selectedProjectIds };
  const restored = expectStatus(await f.save(originalInput, 2), 200) as { policy: AgentMcpPolicy };
  assert.deepEqual(restored.policy, { ...original.policy, version: 3 });
  assert.deepEqual((await f.get()).connection, original.connection, 'original scope/project consent is immutable');
  const row = (await pool.query('SELECT version, enabled_capability_ids, enabled_entry_ids FROM agent_connection_mcp_policies WHERE connection_id=$1', [f.connection.id])).rows[0];
  assert.equal(row.version, 3);
  assert.deepEqual(row.enabled_capability_ids, restored.policy.enabledCapabilityIds);
  assert.deepEqual(row.enabled_entry_ids, restored.policy.enabledEntryIds);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_standing_grants WHERE connection_id=$1', [f.connection.id])).rows[0].n, 0,
    'saving switches never creates standing authority');
});

test('another owner or workspace administrator cannot manage this personal policy and signed-out access is refused', async () => {
  const f = await fixture(); const other = await person('Other administrator');
  await addMember(f.owner, f.ws.id, other, 'admin');
  const before = await f.get();
  expectStatus(await other.browser.request('GET', f.path), 404);
  expectStatus(await f.save(off, before.policy.version, other.browser), 404);
  expectStatus(await new Browser().request('GET', f.path), 401);
  expectStatus(await f.save(off, before.policy.version, new Browser()), 401);
  assert.deepEqual(await f.get(), before, 'refused identities leave the saved policy unchanged');
});

test('unknown fields, entries and original-consent expansion refuse without advancing the saved version', async () => {
  const f = await fixture(); const before = await f.get();
  for (const [input, status] of [
    [{ ...off, enabledEntryIds: ['tool:unknown_alias'] }, 400],
    [{ ...off, enabledEntryIds: ['tool:flux_get_doc', 'tool:flux_get_doc'] }, 400],
    [{ ...off, selectedProjectIds: [randomUUID()] }, 403],
    [{ ...off, enabledCapabilityIds: ['work.create'], enabledEntryIds: ['tool:flux_create_task'], selectedProjectIds: [f.place.id] }, 403],
    [{ ...off, ownerUserId: f.owner.id }, 400],
  ] as const) {
    expectStatus(await f.owner.browser.request('PATCH', f.path, { body: input, headers: { 'if-match': '"mcp-policy-1"' } }), status);
    assert.deepEqual(await f.get(), before, 'failed save does not become displayed or persisted state');
  }
  expectStatus(await f.owner.browser.request('PATCH', f.path, { body: off }), 428);
  assert.deepEqual(await f.get(), before);
});

test('two genuine owner sessions saving the same revision have one winner and a stale-save refusal', async () => {
  const f = await fixture(); const second = await secondSession(f.owner);
  const before = await f.get();
  assert.deepEqual(await f.get(second.browser), before);
  const readOnly: SaveAgentMcpPolicy = { enabledCapabilityIds: ['project.knowledge.read'],
    enabledEntryIds: ['tool:flux_get_doc'], selectedProjectIds: [f.place.id] };
  const results = await Promise.all([f.save(off, 1), f.save(readOnly, 1, second.browser)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.find((result) => result.status === 200)!;
  const saved = expectStatus(winner, 200) as { policy: AgentMcpPolicy };
  assert.equal(saved.policy.version, 2);
  assert.deepEqual((await f.get()).policy, saved.policy);
  expectStatus(await f.save(off, 1), 409);
  assert.deepEqual((await f.get()).policy, saved.policy, 'stale tabs cannot overwrite the winner');
});
