import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AgentOperation } from '@flux/contracts';
import { publicOrigin, register, uniqueEmail, type Browser } from './http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue } from './mcp.js';

// One owner, one restricted project with a contributor agent, an action-scoped OAuth connection and its
// bootstrap runtime: the shared starting point of the native MCP action tests (#152).

export const actionScope = 'flux.context.read flux.proposal.write flux.action.execute offline_access';
const actionScopes = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];

/** A failed tool result carries only the domain code and message. */
export function toolFailure(message: Record<string, unknown> | null) {
  const result = message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  assert.equal(result?.isError, true, `expected a tool error: ${JSON.stringify(message)}`);
  return JSON.parse(result!.content![0]!.text ?? '') as { code: string; error: string };
}

/**
 * One named connection of `owner` for an existing agent, authorized through the real OAuth consent of a fresh
 * client, with its own standing-grant helper, MCP tool caller and bootstrap runtime.
 */
export async function agentConnection(pool: Pool, owner: Browser, agentId: string, projectIds: string[], scopes: string[] = actionScopes) {
  const projectId = projectIds[0]!;
  const connection = expect(await owner.request('POST', '/api/v1/agent-connections', { body: { agentId,
    selectedProjectIds: projectIds, scopes } }), 201);
  const connectionId = String(connection.id);
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], [...actionScopes, 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const tokens = await oauthToken(owner, connectionId, clientId, redirectUri,
    await beginOauth(owner, clientId, redirectUri, { prompt: 'consent', scope: [...scopes, 'offline_access'].join(' ') }));
  const grant = async (operation: AgentOperation, peerRequestClass: 'execute' | 'plan', maximumUses = 5, objectId?: string, project = projectId) =>
    expect(await owner.request('POST', `/api/v1/agent-connections/${connectionId}/action-grants`, { body: {
      clientCommandId: randomUUID(), projectId: project, operation, peerRequestClass, maximumUses, ...(objectId ? { objectId } : {}),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as { id: string; used: number };
  let call = 100;
  /** The raw MCP exchange, for checks of the HTTP status itself (a revoked connection is refused before any tool). */
  const raw = (name: string, args: Record<string, unknown>) => mcp(tokens.access_token, call++, 'tools/call', { name, arguments: args });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await raw(name, args);
    assert.equal(response.status, 200, `MCP ${name} returned ${response.status}`);
    return response.message;
  };
  const bootstrap = toolValue(await tool('flux_bootstrap', { projectId, clientSessionId: randomUUID() }));
  const runtimeSessionId = (bootstrap.runtime as { id: string }).id;
  return { connectionId, grant, tool, raw, bootstrap, runtimeSessionId };
}

export async function actionScene(pool: Pool) {
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
  const { connectionId, grant, tool, raw, bootstrap, runtimeSessionId } = await agentConnection(pool, owner, String(agent.id), [projectId]);
  const read = async (workId: string) => expect(await owner.request('GET', `/api/v1/work/${workId}`), 200);
  const used = async (grantId: string) => (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0].used as number;
  const tasks = async () => (await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1', [projectId])).rows[0].n as number;
  return { owner, workspaceId: String(workspace.id), projectId, agentId: String(agent.id), connectionId, source, prerequisiteId: String(prerequisite.id), bootstrap,
    runtimeSessionId, grant, tool, raw, read, used, tasks };
}
