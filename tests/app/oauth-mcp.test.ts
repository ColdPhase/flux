import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { apiUrl, publicOrigin, register, uniqueEmail, type Browser, type ClientResponse } from './support/http.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

function expect(response: ClientResponse, status: number) {
  assert.equal(response.status, status, `${response.status} from application endpoint`);
  return response.json as Record<string, unknown>;
}

function route(location: string) {
  const parsed = new URL(location, publicOrigin);
  return `${parsed.pathname}${parsed.search}`;
}

interface Tokens { access_token: string; refresh_token: string; token_type: string }

async function beginOauth(browser: Browser, clientId: string, redirectUri: string, extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL('/api/auth/oauth2/authorize', publicOrigin);
  authorize.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: randomUUID(),
    scope: 'flux.context.read flux.proposal.write offline_access', resource: `${publicOrigin}/mcp`, ...extra,
  }).toString();
  const start = await browser.request('GET', route(authorize.toString()),
    { headers: { accept: 'text/html' } });
  assert.ok(start.status === 200 || start.status === 302, `OAuth authorize returned ${start.status}`);
  const redirect = start.status === 302 ? start.headers.get('location')
    : (start.json as { url?: string } | null)?.url;
  const choice = new URL(redirect ?? '', publicOrigin);
  assert.equal(choice.pathname, '/connect-agent');
  return { verifier, oauthQuery: choice.search.slice(1) };
}

async function oauthToken(browser: Browser, connectionId: string, clientId: string, redirectUri: string,
  started?: Awaited<ReturnType<typeof beginOauth>>): Promise<Tokens> {
  const { verifier, oauthQuery: selectedQuery } = started ?? await beginOauth(browser, clientId, redirectUri);
  expect(await browser.request('POST', `/api/v1/agent-connections/${connectionId}/select-for-oauth`,
    { body: { oauth_query: selectedQuery } }), 204);
  const continued = expect(await browser.request('POST', '/api/auth/oauth2/continue',
    { body: { postLogin: true, oauth_query: selectedQuery } }), 200);
  const destination = new URL(String(continued.url ?? continued.redirect_uri), publicOrigin);
  let callback = destination;
  if (destination.pathname === '/consent') {
    const oauthQuery = destination.search.slice(1);
    const display = expect(await browser.request('GET',
      `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(oauthQuery)}`), 200);
    assert.equal(display.clientName, 'Flux HTTP test client');
    assert.equal((display.connection as { id: string }).id, connectionId);
    const consent = expect(await browser.request('POST', '/api/auth/oauth2/consent',
      { body: { accept: true, oauth_query: oauthQuery } }), 200);
    callback = new URL(String(consent.url ?? consent.redirect_uri));
  }
  assert.equal(callback.origin, new URL(redirectUri).origin);
  const code = callback.searchParams.get('code');
  assert.ok(code, 'consent returned an authorization code');
  const token = await fetch(new URL('/api/auth/oauth2/token', apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  });
  assert.equal(token.status, 200, `OAuth token endpoint returned ${token.status}`);
  const payload = await token.json() as Tokens;
  assert.equal(payload.token_type?.toLowerCase(), 'bearer');
  assert.ok(payload.access_token, 'OAuth access token was issued');
  assert.ok(payload.refresh_token, 'OAuth refresh token was issued');
  return payload;
}

async function mcp(accessToken: string, id: number, method: string, params: Record<string, unknown> = {}) {
  const toolName = typeof params.name === 'string' ? params.name : null;
  const response = await fetch(new URL('/mcp', apiUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      accept: 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(toolName ? { 'mcp-name': toolName } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'flux-http-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
  });
  const body = await response.text();
  let message: Record<string, unknown> | null = null;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = body.split('\n').find((line) => line.startsWith('data: '));
    if (data) message = JSON.parse(data.slice(6)) as Record<string, unknown>;
  } else if (body) {
    message = JSON.parse(body) as Record<string, unknown>;
  }
  return { status: response.status, message };
}

function toolValue(message: Record<string, unknown> | null) {
  assert.ok(message && !message.error, 'MCP returned a tool result');
  const result = message.result as { isError?: boolean; content?: { type: string; text?: string }[] };
  assert.equal(result?.isError, undefined);
  assert.equal(result?.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text ?? '') as Record<string, unknown>;
}

test('issued OAuth bearer reads and proposes through MCP, then connection revocation rejects it immediately', async () => {
  const { browser } = await register(uniqueEmail('oauth-mcp'), 'correct horse battery staple');
  const workspace = expect(await browser.request('POST', '/api/v1/workspaces',
    { body: { name: 'OAuth MCP verification' } }), 201);
  const workspaceId = String(workspace.id);
  const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`,
    { body: { name: 'Selected restricted project', visibility: 'restricted' } }), 201);
  const projectId = String(project.id);
  const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`,
    { body: { name: 'Test local agent', owner: 'self' } }), 201);
  const agentId = String(agent.id);
  expect(await browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  const material = expect(await browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Battery observation', body: 'Battery lasts four hours.' } }), 201);
  const materialId = String(material.materialId);
  const secondMaterial = expect(await browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Capacity observation', body: 'Capacity is limited.' } }), 201);
  const doc = expect(await browser.request('POST', `/api/v1/projects/${projectId}/docs`,
    { body: { title: 'Experiment notes', body: 'A project doc source.' } }), 201);
  const hiddenProject = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`,
    { body: { name: 'Unselected private project', visibility: 'restricted' } }), 201);
  const hiddenProjectId = String(hiddenProject.id);
  const hiddenMaterial = expect(await browser.request('POST', `/api/v1/projects/${hiddenProjectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Secret source title', body: 'Private content.' } }), 201);
  const connection = expect(await browser.request('POST', '/api/v1/agent-connections',
    { body: { agentId, selectedProjectIds: [projectId], scopes: ['flux.context.read', 'flux.proposal.write'] } }), 201);
  const connectionId = String(connection.id);

  // A local OAuth client fixture exercises the provider's real authorization-code
  // and PKCE endpoints without fetching external client metadata in Docker CI.
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, true, now(), now())`,
  [randomUUID(), clientId, 'Flux HTTP test client', [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
    ['flux.context.read', 'flux.proposal.write', 'offline_access']]);
  await pool.query(`INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
    VALUES ($1, $2, $3, now())`, [randomUUID(), clientId, `${publicOrigin}/mcp`]);

  const bearer = (await oauthToken(browser, connectionId, clientId, redirectUri)).access_token;
  const listed = await mcp(bearer, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
  assert.equal(listed.status, 200, `MCP call returned ${listed.status}: ${JSON.stringify(listed.message)}`);
  assert.deepEqual(toolValue(listed.message).projects, [{ id: projectId,
    name: 'Selected restricted project', workspaceId }]);
  const sources = await mcp(bearer, 5, 'tools/call', { name: 'flux_list_materials', arguments: { projectId, limit: 1 } });
  assert.equal(sources.status, 200);
  const firstPage = toolValue(sources.message);
  assert.equal(firstPage.total, 3);
  assert.equal((firstPage.items as unknown[]).length, 1);
  const nextPage = toolValue((await mcp(bearer, 6, 'tools/call', {
    name: 'flux_list_materials', arguments: { projectId, limit: 1, offset: 1 },
  })).message);
  assert.equal(nextPage.total, 3);
  const thirdPage = toolValue((await mcp(bearer, 8, 'tools/call', {
    name: 'flux_list_materials', arguments: { projectId, limit: 1, offset: 2 },
  })).message);
  const items = [...firstPage.items as Record<string, unknown>[],
    ...nextPage.items as Record<string, unknown>[], ...thirdPage.items as Record<string, unknown>[]];
  assert.deepEqual(new Set(items.map((item) => item.materialId)), new Set([materialId, secondMaterial.materialId, doc.id]));
  assert.ok(items.every((item) => item.version === 1 && typeof item.title === 'string'));
  assert.equal(items.find((item) => item.materialId === doc.id)?.kind, 'doc');
  assert.ok(!JSON.stringify(items).includes('Battery lasts four hours.'), 'the picker does not include source bodies');
  const deniedSources = await mcp(bearer, 7, 'tools/call', { name: 'flux_list_materials',
    arguments: { projectId: hiddenProjectId } });
  assert.equal(deniedSources.status, 200);
  assert.equal((deniedSources.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(!JSON.stringify(deniedSources.message).includes('Secret source title'));
  assert.ok(!JSON.stringify(deniedSources.message).includes(String(hiddenMaterial.materialId)));
  const read = await mcp(bearer, 2, 'tools/call', { name: 'flux_read_material', arguments: { projectId, materialId } });
  assert.equal(read.status, 200);
  assert.equal(toolValue(read.message).body, 'Battery lasts four hours.');
  const created = await mcp(bearer, 3, 'tools/call', { name: 'flux_create_proposal', arguments: {
    projectId, materialId, version: 1, clientCommandId: randomUUID(),
    fact: 'Battery lasts four hours', interpretation: 'Runtime may be short',
    suggestedAction: 'Compare another battery',
  } });
  assert.equal(created.status, 200);
  assert.equal(toolValue(created.message).status, 'proposed');

  const grants = expect(await browser.request('GET', `/api/v1/projects/${projectId}/grants`), 200) as unknown as { id: string; principal: { kind: string; id: string } }[];
  const agentGrant = grants.find((grant) => grant.principal.kind === 'agent' && grant.principal.id === agentId);
  assert.ok(agentGrant);
  expect(await browser.request('DELETE', `/api/v1/projects/${projectId}/grants/${agentGrant.id}`), 204);
  const lostGrant = await mcp(bearer, 9, 'tools/call', { name: 'flux_list_materials', arguments: { projectId } });
  assert.equal(lostGrant.status, 403, 'grant loss invalidates the bearer before tool dispatch');
  assert.ok(!JSON.stringify(lostGrant.message).includes('Battery observation'));

  const restoredGrant = expect(await browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  assert.notEqual(restoredGrant.id, agentGrant.id, 'the restored grant is a new authority');
  const restoredSources = await mcp(bearer, 10, 'tools/call', { name: 'flux_list_materials', arguments: { projectId } });
  assert.equal(restoredSources.status, 200, 'the original connection works again after a current grant is restored');
  assert.equal(toolValue(restoredSources.message).total, 3);

  expect(await browser.request('DELETE', `/api/v1/agent-connections/${connectionId}`), 204);
  const revoked = await mcp(bearer, 11, 'tools/call', { name: 'flux_list_materials', arguments: { projectId } });
  assert.equal(revoked.status, 403, 'the same already-issued bearer loses access before expiry');
});


async function refresh(clientId: string, token: string) {
  const response = await fetch(new URL('/api/auth/oauth2/token', apiUrl), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token,
      resource: `${publicOrigin}/mcp` }),
  });
  return { status: response.status, tokens: await response.json() as Tokens };
}

test('three named connections share one actual client; same-session choices, refresh families and revocation remain independent', async () => {
  const owner = (await register(uniqueEmail('connections-owner'), 'correct horse battery staple')).browser;
  const peer = (await register(uniqueEmail('connections-peer'), 'correct horse battery staple')).browser;
  async function connection(browser: Browser, name: string, clientDesignation: 'codex' | 'claude_code') {
    const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name } }), 201);
    const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
      { body: { name: `${name} project`, visibility: 'restricted' } }), 201);
    const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/agents`,
      { body: { name: `${name} agent`, owner: 'self' } }), 201);
    expect(await browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const saved = expect(await browser.request('POST', '/api/v1/agent-connections', { body: {
      name, clientDesignation, agentId: agent.id, selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write'],
    } }), 201);
    assert.equal(saved.name, name); assert.equal(saved.clientDesignation, clientDesignation);
    assert.equal(saved.computeSource, 'user_operated_external_client');
    return { id: String(saved.id), projectId: String(project.id) };
  }
  const [a, b, c] = await Promise.all([connection(owner, 'Hubert research', 'codex'),
    connection(owner, 'Hubert delivery', 'claude_code'), connection(peer, 'Peer research', 'codex')]);
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
    ['flux.context.read', 'flux.proposal.write', 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const [flowA, flowB, flowC] = await Promise.all([beginOauth(owner, clientId, redirectUri, { prompt: 'consent' }),
    beginOauth(owner, clientId, redirectUri), beginOauth(peer, clientId, redirectUri)]);
  const tampered = new URLSearchParams(flowA.oauthQuery); tampered.set('state', randomUUID());
  expect(await owner.request('POST', `/api/v1/agent-connections/${a.id}/select-for-oauth`,
    { body: { oauth_query: tampered.toString() } }), 400);
  expect(await peer.request('POST', `/api/v1/agent-connections/${a.id}/select-for-oauth`,
    { body: { oauth_query: flowC.oauthQuery } }), 404);
  expect(await owner.request('POST', `/api/v1/agent-connections/${a.id}/select-for-oauth`,
    { body: { oauth_query: flowA.oauthQuery } }), 204);
  expect(await owner.request('POST', `/api/v1/agent-connections/${b.id}/select-for-oauth`,
    { body: { oauth_query: flowA.oauthQuery } }), 409);
  const [tokensA, tokensB, tokensC] = await Promise.all([oauthToken(owner, a.id, clientId, redirectUri, flowA),
    oauthToken(owner, b.id, clientId, redirectUri, flowB), oauthToken(peer, c.id, clientId, redirectUri, flowC)]);
  for (const [tokens, connection] of [[tokensA, a], [tokensB, b], [tokensC, c]] as const) {
    const listed = await mcp(tokens.access_token, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
    assert.equal(listed.status, 200);
    assert.deepEqual((toolValue(listed.message).projects as { id: string }[]).map((p) => p.id), [connection.projectId]);
  }
  // The signed browser query expires independently of the durable token grant.
  await pool.query(`UPDATE agent_oauth_flows SET expires_at = now() - interval '1 second'
    WHERE binding_id IN (SELECT id FROM agent_oauth_bindings WHERE connection_id = $1)`, [a.id]);
  const rotatedA = await refresh(clientId, tokensA.refresh_token); assert.equal(rotatedA.status, 200);
  const cachedA = await refresh(clientId, tokensA.refresh_token);
  assert.equal(cachedA.status, 200, 'an immediate retry uses the configured provider reuse window');
  assert.equal(cachedA.tokens.refresh_token, rotatedA.tokens.refresh_token);
  const reconnectedA = await oauthToken(owner, a.id, clientId, redirectUri);
  await pool.query(`UPDATE oauth_refresh_token SET rotation_replay_expires_at = now() - interval '1 second'
    WHERE reference_id IN (SELECT 'flux-grant:' || id::text FROM agent_oauth_bindings WHERE connection_id = $1) AND revoked IS NOT NULL`, [a.id]);
  assert.equal((await refresh(clientId, tokensA.refresh_token)).status, 400, 'reuse rejects only its original authorization family');
  assert.equal((await refresh(clientId, rotatedA.tokens.refresh_token)).status, 400);
  const freshA = await refresh(clientId, reconnectedA.refresh_token); assert.equal(freshA.status, 200, 'reconnecting creates a separate lineage');
  const freshB = await refresh(clientId, tokensB.refresh_token); assert.equal(freshB.status, 200, 'same client/user second connection survives replay');
  assert.equal((await refresh(clientId, tokensC.refresh_token)).status, 200, 'second owner survives replay');
  expect(await owner.request('DELETE', `/api/v1/agent-connections/${a.id}`), 204);
  assert.equal((await mcp(freshA.tokens.access_token, 2, 'tools/list')).status, 403);
  assert.equal((await refresh(clientId, freshA.tokens.refresh_token)).status, 400);
  assert.equal((await refresh(clientId, reconnectedA.refresh_token)).status, 400, 'cached rotation response also rechecks revoked authority');
  assert.equal((await mcp(freshB.tokens.access_token, 2, 'tools/list')).status, 200);
  assert.equal((await refresh(clientId, freshB.tokens.refresh_token)).status, 200);
  await pool.query('UPDATE oauth_client SET disabled = true WHERE client_id = $1', [clientId]);
  assert.equal((await mcp(freshB.tokens.access_token, 3, 'tools/list')).status, 403, 'a disabled actual OAuth client loses access');
});
