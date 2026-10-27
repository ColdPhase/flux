import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { publicOrigin, register, uniqueEmail } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken } from './support/mcp.js';

// Partial consent (#548): the person may grant fewer permissions than a client asks for.
const ASKED = 'flux.context.read flux.proposal.write flux.action.execute offline_access';

async function scene(scopes: string[], request: { scope: string; prompt?: string } = { scope: ASKED, prompt: 'consent' }) {
  const { browser } = await register(uniqueEmail('partial-consent'), 'correct horse battery staple');
  const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name: 'Partial consent' } }), 201);
  const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
    { body: { name: 'Granted project', visibility: 'restricted' } }), 201);
  const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name: 'Partial agent', owner: 'self' } }), 201);
  expect(await browser.request('POST', `/api/v1/projects/${project.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: scopes.length > 1 ? 'contributor' : 'viewer' } }), 201);
  const connection = expect(await browser.request('POST', '/api/v1/agent-connections',
    { body: { name: 'Desk', clientDesignation: 'codex', agentId: agent.id, selectedProjectIds: [project.id], scopes } }), 201);
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
    response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ASKED.split(' ')]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const tokens = await oauthToken(browser, String(connection.id), clientId, redirectUri, await beginOauth(browser, clientId, redirectUri, request));
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { scope: string };
  const names = async () => (((await mcp(tokens.access_token, 1, 'tools/list')).message?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
  const tasks = async () => Number((await pool.query('SELECT count(*) FROM project_work_items WHERE project_id=$1', [project.id])).rows[0].count);
  return { browser, projectId: String(project.id), bearer: tokens.access_token, scope: claims.scope.split(' ').sort(), names, tasks };
}

test('a read-only grant is accepted: the token carries exactly it, tools/list shows only reads, and writes are refused naming the permission', async () => {
  const f = await scene(['flux.context.read']);
  assert.deepEqual(f.scope, ['flux.context.read', 'offline_access']);
  const names = await f.names();
  assert.ok(names.includes('flux_list_contexts'));
  assert.ok(!names.includes('flux_create_task') && !names.includes('flux_create_proposal') && !names.includes('flux_create_doc'));
  const before = await f.tasks();
  const refused = await mcp(f.bearer, 2, 'tools/call', { name: 'flux_create_task', arguments: { projectId: f.projectId,
    runtimeSessionId: randomUUID(), grantId: randomUUID(), clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [], task: { title: 'Not granted' } } });
  const result = refused.message?.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as { code: string; error: string };
  assert.equal(body.code, 'MCP_SCOPE_REQUIRED');
  assert.match(body.error, /can't use flux_create_task: permission 'flux\.action\.execute' \(run approved actions\) wasn't granted/);
  const proposal = await mcp(f.bearer, 3, 'tools/call', { name: 'flux_create_proposal', arguments: { projectId: f.projectId,
    materialId: randomUUID(), version: 1, clientCommandId: randomUUID(), fact: 'f', interpretation: 'i', suggestedAction: 's' } });
  assert.match(JSON.stringify(proposal.message), /flux\.proposal\.write/);
  assert.equal(await f.tasks(), before, 'nothing was written');
  const read = await mcp(f.bearer, 4, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
  assert.notEqual((read.message?.result as { isError?: boolean }).isError, true, 'reads still work');
});

test('a full grant is unchanged: all three permissions and every tool are available', async () => {
  const f = await scene(['flux.context.read', 'flux.proposal.write', 'flux.action.execute']);
  assert.deepEqual(f.scope, ['flux.action.execute', 'flux.context.read', 'flux.proposal.write', 'offline_access']);
  const names = await f.names();
  for (const name of ['flux_list_contexts', 'flux_create_proposal', 'flux_create_task', 'flux_create_doc']) assert.ok(names.includes(name), name);
});

// #660: Codex sends no prompt=consent, so the provider checks the scopes at /oauth2/continue, before the consent page.
test('a client that sends no prompt=consent and asks for all three still reaches consent and gets only what the connection holds', async () => {
  const f = await scene(['flux.context.read', 'flux.proposal.write'], { scope: ASKED });
  assert.deepEqual(f.scope, ['flux.context.read', 'flux.proposal.write', 'offline_access']);
  const names = await f.names();
  assert.ok(names.includes('flux_create_proposal') && !names.includes('flux_create_task'));
});

test('a client that asks for fewer permissions than the connection holds gets only those it asked for', async () => {
  const f = await scene(['flux.context.read', 'flux.proposal.write', 'flux.action.execute'], { scope: 'flux.context.read offline_access' });
  assert.deepEqual(f.scope, ['flux.context.read', 'offline_access']);
});
