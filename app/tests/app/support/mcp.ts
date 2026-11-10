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

export type OauthStart = Awaited<ReturnType<typeof beginOauth>>;

/**
 * The client opens the authorization URL in the person's browser (#859). With a connection of this client already held, the
 * provider answers with the redirect that carries the code at once; otherwise it sends the person to the consent page, whose signed
 * request is `oauthQuery`.
 */
export async function beginOauth(browser: Browser, clientId: string, redirectUri: string, extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL('/api/auth/oauth2/authorize', publicOrigin);
  const state = randomUUID();
  authorize.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state,
    scope: 'offline_access', resource: `${publicOrigin}/mcp`, ...extra,
  }).toString();
  const start = await browser.request('GET', route(authorize.toString()),
    { headers: { accept: 'text/html' } });
  assert.ok(start.status === 200 || start.status === 302, `OAuth authorize returned ${start.status}`);
  const redirect = start.status === 302 ? start.headers.get('location')
    : (start.json as { url?: string } | null)?.url;
  const next = new URL(redirect ?? '', publicOrigin);
  return { verifier, state, next, consent: next.pathname === '/consent', oauthQuery: next.search.slice(1) };
}

/** The consent page's own data: who asks, where access goes and the connection already held, if any. */
export async function consentContext(browser: Browser, started: OauthStart) {
  assert.equal(started.next.pathname, '/consent', 'the client was sent to the consent page');
  return expect(await browser.request('GET', `/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(started.oauthQuery)}`), 200);
}

/** The person's one decision on the consent page. Allow answers with the client's redirect, Deny with the OAuth refusal. */
export async function decideConsent(browser: Browser, started: OauthStart, accept: boolean) {
  return browser.request('POST', '/api/auth/oauth2/consent', { body: { accept, oauth_query: started.oauthQuery } });
}

/** The client's code exchange, after the person allowed it. */
export async function exchangeCode(callback: URL, clientId: string, redirectUri: string, started: OauthStart): Promise<Tokens> {
  assert.equal(callback.origin, new URL(redirectUri).origin);
  assert.equal(callback.pathname, new URL(redirectUri).pathname);
  assert.equal(callback.searchParams.get('state'), started.state, 'the callback retains the original requesting client state');
  assert.equal(callback.searchParams.get('iss'), `${publicOrigin}/api/auth`,
    'the advertised issuer response is present before the client exchanges the code');
  const code = callback.searchParams.get('code');
  assert.ok(code, 'an authorization code was returned');
  const token = await fetch(new URL('/api/auth/oauth2/token', apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: redirectUri, client_id: clientId, code_verifier: started.verifier }),
  });
  assert.equal(token.status, 200, `OAuth token endpoint returned ${token.status}`);
  const payload = await token.json() as Tokens;
  assert.equal(payload.token_type?.toLowerCase(), 'bearer');
  assert.ok(payload.access_token, 'OAuth access token was issued');
  assert.ok(payload.refresh_token, 'OAuth refresh token was issued');
  return payload;
}

/**
 * A client signs in as a person does (#859): it opens the authorization URL, the person allows it on the consent page (one click) and
 * the client trades the code for its tokens. A client that already holds a connection of this person's gets its code with no page.
 */
export async function oauthToken(browser: Browser, clientId: string, redirectUri: string, started?: OauthStart): Promise<Tokens> {
  const begun = started ?? await beginOauth(browser, clientId, redirectUri);
  if (!begun.consent) return exchangeCode(begun.next, clientId, redirectUri, begun);
  const display = await consentContext(browser, begun);
  assert.equal(display.clientName, 'Flux HTTP test client');
  // Consent names where access goes (#287): these fixtures redirect to this computer.
  assert.deepEqual(display.redirect, { kind: 'loopback', host: new URL(redirectUri).host });
  assert.equal(display.clientIdHost, null);
  const consent = expect(await decideConsent(browser, begun, true), 200);
  return exchangeCode(new URL(String(consent.url ?? consent.redirect_uri)), clientId, redirectUri, begun);
}

export async function mcp(accessToken: string, id: number, method: string, params: Record<string, unknown> = {},
  options: { base?: string; headers?: Record<string, string>; query?: string; protocol?: '2025-06-18' | '2026-07-28' } = {}) {
  const protocol = options.protocol ?? process.env.FLUX_TEST_MCP_PROTOCOL ?? '2026-07-28';
  assert.ok(protocol === '2025-06-18' || protocol === '2026-07-28', 'test lane must name an admitted protocol');
  const modern = protocol === '2026-07-28';
  // The 2026-07-28 transport repeats the tool/prompt name or the resource URI in Mcp-Name.
  const toolName = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : null;
  const response = await fetch(new URL(`/mcp${options.query ? `?${options.query}` : ''}`, options.base ?? apiUrl), {
    method: 'POST',
    headers: { ...options.headers, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      accept: modern ? 'application/json' : 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
      ...(modern ? { 'mcp-method': method, ...(toolName ? { 'mcp-name': toolName } : {}) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...(modern ? { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'flux-http-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } : {}) } }),
  });
  const body = await response.text();
  let message: Record<string, unknown> | null = null;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = body.split('\n').find((line) => line.startsWith('data: '));
    if (data) message = JSON.parse(data.slice(6)) as Record<string, unknown>;
  } else if (body) {
    message = JSON.parse(body) as Record<string, unknown>;
  }
  return { status: response.status, message, headers: response.headers };
}

/**
 * A caller's `fetch` as a client of the 2025-06-18 protocol sends what it was given for 2026-07-28 (the worker's `mcpToolHost` speaks only
 * the latter): no envelope in the body, no `Mcp-Method` or `Mcp-Name`, and an Accept for both forms of answer. The era of the route's
 * answer is then the legacy one (a request with no session, as `mcp()` sends it under `FLUX_TEST_MCP_PROTOCOL=2025-06-18`).
 */
export function inLegacyEra(fetchImpl: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete('mcp-method'); headers.delete('mcp-name');
    headers.set('mcp-protocol-version', '2025-06-18');
    headers.set('accept', 'application/json, text/event-stream');
    const body = JSON.parse(String(init?.body)) as { params?: Record<string, unknown> };
    if (body.params) delete body.params._meta;
    return fetchImpl(input, { ...init, headers, body: JSON.stringify(body) });
  }) as typeof fetch;
}

export function toolValue(message: Record<string, unknown> | null) {
  assert.ok(message && !message.error, 'MCP returned a tool result');
  const result = message.result as { isError?: boolean; content?: { type: string; text?: string }[] };
  assert.equal(result?.isError, undefined);
  assert.equal(result?.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text ?? '') as Record<string, unknown>;
}
