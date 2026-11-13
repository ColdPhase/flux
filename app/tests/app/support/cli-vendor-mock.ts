import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { claudeReal, codexReal, codexSearchReal, realModelOn, realTranscript } from './real-model.js';

/**
 * TEST ONLY (#1125): the vendors of the REAL pinned Claude Code and Codex, served by the `providermock` service for
 * scripts/check_cli_runtime.sh. The runtime's CLIs reach it because a TEST ONLY image stage wraps each binary with its model and
 * sign-in hosts set to this mock (app/tests/cli-runtime/); the supervisor's argv and environment are Flux's own. It is never a
 * model: a test sets a script of what "the model" does next, and asserts Flux's side effects, not text.
 *
 *   Claude Code (`ANTHROPIC_BASE_URL=…/cli/anthropic`, an API key):
 *     HEAD /cli/anthropic/api/hello, POST /cli/anthropic/v1/messages(?beta=true) (SSE), POST …/v1/messages/count_tokens
 *   Codex (`openai_base_url=…/cli/openai/v1`, `chatgpt_base_url=…/cli/chatgpt/backend-api/`, `--experimental_issuer …/cli/auth`):
 *     GET /cli/openai/v1/responses with `Upgrade: websocket` → 426 (Codex falls back to HTTP at once), POST …/responses (SSE)
 *     POST /cli/auth/api/accounts/deviceauth/usercode, …/deviceauth/token, /cli/auth/oauth/token, /cli/auth/oauth/revoke
 *     POST …/alpha/search (Codex's standalone web search, `web.run`), GET /cli/chatgpt/backend-api/wham/usage
 *   Control: POST /__cli/script { client, steps, usage, accessLifetimeSeconds, revokeRefreshTokens }, POST /__cli/approve,
 *   GET /__cli/journal, POST /__cli/reset
 *
 * A step is what the model does on its next main request (Claude Code: one that offers Flux's tools or `WebSearch`; Codex: every
 * `/responses`): `{ tool, args }` calls a Flux MCP tool, `{ search }` starts a search (Claude Code's `WebSearch`; for Codex a call of its
 * standalone `web.run` tool when the request offers it, whose `alpha/search` request gets the search's results, else a hosted
 * `web_search_call` item, #1065), `{ text }` answers, `{ error: { status, body, headers } }` fails the request, `{ failed }` ends a Codex stream with
 * `response.failed`, `{ own: { name, input } }` calls the CLI's own tool (#1437). After the last step the model answers "Done.". Claude Code's side requests (no Flux tool) get a plain answer, and
 * its `WebSearch` sub-request (a `web_search_*` server tool) gets the pending search's results. An API key that starts with
 * `sk-ant-mock-expired` is refused as the API refuses a revoked key.
 *
 * With `FLUX_CLI_REAL_MODEL_URL` set (scripts/check_ai_real_model.sh), a REAL local model answers instead of the steps: the model requests
 * and the searches go to real-model.ts, `GET /__real/transcript?since=n` returns what the model was sent and answered, and everything else
 * here (sign-in, refresh, usage, the revoked key, the journal) stays as it is.
 */

type Json = Record<string, unknown>;
export type CliClient = 'claude' | 'codex';
export interface CliSearch { query: string; results: { url: string; title: string }[]; text?: string }
export type CliStep =
  | { tool: string; args: Json }
  | { search: CliSearch }
  | { text: string }
  | { error: { status: number; body: Json; headers?: Record<string, string> } }
  | { failed: { code: string; message: string } }
  /** The CLI's own tool (#1437): Claude Code's `Bash`, `Read`, `Write`…, or Codex's `exec_command` (`{ cmd }`), with its input as the model gives it. */
  | { own: { name: string; input: Json } };
export interface CliJournalEntry {
  n: number; at: number; client: CliClient | 'issuer' | 'chatgpt' | 'other'; kind: string; path: string;
  /** The credential the request carried: Claude's `x-api-key`, Codex's bearer (an API key or a ChatGPT access token). */
  credential: string | null;
  model?: string;
  /** The tools the request offered the model, by name (Claude Code: `mcp__flux__…`, `WebSearch`; Codex: nested names too). */
  tools?: string[];
  /** The text of every tool result in the request so far, oldest first: what Flux's MCP answers gave the model. */
  results?: string[];
  step?: number;
  /** Who sent it: the client's own user agent (`claude-cli/<version> …`, `codex_exec/<version> …`). */
  agent?: string;
  detail?: Json;
}

const state = {
  steps: { claude: [] as CliStep[], codex: [] as CliStep[] },
  cursor: { claude: 0, codex: 0 },
  /** The search a Claude Code `WebSearch` or a Codex `web.run` call started; its sub-request answers with these results. */
  pendingSearch: null as CliSearch | null,
  journal: [] as CliJournalEntry[],
  devices: new Map<string, { userCode: string; approved: boolean; polls: number }>(),
  codes: new Map<string, string>(),
  refreshTokens: new Set<string>(),
  /** `/wham/usage`: the 5-hour window's used share and its reset (Unix seconds). */
  usage: { usedPercent: 12, resetsAt: 0 },
  accessLifetimeSeconds: 3600,
};
let counter = 0;

let current: http.IncomingMessage | null = null;
function record(entry: Omit<CliJournalEntry, 'n' | 'at'>) {
  const agent = current?.headers['user-agent'];
  state.journal.push({ n: ++counter, at: Date.now(), ...(typeof agent === 'string' ? { agent } : {}), ...entry });
}

function json(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function sse(response: http.ServerResponse, events: [string, unknown][]) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part : textOf((part as { text?: unknown; content?: unknown }).text ?? (part as { content?: unknown }).content)).join('\n') : '';

/**
 * A JWT that nobody signed: Codex reads the claims of its tokens and never checks a signature, but wants three non-empty parts
 * (codex-rs login/src/token_data.rs `decode_jwt_payload`).
 */
const jwt = (claims: Json) => `${[{ alg: 'none', typ: 'JWT' }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.not-signed`;
const PLAN_CLAIMS = { chatgpt_plan_type: 'plus', chatgpt_user_id: 'user-mock-1', chatgpt_account_id: 'acct-mock-1' };
/**
 * `lifetime`: a sign-in's access token lives `accessLifetimeSeconds` (a short one makes the CLI refresh it); a refreshed one an hour, as
 * a token inside Codex's five-minute refresh window would be refreshed again at once, without end (observed 2026-11-09).
 */
function issueTokens(lifetime: number) {
  const now = Math.floor(Date.now() / 1000);
  const refresh = `rt-mock-${randomBytes(6).toString('hex')}`;
  state.refreshTokens.add(refresh);
  return {
    id_token: jwt({ iss: 'https://auth.openai.com', sub: 'user-mock-1', email: 'plan-person@example.test', iat: now, exp: now + 3600, 'https://api.openai.com/auth': PLAN_CLAIMS }),
    access_token: jwt({ iss: 'https://auth.openai.com', sub: 'user-mock-1', iat: now, exp: now + lifetime, 'https://api.openai.com/auth': PLAN_CLAIMS,
      jti: randomBytes(6).toString('hex') }),
    refresh_token: refresh,
    token_type: 'Bearer', expires_in: lifetime,
  };
}

function nextStep(client: CliClient): { step: CliStep; index: number } {
  const index = state.cursor[client]++;
  return { step: state.steps[client][index] ?? { text: 'Done.' }, index };
}

// --- Anthropic Messages, as Claude Code 2.1.285 reads it (stream: true; observed 2026-11-09).

const messageStart = (id: string, model: string) => ['message_start', { type: 'message_start',
  message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } }] as [string, unknown];
const messageEnd = (reason: string): [string, unknown][] => [
  ['message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 12 } }],
  ['message_stop', { type: 'message_stop' }]];
const textBlock = (index: number, text: string): [string, unknown][] => [
  ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index }]];
const toolBlock = (index: number, id: string, name: string, input: Json): [string, unknown][] => [
  ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
  ['content_block_stop', { type: 'content_block_stop', index }]];

function claudeMessages(request: http.IncomingMessage, response: http.ServerResponse, path: string, body: Json) {
  const key = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null;
  const model = typeof body.model === 'string' ? body.model : 'mock';
  const tools = (Array.isArray(body.tools) ? body.tools : []) as Json[];
  const names = tools.map((tool) => String(tool.name ?? tool.type ?? ''));
  const results: string[] = [];
  for (const message of (Array.isArray(body.messages) ? body.messages : []) as Json[])
    for (const block of (Array.isArray(message.content) ? message.content : []) as Json[]) if (block.type === 'tool_result') results.push(textOf(block.content));
  const id = `msg_mock_${counter + 1}`;
  if (key?.startsWith('sk-ant-mock-expired')) {
    record({ client: 'claude', kind: 'refused_key', path, credential: key, model });
    // The API's answer to a revoked key; `x-should-retry: false` ends Claude Code's ten retries at once (the text is the same either way).
    return json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_mock_401' }, { 'x-should-retry': 'false' });
  }
  if (realModelOn()) {
    const search = tools.some((tool) => String(tool.type ?? '').startsWith('web_search_'));
    const main = names.some((name) => name.startsWith('mcp__flux__') || name === 'WebSearch');
    record({ client: 'claude', kind: search ? 'web_search' : main ? 'main' : 'side', path, credential: key, model, tools: names, results });
    void claudeReal(response, body);
    return;
  }
  if (tools.some((tool) => String(tool.type ?? '').startsWith('web_search_'))) {
    const search = state.pendingSearch ?? { query: 'nothing', results: [] };
    record({ client: 'claude', kind: 'web_search', path, credential: key, model, detail: { query: search.query } });
    const useId = `srvtoolu_mock_${counter}`;
    return sse(response, [messageStart(id, model),
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: useId, name: 'web_search', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: search.query }) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: useId,
        content: search.results.map((hit) => ({ type: 'web_search_result', url: hit.url, title: hit.title, encrypted_content: 'enc-mock', page_age: null })) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ...textBlock(2, search.text ?? `Found ${search.results.length} pages.`), ...messageEnd('end_turn')]);
  }
  if (!names.some((name) => name.startsWith('mcp__flux__') || name === 'WebSearch')) {
    record({ client: 'claude', kind: 'side', path, credential: key, model });
    return sse(response, [messageStart(id, model), ...textBlock(0, 'ok'), ...messageEnd('end_turn')]);
  }
  const { step, index } = nextStep('claude');
  record({ client: 'claude', kind: 'main', path, credential: key, model, tools: names, results, step: index });
  if ('error' in step) return json(response, step.error.status, step.error.body, step.error.headers);
  if ('tool' in step) return sse(response, [messageStart(id, model), ...toolBlock(0, `toolu_mock_${counter}`, `mcp__flux__${step.tool}`, step.args), ...messageEnd('tool_use')]);
  if ('search' in step) {
    state.pendingSearch = step.search;
    return sse(response, [messageStart(id, model), ...toolBlock(0, `toolu_mock_${counter}`, 'WebSearch', { query: step.search.query }), ...messageEnd('tool_use')]);
  }
  if ('own' in step) return sse(response, [messageStart(id, model), ...toolBlock(0, `toolu_mock_${counter}`, step.own.name, step.own.input), ...messageEnd('tool_use')]);
  return sse(response, [messageStart(id, model), ...textBlock(0, 'text' in step ? step.text : 'Done.'), ...messageEnd('end_turn')]);
}

// --- OpenAI Responses, as Codex rust-v0.160.1 reads it (stream; tools in an `additional_tools` input item; observed 2026-11-09).

function codexTools(body: Json): string[] {
  const groups = [...(Array.isArray(body.tools) ? body.tools : []),
    ...((Array.isArray(body.input) ? body.input : []) as Json[]).filter((item) => item.type === 'additional_tools').flatMap((item) => (Array.isArray(item.tools) ? item.tools : []))] as Json[];
  const names: string[] = [];
  const walk = (list: Json[], prefix: string) => {
    for (const tool of list) {
      const name = typeof tool.name === 'string' ? tool.name : String(tool.type ?? '');
      if (Array.isArray(tool.tools)) walk(tool.tools as Json[], `${prefix}${name}.`);
      else names.push(`${prefix}${name}`);
    }
  };
  walk(groups, '');
  return names;
}

function codexResponses(request: http.IncomingMessage, response: http.ServerResponse, path: string, body: Json) {
  const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '') || null;
  const input = (Array.isArray(body.input) ? body.input : []) as Json[];
  const results = input.filter((item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output').map((item) => textOf(item.output));
  const tools = codexTools(body);
  const model = typeof body.model === 'string' ? body.model : '';
  if (realModelOn()) {
    record({ client: 'codex', kind: 'main', path, credential: bearer, model, tools, results });
    void codexReal(response, body);
    return;
  }
  const { step, index } = nextStep('codex');
  record({ client: 'codex', kind: 'main', path, credential: bearer, model, tools, results, step: index,
    detail: { account: request.headers['chatgpt-account-id'] ?? null, encoding: request.headers['content-encoding'] ?? null } });
  if ('error' in step) return json(response, step.error.status, step.error.body, step.error.headers);
  const responseId = `resp_mock_${counter}`;
  const events: [string, unknown][] = [['response.created', { type: 'response.created', response: { id: responseId } }]];
  if ('failed' in step) {
    events.push(['response.failed', { type: 'response.failed', response: { id: responseId, error: step.failed } }]);
    return sse(response, events);
  }
  let item: Json;
  if ('tool' in step) {
    // A Flux tool as Codex names it in this request (a plain or namespaced function).
    const named = tools.find((name) => name.endsWith(step.tool)) ?? step.tool;
    const dot = named.lastIndexOf('.');
    item = { type: 'function_call', id: `fc_mock_${counter}`, call_id: `call_mock_${counter}`, name: named.slice(dot + 1), arguments: JSON.stringify(step.args),
      ...(dot > 0 ? { namespace: named.slice(0, dot) } : {}) };
  } else if ('own' in step) {
    // Codex's own tool (#1437), as a plain function of the request (`functions.exec_command`).
    item = { type: 'function_call', id: `fc_mock_${counter}`, call_id: `call_mock_${counter}`, name: step.own.name, arguments: JSON.stringify(step.own.input) };
  } else if ('search' in step && tools.includes('web.run')) {
    // The standalone search of a Responses Lite model (#1065): a call of `web.run`, which the CLI runs itself against `alpha/search`.
    state.pendingSearch = step.search;
    item = { type: 'function_call', id: `fc_mock_${counter}`, call_id: `call_mock_${counter}`, namespace: 'web', name: 'run',
      arguments: JSON.stringify({ search_query: [{ q: step.search.query }] }) };
  } else if ('search' in step) {
    item = { type: 'web_search_call', id: `ws_mock_${counter}`, status: 'completed', action: { type: 'search', query: step.search.query,
      sources: step.search.results.map((hit) => ({ type: 'url', url: hit.url })) } };
  } else {
    item = { type: 'message', role: 'assistant', id: `msg_mock_${counter}`, status: 'completed', content: [{ type: 'output_text', text: 'text' in step ? step.text : 'Done.', annotations: [] }] };
  }
  events.push(['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }]);
  events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }]);
  events.push(['response.completed', { type: 'response.completed', response: { id: responseId,
    usage: { input_tokens: 25, input_tokens_details: null, output_tokens: 12, output_tokens_details: null, total_tokens: 37 } } }]);
  return sse(response, events);
}

/**
 * Codex's standalone web search (`web.run`, codex-rs `codex-api/src/endpoint/search.rs` at rust-v0.160.1): the pending search's results as
 * search result entries (`text_result`, `ref_id` `turn0search<N>`), and the request's own settings in the journal (`external_web_access`).
 */
function codexSearch(request: http.IncomingMessage, response: http.ServerResponse, path: string, body: Json) {
  const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '') || null;
  if (realModelOn()) {
    const settings = (body.settings && typeof body.settings === 'object' ? body.settings : {}) as Json;
    record({ client: 'codex', kind: 'web_search', path, credential: bearer, detail: { commands: body.commands ?? null, externalWebAccess: settings.external_web_access ?? null } });
    void codexSearchReal(response, body);
    return;
  }
  const search = state.pendingSearch ?? { query: 'nothing', results: [] };
  const settings = (body.settings && typeof body.settings === 'object' ? body.settings : {}) as Json;
  record({ client: 'codex', kind: 'web_search', path, credential: bearer, detail: { query: search.query, commands: body.commands ?? null,
    externalWebAccess: settings.external_web_access ?? null } });
  return json(response, 200, { output: search.text ?? `Found ${search.results.length} pages.`,
    results: search.results.map((hit, index) => ({ type: 'text_result', ref_id: `turn0search${index}`, url: hit.url, title: hit.title, snippet: hit.title })) });
}

// --- The OpenAI sign-in issuer for `codex login --device-auth` (codex-rs login/src/device_code_auth.rs, server.rs at rust-v0.160.1).

function issuer(response: http.ServerResponse, path: string, body: Json, raw: string) {
  if (path === '/api/accounts/deviceauth/usercode') {
    const deviceId = `dev-${randomBytes(6).toString('hex')}`;
    const userCode = `${randomBytes(2).toString('hex')}-${randomBytes(3).toString('hex')}`.toUpperCase();
    state.devices.set(deviceId, { userCode, approved: false, polls: 0 });
    record({ client: 'issuer', kind: 'usercode', path, credential: null, detail: { userCode } });
    return json(response, 200, { device_auth_id: deviceId, user_code: userCode, interval: '1' });
  }
  if (path === '/api/accounts/deviceauth/token') {
    const device = state.devices.get(String(body.device_auth_id ?? ''));
    if (!device || device.userCode !== body.user_code) return json(response, 404, { error: 'unknown device' });
    device.polls += 1;
    if (!device.approved) return json(response, 403, { error: 'authorization_pending' });
    const code = `code-${randomBytes(6).toString('hex')}`;
    state.codes.set(code, String(body.device_auth_id));
    state.devices.delete(String(body.device_auth_id));
    record({ client: 'issuer', kind: 'device_approved', path, credential: null, detail: { polls: device.polls } });
    return json(response, 200, { authorization_code: code, code_challenge: 'mock-challenge', code_verifier: 'mock-verifier' });
  }
  if (path === '/oauth/token') {
    // The code exchange is form-encoded; the refresh is JSON (codex-rs login/src/server.rs, auth/manager.rs).
    const form = Object.fromEntries(new URLSearchParams(raw)) as Json;
    const fields = typeof body.grant_type === 'string' ? body : form;
    if (fields.grant_type === 'authorization_code' && state.codes.delete(String(fields.code ?? ''))) {
      record({ client: 'issuer', kind: 'code_exchange', path, credential: null });
      return json(response, 200, issueTokens(state.accessLifetimeSeconds));
    }
    if (fields.grant_type === 'refresh_token') {
      const known = state.refreshTokens.delete(String(fields.refresh_token ?? ''));
      record({ client: 'issuer', kind: 'refresh', path, credential: null, detail: { known } });
      if (!known) return json(response, 401, { error: { code: 'refresh_token_invalidated', message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.' } });
      return json(response, 200, issueTokens(3600));
    }
    return json(response, 400, { error: 'invalid_grant' });
  }
  if (path === '/oauth/revoke') {
    record({ client: 'issuer', kind: 'revoke', path, credential: null });
    return json(response, 200, {});
  }
  return json(response, 404, { error: 'not found' });
}

/** The ChatGPT backend's usage read (`account/rateLimits/read` → `{chatgpt_base_url}/wham/usage`, codex-rs backend-client). */
function chatgpt(request: http.IncomingMessage, response: http.ServerResponse, path: string) {
  const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '') || null;
  record({ client: 'chatgpt', kind: path, path, credential: bearer });
  if (path === '/wham/usage') {
    const resetsAt = state.usage.resetsAt || Math.floor(Date.now() / 1000) + 3 * 3600;
    const window = { used_percent: state.usage.usedPercent, limit_window_seconds: 18_000, reset_after_seconds: Math.max(0, resetsAt - Math.floor(Date.now() / 1000)), reset_at: resetsAt };
    return json(response, 200, { plan_type: 'plus', rate_limit: { allowed: state.usage.usedPercent < 100, limit_reached: state.usage.usedPercent >= 100, primary_window: window, secondary_window: null },
      credits: null, additional_rate_limits: null });
  }
  return json(response, 404, { error: 'not found' });
}

/** Handles `/cli/…` and `/__cli/…`; false for any other path (the adapter suite's routes). */
export function handleCliVendor(request: http.IncomingMessage, response: http.ServerResponse, url: URL, raw: string, body: unknown): boolean {
  const path = url.pathname;
  const fields = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Json;
  current = request;
  if (path === '/__cli/reset') {
    Object.assign(state, { steps: { claude: [], codex: [] }, cursor: { claude: 0, codex: 0 }, pendingSearch: null, journal: [], usage: { usedPercent: 12, resetsAt: 0 }, accessLifetimeSeconds: 3600 });
    state.devices.clear(); state.codes.clear(); state.refreshTokens.clear();
    json(response, 200, { ok: true }); return true;
  }
  if (path === '/__cli/script') {
    const client = fields.client === 'codex' ? 'codex' : 'claude';
    state.steps[client] = Array.isArray(fields.steps) ? fields.steps as CliStep[] : [];
    state.cursor[client] = 0;
    state.pendingSearch = null;
    if (fields.usage && typeof fields.usage === 'object') state.usage = { ...state.usage, ...fields.usage as typeof state.usage };
    if (typeof fields.accessLifetimeSeconds === 'number') state.accessLifetimeSeconds = fields.accessLifetimeSeconds;
    // The sign-in was revoked at the vendor: no refresh token the CLI holds works any more.
    if (fields.revokeRefreshTokens === true) state.refreshTokens.clear();
    json(response, 200, { ok: true }); return true;
  }
  if (path === '/__cli/approve') {
    let approved = 0;
    for (const device of state.devices.values()) if (!device.approved) { device.approved = true; approved += 1; }
    json(response, 200, { approved }); return true;
  }
  if (path === '/__cli/journal') { json(response, 200, { journal: state.journal }); return true; }
  if (path === '/__real/transcript') { json(response, 200, { transcript: realTranscript(Number(url.searchParams.get('since') ?? '0')) }); return true; }
  if (!path.startsWith('/cli/')) return false;

  if (path.startsWith('/cli/anthropic/')) {
    const rest = path.slice('/cli/anthropic'.length);
    if (rest === '/api/hello') { response.writeHead(200); response.end(); return true; }
    if (rest === '/v1/messages/count_tokens') { json(response, 200, { input_tokens: Math.max(1, Math.ceil(raw.length / 4)) }); return true; }
    if (rest === '/v1/messages' && request.method === 'POST') { claudeMessages(request, response, rest, fields); return true; }
  }
  if (path.startsWith('/cli/openai/')) {
    const rest = path.slice('/cli/openai'.length);
    // Codex's built-in provider asks for a WebSocket first; 426 makes it use HTTP at once (codex-rs core/src/client.rs).
    if (request.headers.upgrade) { record({ client: 'codex', kind: 'websocket_refused', path: rest, credential: null }); json(response, 426, { error: 'use http' }); return true; }
    if (rest === '/v1/responses' && request.method === 'POST') { codexResponses(request, response, rest, fields); return true; }
    if (rest.endsWith('/alpha/search') && request.method === 'POST') { codexSearch(request, response, rest, fields); return true; }
  }
  if (path.startsWith('/cli/chatgpt/') && path.endsWith('/alpha/search') && request.method === 'POST') { codexSearch(request, response, path, fields); return true; }
  if (path.startsWith('/cli/auth/')) { issuer(response, path.slice('/cli/auth'.length), fields, raw); return true; }
  if (path.startsWith('/cli/chatgpt/backend-api/')) { chatgpt(request, response, path.slice('/cli/chatgpt/backend-api'.length)); return true; }
  // Anything else, such as Codex's model list (`/cli/openai/v1/models`): 404, so each CLI keeps its own pinned model catalog.
  record({ client: 'other', kind: 'not_found', path, credential: null });
  json(response, 404, { error: 'not found' });
  return true;
}
