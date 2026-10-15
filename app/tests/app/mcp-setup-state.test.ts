import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentMcpPolicyPath, type AgentConnectionSetupFacts } from '@flux/contracts';
import { pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect } from './support/mcp.js';
import { Browser, register, uniqueEmail } from './support/http.js';

test('owner setup distinguishes saved selection, issued authorization and current session without inferring activation', async () => {
  const f = await actionScene(pool);
  const read = async (id = f.connectionId, browser = f.owner) => {
    const response = await browser.request('GET', agentMcpPolicyPath(id));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return expect(response, 200).setup as unknown as AgentConnectionSetupFacts;
  };
  const saved = expect(await f.owner.request('POST', '/api/v1/agent-connections', { body: {
    agentId: f.agentId, selectedProjectIds: [f.projectId], scopes: ['flux.context.read'], name: 'Unverified Codex', clientDesignation: 'codex',
  } }), 201);
  assert.deepEqual(await read(String(saved.id)), { authorizationRecorded: false, session: null, activation: 'pending' },
    'an owner-reported client label and saved selection certify no native path');
  const actual = await read();
  assert.equal(actual.authorizationRecorded, true);
  assert.ok(actual.session);
  assert.equal(actual.activation, 'pending', 'real OAuth and bootstrap still cannot establish integrated Start/Resume');
  assert.deepEqual(Object.keys(actual).sort(), ['activation', 'authorizationRecorded', 'session'], 'no token/client secret or native identity is projected');
  const runtime = (await pool.query('SELECT binding_id FROM agent_runtime_sessions WHERE id=$1', [f.runtimeSessionId])).rows[0];
  const binding = (await pool.query('SELECT client_id FROM agent_oauth_bindings WHERE id=$1', [runtime.binding_id])).rows[0];
  await pool.query('UPDATE oauth_client SET disabled=true WHERE client_id=$1', [binding.client_id]);
  assert.deepEqual(await read(), { authorizationRecorded: false, session: null, activation: 'pending' }, 'a disabled native client cannot retain a current authorization display');
  await pool.query('UPDATE oauth_client SET disabled=false WHERE client_id=$1', [binding.client_id]);
  assert.deepEqual(await read(), actual);
  await pool.query('UPDATE agent_oauth_bindings SET generation=generation+1 WHERE id=$1', [runtime.binding_id]);
  assert.deepEqual(await read(), { authorizationRecorded: true, session: null, activation: 'pending' }, 'an older runtime generation is not a current session');
  await pool.query('UPDATE oauth_access_token SET revoked=now() WHERE reference_id=$1', [`flux-grant:${runtime.binding_id}`]);
  await pool.query('UPDATE oauth_refresh_token SET revoked=now() WHERE reference_id=$1', [`flux-grant:${runtime.binding_id}`]);
  assert.deepEqual(await read(), { authorizationRecorded: false, session: null, activation: 'pending' }, 'expired or revoked authorization is not resurrected from a runtime record');
});

test('setup facts remain owner private; Off and revoke preserve history without creating consent or action grants', async () => {
  const f = await actionScene(pool);
  const path = agentMcpPolicyPath(f.connectionId);
  const before = expect(await f.owner.request('GET', path), 200);
  const { browser: other } = await register(uniqueEmail('setup-other'), 'correct horse battery staple');
  expect(await other.request('GET', path), 404);
  expect(await new Browser().request('GET', path), 401);
  expect(await f.owner.request('GET', agentMcpPolicyPath(randomUUID())), 404);
  const off = { enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] };
  expect(await f.owner.request('PATCH', path, { body: off, headers: { 'if-match': '"mcp-policy-1"' } }), 200);
  const after = expect(await f.owner.request('GET', path), 200);
  assert.deepEqual(after.setup, before.setup, 'Off preserves factual history, not a ready state or restored authority');
  assert.deepEqual((after.policy as { selectedProjectIds: string[] }).selectedProjectIds, []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_standing_grants WHERE connection_id=$1', [f.connectionId])).rows[0].n, 0);
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}`), 204);
  expect(await f.owner.request('GET', path), 404);
  const history = expect(await f.owner.request('GET', '/api/v1/agent-connections'), 200) as unknown as { id: string; revokedAt: string | null }[];
  assert.ok(history.find((row) => row.id === f.connectionId)?.revokedAt, 'revoked connection remains in the owner history');
  assert.equal((await f.raw('flux_list_contexts', {})).status, 403);
});
