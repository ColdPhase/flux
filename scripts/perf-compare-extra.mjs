/* global fetch, process, console, URL, URLSearchParams, performance */
// Search timings for scripts/perf_compare.sh, beside scripts/perf-measure.mjs and in its output format (`plan`, `window`, `client`
// lines, each request with its own X-Request-ID so the API's log gives its server time). Runs with plain Node in the measuring
// client's container (the API's image), fed on stdin, with the state perf-measure.mjs `prepare` printed (FLUX_PERF_STATE).
//
// FLUX_PERF_MODE:
//   search  people's search (`GET /api/v1/search`, what the search box and Jump to send) for each query below, FLUX_PERF_RUNS
//           times, by the owner of the perf seed
//   agent   the agents' `flux_search` over MCP (F-042, #1290) for the same queries: the owner's own agent, signed in as a local
//           client (an OAuth client and connection written as the API tests' fixtures write them, then the real code exchange).
//           A ref without the tool prints a `note` line and nothing else.
// FLUX_PERF_SUFFIX is appended to the phase name (` @2 vcpu`, ` @1.0 cpu`).

import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const api = process.env.FLUX_PERF_API ?? 'http://127.0.0.1:8080';
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const mode = process.env.FLUX_PERF_MODE ?? 'search';
const runs = Number(process.env.FLUX_PERF_RUNS ?? 15);
const suffix = process.env.FLUX_PERF_SUFFIX ?? '';
// The seed's words (scripts/perf-seed.mjs): one rare, one common, several words, a phrase and an exclusion (the exact index), Polish.
const QUERIES = ['LoRa', 'frost warnings', 'readings bed noisy rain', '"after the rain"', 'sensor -lamp', 'czujnik wilgotności'];
const emit = (row) => console.log(JSON.stringify(row));
const fail = (message) => { console.error(`perf-compare-extra: ${message}`); process.exit(1); };
if (!origin || !process.env.FLUX_PERF_STATE) fail('FLUX_PUBLIC_ORIGIN and FLUX_PERF_STATE are required');
const state = JSON.parse(process.env.FLUX_PERF_STATE);
const runId = Math.random().toString(36).slice(2, 8);
let sequence = 0;

async function send(method, path, { cookies, body, headers = {}, form } = {}) {
  const reqId = `perfx-${runId}-${++sequence}`;
  const all = { origin, accept: 'application/json', 'accept-encoding': 'gzip, deflate, br', 'x-request-id': reqId, ...headers };
  for (const key of Object.keys(all)) if (all[key] === null) delete all[key];
  if (cookies) all.cookie = cookies.map(([k, v]) => `${k}=${v}`).join('; ');
  let payload;
  if (form) { all['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { all['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const started = performance.now();
  const response = await fetch(new URL(path, api), { method, headers: all, body: payload, redirect: 'manual' });
  const text = await response.text();
  const ms = performance.now() - started;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text, ms, reqId, headers: response.headers };
}

const owner = state.cookies[0];
const record = (view, label, method, path, response) => emit({ type: 'client', view, label, method, path, status: response.status,
  ms: Math.round(response.ms * 10) / 10, bytes: response.text.length, reqId: response.reqId });

async function timed(phase, view, requests) {
  emit({ type: 'plan', views: [{ view, requests: requests.map(({ label, method, path }) => ({ label, method, path })) }] });
  for (const request of requests) await request.run('warmup');
  const start = Date.now();
  for (let run = 0; run < runs; run++) for (const request of requests) record(view, request.label, request.method, request.path, await request.run());
  emit({ type: 'window', phase: `${phase}${suffix}`, start, end: Date.now() });
}

if (mode === 'search') {
  await timed('search', 'Search', QUERIES.map((q) => {
    const path = `/api/v1/search?${new URLSearchParams({ q, limit: 20 })}`;
    return { label: `search ${q}`, method: 'GET', path, run: () => send('GET', path, { cookies: owner }) };
  }));
} else if (mode === 'agent') {
  const token = await agentToken();
  if (!token) process.exit(0);
  let id = 1;
  const call = (name, args) => send('POST', '/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'flux-perf', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {} } } } });
  const listed = await send('POST', '/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
    body: { jsonrpc: '2.0', id: id++, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'flux-perf', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } } });
  const tools = listed.json?.result?.tools?.map((tool) => tool.name) ?? [];
  if (!tools.includes('flux_search')) {
    emit({ type: 'note', mode, note: `no flux_search here (tools/list ${listed.status}, ${tools.length} tools)` });
    process.exit(0);
  }
  const first = await call('flux_search', { q: QUERIES[0], limit: 10 });
  const result = first.json?.result;
  const hits = (() => { try { return JSON.parse(result?.content?.[0]?.text ?? '{}').results?.length ?? null; } catch { return null; } })();
  emit({ type: 'note', mode, note: `flux_search answered ${first.status}${result?.isError ? ' (tool error)' : ''}, ${hits ?? '?'} hits for "${QUERIES[0]}"`,
    sample: (result?.content?.[0]?.text ?? first.text).slice(0, 300) });
  await timed('agent search', 'Agent search', QUERIES.map((q) => ({
    label: `flux_search ${q}`, method: 'POST', path: '/mcp', run: () => call('flux_search', { q, limit: 10 }),
  })));
} else {
  fail(`Unknown FLUX_PERF_MODE ${mode}`);
}

/** The owner's own agent signed in as a local client (as app/tests/app/support/mcp-actions.ts `agentConnection` does). */
async function agentToken() {
  const require = createRequire('/app/packages/db/package.json');
  const pg = require('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const me = (await send('GET', '/api/v1/me', { cookies: owner })).json;
    const agent = await send('POST', `/api/v1/workspaces/${state.ids.workspaceId}/agents`, { cookies: owner, body: { name: `Perf agent ${runId}`, owner: 'self' } });
    if (agent.status !== 201) { emit({ type: 'note', mode, note: `agent not created: ${agent.status} ${agent.text.slice(0, 200)}` }); return null; }
    // The space's AI switch: agents find only spaces whose AI is allowed (F-037, AG-10).
    const policy = await db.query('SELECT state FROM project_ai_policies WHERE project_id = $1', [state.ids.projectId]).catch(() => ({ rows: [] }));
    emit({ type: 'note', mode, note: `space AI: ${policy.rows[0]?.state ?? 'no policy row'}` });
    const clientId = `flux-perf-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await db.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes,
      require_pkce, created_at, updated_at) VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, true, now(), now())`,
    [randomUUID(), clientId, 'Flux HTTP test client', [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['offline_access']]);
    await db.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${origin}/mcp`]);
    const connectionId = randomUUID();
    await db.query(`INSERT INTO agent_connections (id, workspace_id, owner_user_id, agent_id, name, client_designation) VALUES ($1, $2, $3, $4, $5, 'other')`,
      [connectionId, state.ids.workspaceId, me.user.id, agent.json.id, 'Perf client']);
    await db.query('INSERT INTO agent_oauth_bindings (id, owner_user_id, connection_id, client_id) VALUES ($1, $2, $3, $4)', [randomUUID(), me.user.id, connectionId, clientId]);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state: randomUUID(),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'offline_access', resource: `${origin}/mcp` });
    const start = await send('GET', `/api/auth/oauth2/authorize?${authorize}`, { cookies: owner, headers: { accept: 'text/html' } });
    let next = new URL(start.status === 302 ? start.headers.get('location') ?? '' : start.json?.url ?? '', origin);
    if (next.pathname === '/consent') {
      const consent = await send('POST', '/api/auth/oauth2/consent', { cookies: owner, body: { accept: true, oauth_query: next.search.slice(1) } });
      next = new URL(String(consent.json?.url ?? consent.json?.redirect_uri ?? ''), origin);
    }
    const code = next.searchParams.get('code');
    if (!code) { emit({ type: 'note', mode, note: `no authorization code (${start.status} ${start.text.slice(0, 200)})` }); return null; }
    const token = await send('POST', '/api/auth/oauth2/token', { headers: { origin: null }, form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: clientId, code_verifier: verifier } });
    if (!token.json?.access_token) { emit({ type: 'note', mode, note: `no token (${token.status} ${token.text.slice(0, 200)})` }); return null; }
    return token.json.access_token;
  } catch (error) {
    emit({ type: 'note', mode, note: `agent sign-in failed: ${error.message}` });
    return null;
  } finally {
    await db.end();
  }
}
