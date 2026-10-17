import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentMcpPolicyPath, type AgentMcpPolicy, type SaveAgentMcpPolicy } from '@flux/contracts';
import { pool } from './support/db.js';
import { publicOrigin, register, uniqueEmail } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue } from './support/mcp.js';

// Switches narrow, never widen (#316 AC-2 with #548): owner rights ∩ agent grant ∩ connection scopes ∩ the token's
// partial consent ∩ the saved switches. A read-only token on a connection that also holds write scopes stays
// read-only whatever the switches say, and a switch Off removes even what the token carries.
const ALL = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];

async function scene() {
  const { browser: owner } = await register(uniqueEmail('switch-partial'), 'correct horse battery staple');
  const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Switch partial' } }), 201);
  const project = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: 'P', visibility: 'restricted' } }), 201);
  const agent = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name: 'Agent', owner: 'self' } }), 201);
  expect(await owner.request('POST', `/api/v1/projects/${project.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const doc = expect(await owner.request('POST', `/api/v1/projects/${project.id}/docs`, { body: { title: 'Switch doc', body: 'Switch-secret-5521' } }), 201);
  const connection = expect(await owner.request('POST', '/api/v1/agent-connections',
    { body: { agentId: agent.id, selectedProjectIds: [project.id], scopes: ALL } }), 201);
  const connectionId = String(connection.id);
  const clientId = `flux-test-${randomUUID()}`; const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
    response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], [...ALL, 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const token = (await oauthToken(owner, connectionId, clientId, redirectUri,
    await beginOauth(owner, clientId, redirectUri, { scope: 'flux.context.read offline_access' }))).access_token;
  const path = agentMcpPolicyPath(connectionId);
  const get = async () => (expect(await owner.request('GET', path), 200) as { policy: AgentMcpPolicy }).policy;
  const save = async (input: SaveAgentMcpPolicy) => expect(await owner.request('PATCH', path,
    { body: input, headers: { 'if-match': `"mcp-policy-${(await get()).version}"` } }), 200);
  const input = (policy: AgentMcpPolicy): SaveAgentMcpPolicy => ({ enabledCapabilityIds: [...policy.enabledCapabilityIds],
    enabledEntryIds: [...policy.enabledEntryIds], selectedProjectIds: [...policy.selectedProjectIds] });
  let id = 10;
  const tool = (name: string, args: Record<string, unknown> = {}) => mcp(token, id++, 'tools/call', { name, arguments: args });
  const names = async () => ((((await mcp(token, id++, 'tools/list')).message?.result) as { tools: { name: string }[] }).tools).map((t) => t.name);
  const tasks = async () => Number((await pool.query('SELECT count(*) FROM project_work_items WHERE project_id=$1', [project.id])).rows[0].count);
  return { projectId: String(project.id), doc, get, save, input, tool, names, tasks };
}

test('saving every switch On never widens a read-only token, and Off removes what that token carries', async () => {
  const f = await scene();
  const initial = await f.get();
  const read = { projectId: f.projectId, id: f.doc.id };
  assert.equal(toolValue((await f.tool('flux_get_doc', read)).message).title, 'Switch doc');
  assert.ok(!(await f.names()).includes('flux_create_task'), 'the token never carried the action permission');

  // Re-saving the full policy (every switch On) does not add the permissions the token lacks.
  await f.save(f.input(initial));
  assert.ok(!(await f.names()).includes('flux_create_task'));
  const before = await f.tasks();
  const refused = (await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: randomUUID(), grantId: randomUUID(),
    clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [], task: { title: 'Not granted' } })).message?.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(refused.isError, true);
  assert.equal((JSON.parse(refused.content[0]!.text) as { code: string }).code, 'MCP_SCOPE_REQUIRED');
  assert.equal(await f.tasks(), before);

  // Knowledge Off removes the one permission the token does carry, on the same bearer.
  await f.save({ ...f.input(initial), enabledCapabilityIds: initial.enabledCapabilityIds.filter((id) => id !== 'project.knowledge.read') });
  const off = await f.tool('flux_get_doc', read);
  assert.ok(!JSON.stringify(off.message).includes('Switch-secret-5521') && !JSON.stringify(off.message).includes('Switch doc'));
  assert.equal(toolValue((await f.tool('flux_list_contexts')).message) !== undefined, true, 'unrelated reads stay on');

  // On again restores only the read the token carries.
  await f.save(f.input(initial));
  assert.equal(toolValue((await f.tool('flux_get_doc', read)).message).title, 'Switch doc');
  assert.ok(!(await f.names()).includes('flux_create_task'));
});
