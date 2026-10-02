import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { apiUrl, publicOrigin, type Browser, type ClientResponse } from './http.js';

// Real OAuth authorization-code/PKCE and MCP-over-HTTP helpers for the API tests.

export function expect(response: ClientResponse, status: number) {
  assert.equal(response.status, status, `${response.status} from application endpoint`);
  return response.json as Record<string, unknown>;
}

function route(location: string) {
  const parsed = new URL(location, publicOrigin);
  return `${parsed.pathname}${parsed.search}`;
}

export interface Tokens { access_token: string; refresh_token: string; token_type: string }

export async function beginOauth(browser: Browser, clientId: string, redirectUri: string, extra: Record<string, string> = {}) {
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

export async function oauthToken(browser: Browser, connectionId: string, clientId: string, redirectUri: string,
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
  assert.equal(callback.pathname, new URL(redirectUri).pathname);
  assert.equal(callback.searchParams.get('state'), new URLSearchParams(selectedQuery).get('state'),
    'the callback retains the original requesting client state');
  assert.equal(callback.searchParams.get('iss'), `${publicOrigin}/api/auth`,
    'the advertised issuer response is present before the client exchanges the code');
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

export async function mcp(accessToken: string, id: number, method: string, params: Record<string, unknown> = {}) {
  // The 2026-07-28 transport repeats the tool/prompt name or the resource URI in Mcp-Name.
  const toolName = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : null;
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

export function toolValue(message: Record<string, unknown> | null) {
  assert.ok(message && !message.error, 'MCP returned a tool result');
  const result = message.result as { isError?: boolean; content?: { type: string; text?: string }[] };
  assert.equal(result?.isError, undefined);
  assert.equal(result?.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text ?? '') as Record<string, unknown>;
}
