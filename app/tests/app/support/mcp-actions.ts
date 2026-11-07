import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assistantChangeActionPath, type AgentOperation, type ExternalClientDesignation } from '@flux/contracts';
import { publicOrigin, register, uniqueEmail, type Browser } from './http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue } from './mcp.js';

// One owner, one restricted project with a contributor agent, an action-scoped OAuth connection and its
// bootstrap runtime: the shared starting point of the native MCP action tests (#152).
//
// Standing grants are gone (#859): a client acts with its owner's rights. `grant` returns a stub id, and the tool helpers drop
// the fields a tool no longer takes, so a test names only what the tool reads.

const actionScopes = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];

/** A failed tool result carries only the domain code and message. */
export function toolFailure(message: Record<string, unknown> | null) {
  const result = message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  assert.equal(result?.isError, true, `expected a tool error: ${JSON.stringify(message)}`);
  return JSON.parse(result!.content![0]!.text ?? '') as { code: string; error: string };
}

/**
 * A unit, a transfer or a request for another person's client waits for its sender's owner (C-18, #859): the call answers in plain
 * words. This is that owner's Approve, in their own signed-in session, of the one such change waiting for `connectionId`; it returns
 * what the approved call produced (the unit or request), as the call would have answered had it not waited.
 */
export async function approveWaiting(pool: Pool, owner: Browser, connectionId: string, operation: AgentOperation): Promise<Record<string, unknown>> {
  const id = await waitingId(pool, connectionId, operation);
  expect(await owner.request('POST', assistantChangeActionPath(id, 'apply'), { body: {} }), 200);
  const [done] = (await pool.query(`SELECT state, receipt FROM assistant_changes WHERE id = $1`, [id])).rows as { state: string; receipt: { value: Record<string, unknown> } }[];
  assert.equal(done!.state, 'applied_after_wait');
  return done!.receipt.value;
}

async function waitingId(pool: Pool, connectionId: string, operation: AgentOperation): Promise<string> {
  const waiting = (await pool.query(`SELECT id FROM assistant_changes WHERE connection_id = $1 AND operation = $2 AND state = 'waiting' ORDER BY created_at DESC`,
    [connectionId, operation])).rows as { id: string }[];
  assert.equal(waiting.length, 1, `one ${operation} waits for its owner`);
  return waiting[0]!.id;
}

/**
 * The owner's Approve of a waiting change that can no longer be made (its target changed, its claim ended): the answer is the plain
 * words why (403), the change closes as refused, and nothing is made. Returns those words.
 */
export async function approveRefused(pool: Pool, owner: Browser, connectionId: string, operation: AgentOperation): Promise<string> {
  const id = await waitingId(pool, connectionId, operation);
  const answer = expect(await owner.request('POST', assistantChangeActionPath(id, 'apply'), { body: {} }), 403) as { error?: string };
  const [row] = (await pool.query(`SELECT state FROM assistant_changes WHERE id = $1`, [id])).rows as { state: string }[];
  assert.equal(row!.state, 'refused', 'the change is closed, not left waiting');
  assert.ok(answer.error, 'the owner is told why');
  return String(answer.error);
}

/** Whether a tool answered that the change waits for its owner. */
export function waits(message: Record<string, unknown> | null): boolean {
  return /Waiting for .+'s OK/.test(JSON.stringify(message?.result ?? null));
}

/** The tools that still name the runtime session of bootstrap (their receipts are bound to it), and those that name a unit's role. */
const NAMES_RUNTIME = /^flux_(?:create_unit|claim_unit|renew_unit|release_unit|complete_unit|transfer_unit|decline_unit|claim_request|decline_request|resolve_request|defer_request|send_request|post_agent_thread|ask_question|link_pull_request|undo_task_creation)$/;
const NAMES_ROLE = /^flux_(?:create_unit|claim_unit|renew_unit|release_unit|complete_unit|transfer_unit|decline_unit|claim_request|decline_request|resolve_request|defer_request|send_request)$/;
export function withoutGrant(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const { grantId: _grant, runtimeSessionId, peerRequestClass, ...rest } = args;
  void _grant;
  return { ...rest, ...(NAMES_RUNTIME.test(name) && runtimeSessionId !== undefined ? { runtimeSessionId } : {}),
    ...(NAMES_ROLE.test(name) && peerRequestClass !== undefined ? { peerRequestClass } : {}) };
}

/**
 * One named connection of `owner` for an existing agent, authorized through the real OAuth consent of a fresh
 * client, with its own standing-grant helper, MCP tool caller and bootstrap runtime.
 */
export async function agentConnection(pool: Pool, owner: Browser, agentId: string, projectIds: string[], scopes: string[] = actionScopes, clientDesignation: ExternalClientDesignation = 'other') {
  const projectId = projectIds[0]!;
  const connection = expect(await owner.request('POST', '/api/v1/agent-connections', { body: { agentId,
    selectedProjectIds: projectIds, scopes, clientDesignation } }), 201);
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
  // No standing grants (#859): a stub id for tests that still name one; the tool helpers below drop it.
  const grant = async (...named: [operation?: AgentOperation, peerRequestClass?: string, maximumUses?: number, objectId?: string, project?: string]) => {
    void named;
    return { id: randomUUID(), used: 0 };
  };
  let call = 100;
  /** The raw MCP exchange, for checks of the HTTP status itself (a revoked connection is refused before any tool). */
  const raw = (name: string, args: Record<string, unknown>) => mcp(tokens.access_token, call++, 'tools/call', { name, arguments: withoutGrant(name, args) });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await raw(name, args);
    assert.equal(response.status, 200, `MCP ${name} returned ${response.status}`);
    return response.message;
  };
  /** The names of the tools the server actually registers for this bearer (`tools/list`). */
  const toolNames = async () => {
    const response = await mcp(tokens.access_token, call++, 'tools/list');
    assert.equal(response.status, 200, `MCP tools/list returned ${response.status}`);
    return (response.message?.result as { tools: { name: string }[] }).tools.map((item) => item.name);
  };
  const bootstrap = toolValue(await tool('flux_bootstrap', { projectId, clientSessionId: randomUUID() }));
  const runtimeSessionId = (bootstrap.runtime as { id: string }).id;
  return { connectionId, grant, tool, raw, toolNames, bootstrap, runtimeSessionId, tokens, accessToken: tokens.access_token };
}

export async function actionScene(pool: Pool) {
  const { browser: owner } = await register(uniqueEmail('mcp-task-owner'), 'correct horse battery staple');
  const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'MCP task actions' } }), 201);
  const project = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
    { body: { name: 'Planned project', visibility: 'restricted' } }), 201);
  const projectId = String(project.id);
  const agent = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`,
    { body: { name: 'Planning agent', owner: 'self' } }), 201);
  const plan = expect(await owner.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Release plan', body: 'Step one: measure. Step two: compare.' } }), 201);
  const source = { materialId: String(plan.materialId), version: Number(plan.version) };
  const prerequisite = expect(await owner.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title: 'Measure the baseline' } }), 201);
  const { connectionId, grant, tool, raw, toolNames, bootstrap, runtimeSessionId, tokens } = await agentConnection(pool, owner, String(agent.id), [projectId]);
  const read = async (workId: string) => expect(await owner.request('GET', `/api/v1/work/${workId}`), 200);
  const tasks = async () => (await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1', [projectId])).rows[0].n as number;
  return { owner, workspaceId: String(workspace.id), projectId, agentId: String(agent.id), connectionId, source, prerequisiteId: String(prerequisite.id), bootstrap,
    runtimeSessionId, grant, tool, raw, toolNames, read, tasks, tokens, accessToken: tokens.access_token };
}
