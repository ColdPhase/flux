import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOLDEN_HELP } from '../contract/goldens.js';

// TEST ONLY (F-022 Docker test plan): fake `claude` and `codex` with the same command shapes, streams,
// messages and exit codes as the pinned CLIs (Claude Code 2.1.285, Codex rust-v0.160.1), so the runtime
// is tested without any subscription. They exist only in the `agent-runtime-test` image. Each call is
// recorded in the CLI's home (`fake-calls.jsonl`: the argv, the environment's names and the non-secret
// values the tests check). A scenario file in the same home (`fake-scenario`) selects failures. A fake
// never contacts a vendor. The real CLIs were observed account-free on 2026-10-08 in
// `docker run --network none`; src/contract/auth-table.ts holds the one assertion table that runs
// against these fakes and, in scripts/check_runtime_cli_contract.sh, against the real binaries.
//
// `claude auth login` prints, on stdout: "Opening browser to sign in…", "If the browser didn't open,
// visit: <url>" and "Paste code here if prompted > " (no newline), then reads lines. Each line is
// trimmed and split on "#" into code and state; a missing part or a state other than the one printed
// gets "Invalid code. Please make sure the full code was copied." on stderr and the CLI keeps waiting.
// A pasted `<code>#<state>` signs in: `.credentials.json` (0600) holds a seeded fake credential,
// `fake-secret` in the home when present (the secret-absence tests look for it everywhere else), then
// "Login successful." and exit 0. As the real CLI keeps the signed-in account with its login, a sign-in
// also keeps one: `fake-account` in the home when a test seeded it, otherwise owner@example.org. A
// credential file written without a sign-in (the contract table's seeded state) has no account, and
// `auth status` then reports `email: null`. On a terminal the URL is an OSC 8 hyperlink, as the real CLI draws it.
//
// Scenarios (`fake-scenario`): login_failed (the exchange fails: `Login failed: …`, exit 1; a pasted code
// starting `fake-reject-` does the same without a file),
// login_timeout (no code arrives in time; the wording is the fake's own, the real one is unknown),
// login_hangs (waits at the prompt for good), login_without_credentials (succeeds without writing a
// login), console_profile (a `--console` login stores a keyless Anthropic profile OUTSIDE
// CLAUDE_CONFIG_DIR, in `$HOME/.config/anthropic`, as Claude Code 2.1.242 and later do),
// logout_fails (`Logout failed: …`, exit 1), logout_hangs.

export type FakeClient = 'claude_code' | 'codex';

const home = (client: FakeClient) => (client === 'claude_code' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) ?? '';
const credentials = (client: FakeClient) => join(home(client), client === 'claude_code' ? '.credentials.json' : 'auth.json');
const readHome = (client: FakeClient, name: string) => { try { return readFileSync(join(home(client), name), 'utf8').trim(); } catch { return ''; } };
/** The keyless Console sign-in's profile directory: outside CLAUDE_CONFIG_DIR, under the CLI's HOME. */
const profileDir = () => join(process.env.HOME ?? '', '.config', 'anthropic');
const hasProfile = () => existsSync(join(profileDir(), 'active_config'));

function record(client: FakeClient, argv: string[], extra: Record<string, unknown> = {}) {
  const dir = home(client);
  if (!dir || !existsSync(dir)) return;
  const shown = ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HTTPS_PROXY', 'NO_PROXY', 'DISABLE_UPDATES', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'TERM'];
  appendFileSync(join(dir, 'fake-calls.jsonl'), `${JSON.stringify({
    argv, cwd: process.cwd(), pid: process.pid, tty: Boolean(process.stdin.isTTY && process.stdout.isTTY), envNames: Object.keys(process.env).sort(),
    env: Object.fromEntries(shown.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])), ...extra,
  })}\n`, { mode: 0o600 });
}

const scenario = (client: FakeClient) => readHome(client, 'fake-scenario');
const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);
const forever = () => new Promise<never>(() => setInterval(() => undefined, 60_000));

/** Drops Codex's global `-c key=value` options, as the real CLI accepts them before a subcommand. */
function command(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-c' || argv[i] === '--config') { i += 1; continue; }
    out.push(argv[i]!);
  }
  return out;
}

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins';

function authorizeUrl(flags: string[], state: string): string {
  const base = flags.includes('--console') ? 'https://platform.claude.com/oauth/authorize' : 'https://claude.com/cai/oauth/authorize';
  const query = new URLSearchParams({
    code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: 'https://platform.claude.com/oauth/code/callback', scope: SCOPES,
    code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'), code_challenge_method: 'S256', state,
  });
  if (flags.includes('--sso')) query.set('login_method', 'sso');
  const email = flags.indexOf('--email');
  if (email !== -1 && flags[email + 1]) query.set('login_hint', flags[email + 1]!);
  return `${base}?${query.toString().replace(/%20/g, '+')}`;
}

/** Lines from the input, as the CLI's prompt reads them (a terminal's line discipline echoes and edits). */
function lineReader() {
  let pending = '';
  let ended = false;
  const waiting: Array<() => void> = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => { pending += chunk; waiting.splice(0).forEach((wake) => wake()); });
  process.stdin.on('end', () => { ended = true; waiting.splice(0).forEach((wake) => wake()); });
  return async (): Promise<string | null> => {
    for (;;) {
      const end = pending.search(/[\r\n]/);
      if (end !== -1) { const line = pending.slice(0, end); pending = pending.slice(end + 1); return line; }
      if (ended) return null;
      await new Promise<void>((wake) => waiting.push(wake));
    }
  };
}

function writeProfile(secret: string) {
  mkdirSync(join(profileDir(), 'configs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(profileDir(), 'configs', 'default.json'), JSON.stringify({ authentication: { type: 'oauth', access_token: `sk-ant-oat01-${secret}`, refresh_token: `sk-ant-ort01-${secret}` } }), { mode: 0o600 });
  writeFileSync(join(profileDir(), 'active_config'), 'default', { mode: 0o600 });
}

async function claudeLogin(argv: string[], flags: string[]): Promise<number> {
  const mode = scenario('claude_code');
  if (flags.includes('--console') && flags.includes('--claudeai')) { err('Error: --console and --claudeai cannot be used together.\n'); return 1; }
  const state = randomBytes(32).toString('base64url');
  const url = authorizeUrl(flags, state);
  const shown = process.stdout.isTTY ? `\u001b]8;;${url}\u0007\u001b[94m${url}\u001b[39m\u001b]8;;\u0007` : url;
  out(`Opening browser to sign in…\nIf the browser didn't open, visit: ${shown}\nPaste code here if prompted > `);
  if (mode === 'login_hangs') await forever();
  if (mode === 'login_timeout') {
    await new Promise((wait) => setTimeout(wait, Number(process.env.FAKE_LOGIN_TIMEOUT_MS) || 300));
    err('Login failed: timed out waiting for the authorization code\n');
    return 1;
  }
  const next = lineReader();
  let accepted = '';
  for (;;) {
    const line = await next();
    if (line === null) await forever(); // closed input: the real CLI keeps waiting (for the browser's callback)
    if (line === null) return 1;
    const [code = '', pastedState = '', ...rest] = line.trim().split('#');
    record('claude_code', argv, { event: 'code', code: line.trim() });
    if (!code || !pastedState || rest.length || pastedState !== state) { err('Invalid code. Please make sure the full code was copied.\n'); continue; }
    accepted = code;
    break;
  }
  // A pasted code that starts `fake-reject-` fails the exchange like login_failed: a browser test cannot seed
  // `fake-scenario` (the binding home exists only after the console starts), so the code itself selects it.
  if (mode === 'login_failed' || accepted.startsWith('fake-reject-')) { err('Login failed: Request failed with status code 400\n'); return 1; }
  const secret = readHome('claude_code', 'fake-secret') || 'fake-secret-not-seeded';
  const method = flags.includes('--console') ? 'console' : flags.includes('--sso') ? 'sso' : 'claude_account';
  if (mode === 'console_profile' && method === 'console') writeProfile(secret);
  else if (mode !== 'login_without_credentials') {
    writeFileSync(credentials('claude_code'), JSON.stringify({ fakeMethod: method, claudeAiOauth: {
      accessToken: `sk-ant-oat01-${secret}`, refreshToken: `sk-ant-ort01-${secret}`, expiresAt: Date.now() + 3_600_000,
      scopes: SCOPES.split(' '), subscriptionType: method === 'sso' ? 'enterprise' : 'max',
    } }), { mode: 0o600 });
  }
  if (mode !== 'login_without_credentials' && !readHome('claude_code', 'fake-account')) writeFileSync(join(home('claude_code'), 'fake-account'), 'owner@example.org', { mode: 0o600 });
  out('Login successful.\n');
  return 0;
}

/** `auth status` as the real CLI prints it (2.1.285 key set and order), from the fake's own login. */
function claudeStatus(text: boolean): { body: string; loggedIn: boolean } {
  const configDirectory = home('claude_code');
  const stored = existsSync(credentials('claude_code'));
  const loggedIn = stored || hasProfile();
  if (!loggedIn) {
    return { loggedIn, body: text ? 'Not logged in. Run claude auth login to authenticate.\n' : `${JSON.stringify({
      loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', analyticsDisabled: Boolean(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC),
      projectsDirectory: join(configDirectory, 'projects'), configDirectory }, null, 2)}\n` };
  }
  let method = stored ? 'claude_account' : 'console';
  try { method = (JSON.parse(readFileSync(credentials('claude_code'), 'utf8')) as { fakeMethod?: string }).fakeMethod ?? method; } catch { /* keep the default */ }
  const account = readHome('claude_code', 'fake-account') || null;
  const managedKey = method === 'console';
  if (text) return { loggedIn, body: managedKey ? 'Login method: Anthropic Console account\n' : `Login method: Claude ${method === 'sso' ? 'Enterprise' : 'Max'} account\n` };
  return { loggedIn, body: `${JSON.stringify({
    loggedIn: true, authMethod: managedKey ? 'api_key' : 'claude.ai', apiProvider: 'firstParty',
    analyticsDisabled: Boolean(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC), projectsDirectory: join(configDirectory, 'projects'), configDirectory,
    email: account, orgId: account ? `org-${account.split('@')[1] ?? 'none'}` : null, orgName: account ? `${account.split('@')[1] ?? 'none'} organization` : null,
    ...(managedKey ? {} : { subscriptionType: method === 'sso' ? 'enterprise' : 'max' }),
  }, null, 2)}\n` };
}

/** Codex `login --device-auth`: the real banner (ANSI colours as the CLI emits them), then the poll. */
async function codexDeviceLogin(argv: string[]): Promise<number> {
  const mode = scenario('codex');
  // The account has not turned on device code sign-in: the user-code request answers 404 (codex-rs
  // `login/src/device_code_auth.rs`), before any banner, and `codex login` reports it on stderr.
  if (mode === 'device_auth_disabled') {
    err('Error logging in with device code: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.\n');
    return 1;
  }
  const grey = (text: string) => `\u001b[90m${text}\u001b[0m`;
  const blue = (text: string) => `\u001b[94m${text}\u001b[0m`;
  const issuer = 'https://auth.openai.com';
  const userCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase().slice(0, 5)}`;
  out(`\nWelcome to Codex [v${grey('0.160.1')}]\n${grey("OpenAI's command-line coding agent")}\n\n`
    + 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n'
    + `1. Open this link in your browser and sign in to your account\n   ${blue(`${issuer}/codex/device`)}\n\n`
    + `2. Enter this one-time code ${grey('(expires in 15 minutes)')}\n   ${blue(userCode)}\n\n`
    + `${grey('Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.')}\n\n`);
  record('codex', argv, { event: 'device_code', userCode });
  if (mode === 'login_hangs') await forever();
  await new Promise((wait) => setTimeout(wait, Number(process.env.FAKE_LOGIN_TIMEOUT_MS) || 300));
  if (mode === 'login_timeout') { err('Error logging in with device code: device auth timed out after 15 minutes\n'); return 1; }
  if (mode === 'login_failed') { err('Error logging in with device code: device auth failed with status 500 Internal Server Error\n'); return 1; }
  const secret = readHome('codex', 'fake-secret') || 'fake-secret-not-seeded';
  const token = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ email: 'owner@example.org', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })).toString('base64url')}.sig`;
  if (mode !== 'login_without_credentials') {
    writeFileSync(credentials('codex'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: token, access_token: `${token}.${secret}`, refresh_token: `rt-${secret}`, account_id: null }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
  }
  err('Successfully logged in\n');
  return 0;
}

/** The values after a flag up to the next `--` flag (`--allowedTools a b c`). */
function flagValues(argv: string[], flag: string): string[] {
  const at = argv.indexOf(flag);
  if (at === -1) return [];
  const values: string[] = [];
  for (let i = at + 1; i < argv.length && !argv[i]!.startsWith('--'); i += 1) values.push(argv[i]!);
  return values;
}

/** `${VAR}` in an MCP header, from the CLI's own environment (as Claude Code expands it). */
const expand = (value: string) => value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => process.env[name] ?? '');

interface RunScript {
  calls?: { name: string; args?: Record<string, unknown> }[];
  probes?: { name: string; args?: Record<string, unknown> }[];
  answer?: string;
  /** A pause before each call after the first (a model thinking between turns). */
  delayMs?: number;
}

/**
 * `claude -p --output-format stream-json …` (F-022 T5): reads the prompt on stdin, connects to the Flux MCP
 * server named in `--mcp-config` with the Authorization header that config names (expanding
 * `${FLUX_RUN_TOKEN}` from its environment), prints `system/init` with the tools that server lists, makes
 * REAL MCP calls and prints a `result`. A run script in the home (`fake-run.json`) chooses the calls, the
 * answer (`{{results}}` is replaced by what the calls returned) and silent `probes` (calls made without a
 * tool-use event, as a CLI ignoring its permissions would). Every MCP answer is recorded in
 * `fake-calls.jsonl` (the token never is). Scenarios: run_extra_tool, run_extra_server, run_expired_login,
 * run_plan_limit, run_model_unavailable, run_hang (no event after init), run_slow (events forever, never a result), run_crash,
 * run_big_answer, run_secret_answer, run_broken_stream, run_ignore_sigint, run_max_turns. Without
 * `--no-session-persistence` it writes a transcript under `projects/`, as the real CLI would.
 */
async function claudeRun(argv: string[]): Promise<number> {
  const mode = scenario('claude_code');
  const emit = (event: Record<string, unknown>) => out(`${JSON.stringify(event)}\n`);
  let stopping = false;
  process.on('SIGINT', () => { if (mode === 'run_ignore_sigint') return; stopping = true; process.exit(130); });
  process.on('SIGTERM', () => process.exit(143));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const prompt = Buffer.concat(chunks).toString('utf8');
  const configPath = argv[argv.indexOf('--mcp-config') + 1] ?? '';
  const server = (JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> }).mcpServers.flux!;
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([name, value]) => [name.toLowerCase(), expand(value)]));
  const token = process.env.FLUX_RUN_TOKEN ?? '';
  record('claude_code', argv, { event: 'run', promptBytes: prompt.length, prompt, allowed: flagValues(argv, '--allowedTools'),
    authorization: headers.authorization === undefined ? 'none' : token && headers.authorization === `Bearer ${token}` ? 'run_token' : 'other',
    persist: !argv.includes('--no-session-persistence') });
  if (!argv.includes('--no-session-persistence')) {
    mkdirSync(join(home('claude_code'), 'projects', 'flux-run'), { recursive: true });
    writeFileSync(join(home('claude_code'), 'projects', 'flux-run', 'session.jsonl'), `${JSON.stringify({ type: 'user', prompt })}\n`);
  }
  let id = 0;
  const mcp = async (method: string, params: Record<string, unknown>) => {
    const name = typeof params.name === 'string' ? params.name : null;
    const response = await fetch(server.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'fake-claude', version: '2.1.285' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const text = await response.text();
    let body: { result?: Record<string, unknown>; error?: { message?: string } } = {};
    try { body = JSON.parse(text) as typeof body; } catch { /* a refusal without JSON */ }
    return { status: response.status, body };
  };
  const listed = await mcp('tools/list', {}).catch(() => ({ status: 0, body: {} as { result?: Record<string, unknown> } }));
  const names = listed.status === 200 && Array.isArray(listed.body.result?.tools) ? (listed.body.result!.tools as { name: string }[]).map((tool) => tool.name) : [];
  record('claude_code', argv, { event: 'tools_list', status: listed.status, tools: names });
  const session = randomBytes(8).toString('hex');
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, model: 'claude-fake', permissionMode: 'dontAsk', apiKeySource: 'none',
    claude_code_version: '2.1.285', output_style: 'default', slash_commands: [], agents: [], skills: [], plugins: [], uuid: randomBytes(16).toString('hex'),
    tools: [...names.map((name) => `mcp__flux__${name}`), ...(mode === 'run_extra_tool' ? ['Bash'] : [])],
    // The field set of the pinned real CLI's `system/init` (2.1.285, observed 2026-10-16 against the scripted model).
    mcp_servers: [{ name: 'flux', status: listed.status === 200 ? 'connected' : 'failed', source: 'dynamic' },
      ...(mode === 'run_extra_server' ? [{ name: 'other', status: 'connected', source: 'dynamic' }] : [])] });
  if (mode === 'run_crash') { err('fake claude: crashed\n'); return 1; }
  if (mode === 'run_broken_stream') { out('{"type":"assistant","message":{"content":[{"type":"te'); return 0; }
  if (mode === 'run_hang') await forever();
  if (mode === 'run_slow') { for (;;) { emit({ type: 'stream_event', event: { type: 'ping' }, session_id: session }); await new Promise((wait) => setTimeout(wait, 500)); } }
  if (mode === 'run_ignore_sigint') { for (;;) { emit({ type: 'stream_event', event: { type: 'ping' }, session_id: session }); await new Promise((wait) => setTimeout(wait, 500)); } }
  if (mode === 'run_expired_login') { emit({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', num_turns: 1, session_id: session }); return 1; }
  if (mode === 'run_plan_limit') { emit({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1791374400', num_turns: 1, session_id: session }); return 1; }
  if (mode === 'run_model_unavailable') {
    emit({ type: 'result', subtype: 'success', is_error: true, result: "There's an issue with the selected model (opus). It may not exist or you may not have access to it. Run /model to pick a different model.", num_turns: 1, session_id: session });
    return 1;
  }
  if (mode === 'run_max_turns') { emit({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 10, session_id: session }); return 1; }
  let script: RunScript = {};
  try { script = JSON.parse(readHome('claude_code', 'fake-run.json') || '{}') as RunScript; } catch { /* no script */ }
  const results: { name: string; isError: boolean; text: string }[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await mcp('tools/call', { name, arguments: args });
    const content = answer.body.result?.content;
    const text = Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? '')).join('\n') : answer.body.error?.message ?? '';
    const isError = answer.status !== 200 || answer.body.result?.isError === true || answer.body.error !== undefined;
    record('claude_code', argv, { event: 'tool_result', name, status: answer.status, isError, text });
    return { name, isError, text };
  };
  for (const probe of script.probes ?? []) await call(probe.name, probe.args ?? {});
  for (const [index, planned] of (script.calls ?? [{ name: 'flux_list_contexts' }]).entries()) {
    if (stopping) return 130;
    if (index > 0 && script.delayMs) await new Promise((wait) => setTimeout(wait, Math.min(script.delayMs!, 30_000)));
    const useId = `toolu_${index + 1}`;
    emit({ type: 'assistant', session_id: session, message: { id: `msg_${index + 1}`, role: 'assistant', content: [{ type: 'tool_use', id: useId, name: `mcp__flux__${planned.name}`, input: planned.args ?? {} }] } });
    const result = await call(planned.name, planned.args ?? {});
    results.push(result);
    emit({ type: 'user', session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: result.text, is_error: result.isError }] } });
  }
  let answer = (script.answer ?? 'Done: I read {{count}} things in this project.').replace('{{count}}', String(results.length)).replace('{{results}}', JSON.stringify(results));
  if (mode === 'run_big_answer') answer = 'x'.repeat(20 * 1024);
  if (mode === 'run_secret_answer') answer = `Here: sk-ant-api03-${randomBytes(12).toString('hex')} and the token ${token} and Bearer ${token}.`;
  emit({ type: 'result', subtype: 'success', is_error: false, result: answer, num_turns: results.length + 1, session_id: session, total_cost_usd: 0 });
  return 0;
}

/** Codex's `-c key=value` options as a nested object, with TOML-ish values (booleans, numbers, JSON strings and arrays, else a bare string). */
function codexOverrides(argv: string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '-c' && argv[i] !== '--config') continue;
    const pair = argv[i + 1] ?? '';
    i += 1;
    const at = pair.indexOf('=');
    if (at < 1) continue;
    const raw = pair.slice(at + 1);
    let value: unknown = raw;
    if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (/^["[]/.test(raw)) { try { value = JSON.parse(raw); } catch { value = raw; } }
    const keys = pair.slice(0, at).split('.');
    let node = root;
    for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
    node[keys.at(-1)!] = value;
  }
  return root;
}

/** One MCP call over the streamable HTTP route, as a client with the given headers. */
function mcpClient(url: string, headers: Record<string, string>, clientName: string, version: string) {
  let id = 0;
  return async (method: string, params: Record<string, unknown>) => {
    const name = typeof params.name === 'string' ? params.name : null;
    const response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: clientName, version }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const text = await response.text();
    let body: { result?: Record<string, unknown>; error?: { message?: string } } = {};
    try { body = JSON.parse(text) as typeof body; } catch { /* a refusal without JSON */ }
    return { status: response.status, body };
  };
}

/**
 * `codex exec --json … -` (F-022 T6 #281), with the event and item shapes of the pinned CLI (codex-rs
 * `exec/src/exec_events.rs` at rust-v0.160.1): reads the prompt on stdin, connects to the `flux` MCP server
 * its `-c` options name with the bearer token from the variable they name, lists the tools `enabled_tools`
 * leaves, makes REAL MCP calls and prints `thread.started`, `turn.started`, `item.*` and `turn.completed`.
 * Like the real CLI, a tool its overrides did not switch off is used: without `features.shell_tool=false`
 * it runs a command (a `command_execution` item). Run script (`fake-run.json`) as for the fake `claude`.
 * Scenarios: run_command_execution, run_file_change, run_web_search, run_other_mcp, run_resource_tool,
 * run_todo_list, run_plan_limit, run_expired_login, run_model_unavailable, run_hang, run_slow, run_crash, run_broken_stream,
 * run_ignore_sigint, run_big_answer, run_secret_answer, run_error_item. Without `--ephemeral` it writes a
 * session under `sessions/`, as the real CLI would.
 */
async function codexRun(argv: string[]): Promise<number> {
  const mode = scenario('codex');
  const emit = (event: Record<string, unknown>) => out(`${JSON.stringify(event)}\n`);
  let stopping = false;
  process.on('SIGINT', () => { if (mode === 'run_ignore_sigint') return; stopping = true; process.exit(130); });
  process.on('SIGTERM', () => process.exit(143));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const prompt = Buffer.concat(chunks).toString('utf8');
  const config = codexOverrides(argv);
  const features = (config.features ?? {}) as Record<string, unknown>;
  const flux = ((config.mcp_servers ?? {}) as Record<string, Record<string, unknown>>).flux ?? {};
  const tokenVariable = typeof flux.bearer_token_env_var === 'string' ? flux.bearer_token_env_var : '';
  const token = tokenVariable ? process.env[tokenVariable] ?? '' : '';
  const enabled = Array.isArray(flux.enabled_tools) ? (flux.enabled_tools as string[]) : null;
  record('codex', argv, { event: 'run', promptBytes: prompt.length, prompt, allowed: enabled ?? [], overrides: config,
    authorization: !tokenVariable ? 'none' : token && token === process.env.FLUX_RUN_TOKEN ? 'run_token' : 'other', persist: !argv.includes('--ephemeral') });
  if (!argv.includes('--ephemeral')) {
    mkdirSync(join(home('codex'), 'sessions', '2026'), { recursive: true });
    writeFileSync(join(home('codex'), 'sessions', '2026', 'rollout.jsonl'), `${JSON.stringify({ type: 'user', prompt })}\n`);
  }
  const mcp = mcpClient(String(flux.url ?? ''), token ? { authorization: `Bearer ${token}` } : {}, 'fake-codex', '0.160.1');
  const listed = await mcp('tools/list', {}).catch(() => ({ status: 0, body: {} as { result?: Record<string, unknown> } }));
  const served = listed.status === 200 && Array.isArray(listed.body.result?.tools) ? (listed.body.result!.tools as { name: string }[]).map((tool) => tool.name) : [];
  const names = enabled ? served.filter((name) => enabled.includes(name)) : served;
  record('codex', argv, { event: 'tools_list', status: listed.status, tools: names });
  emit({ type: 'thread.started', thread_id: randomBytes(8).toString('hex') });
  emit({ type: 'turn.started' });
  if (flux.required === true && listed.status !== 200) {
    emit({ type: 'error', message: 'MCP server `flux` failed to start' });
    emit({ type: 'turn.failed', error: { message: 'required MCP servers failed to initialize: flux' } });
    return 1;
  }
  let item = 0;
  const next = () => `item_${item++}`;
  const local = (kind: string, fields: Record<string, unknown>) => {
    const id = next();
    emit({ type: 'item.started', item: { id, type: kind, ...fields, status: 'in_progress' } });
    record('codex', argv, { event: 'local_item', kind });
  };
  if (mode === 'run_crash') { err('fake codex: crashed\n'); return 1; }
  if (mode === 'run_broken_stream') { out('{"type":"item.completed","item":{"id":"item_0","type":"agent_mes'); return 0; }
  if (mode === 'run_hang') await forever();
  if (mode === 'run_slow' || mode === 'run_ignore_sigint') {
    for (;;) { emit({ type: 'item.updated', item: { id: 'item_r', type: 'reasoning', text: 'Thinking…' } }); await new Promise((wait) => setTimeout(wait, 500)); }
  }
  if (mode === 'run_expired_login') {
    const message = 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.';
    emit({ type: 'error', message });
    emit({ type: 'turn.failed', error: { message } });
    return 1;
  }
  if (mode === 'run_model_unavailable') {
    const message = 'The model `gpt-6-astra` does not exist or you do not have access to it.';
    emit({ type: 'error', message });
    emit({ type: 'turn.failed', error: { message } });
    return 1;
  }
  if (mode === 'run_plan_limit') {
    const message = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.';
    emit({ type: 'error', message });
    emit({ type: 'turn.failed', error: { message } });
    return 1;
  }
  // A local tool the overrides left on, or a scenario's own: the real CLI would use it.
  if (features.shell_tool !== false || mode === 'run_command_execution') local('command_execution', { command: 'cat ~/.codex/auth.json', aggregated_output: '', exit_code: null });
  else if (mode === 'run_file_change') local('file_change', { changes: [{ path: 'notes.md', kind: 'add' }] });
  else if (mode === 'run_web_search' || config.web_search !== 'disabled') local('web_search', { query: 'flux', action: { type: 'search', query: 'flux' } });
  else if (mode === 'run_other_mcp') local('mcp_tool_call', { server: 'github', tool: 'search_issues', arguments: {}, result: null, error: null });
  else if (mode === 'run_resource_tool') local('mcp_tool_call', { server: 'flux', tool: 'read_mcp_resource', arguments: { server: 'flux', uri: 'flux://playbook/flux.cowork/1.0.0' }, result: null, error: null });
  else if (mode === 'run_todo_list') emit({ type: 'item.started', item: { id: next(), type: 'todo_list', items: [{ text: 'Read', completed: false }] } });
  else if (mode === 'run_error_item') emit({ type: 'item.completed', item: { id: next(), type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting(s).' } });
  let script: RunScript = {};
  try { script = JSON.parse(readHome('codex', 'fake-run.json') || '{}') as RunScript; } catch { /* no script */ }
  const results: { name: string; isError: boolean; text: string }[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await mcp('tools/call', { name, arguments: args });
    const content = answer.body.result?.content;
    const text = Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? '')).join('\n') : answer.body.error?.message ?? '';
    const isError = answer.status !== 200 || answer.body.result?.isError === true || answer.body.error !== undefined;
    record('codex', argv, { event: 'tool_result', name, status: answer.status, isError, text });
    return { name, isError, text, content };
  };
  for (const probe of script.probes ?? []) await call(probe.name, probe.args ?? {});
  emit({ type: 'item.completed', item: { id: next(), type: 'reasoning', text: 'Reading the project through Flux.' } });
  for (const [index, planned] of (script.calls ?? [{ name: 'flux_list_contexts' }]).entries()) {
    if (stopping) return 130;
    if (index > 0 && script.delayMs) await new Promise((wait) => setTimeout(wait, Math.min(script.delayMs!, 30_000)));
    const id = next();
    const base = { id, type: 'mcp_tool_call', server: 'flux', tool: planned.name, arguments: planned.args ?? {} };
    emit({ type: 'item.started', item: { ...base, result: null, error: null, status: 'in_progress' } });
    const result = await call(planned.name, planned.args ?? {});
    results.push(result);
    emit({ type: 'item.completed', item: { ...base, result: result.isError ? null : { content: result.content ?? [], structured_content: null },
      error: result.isError ? { message: result.text } : null, status: result.isError ? 'failed' : 'completed' } });
  }
  let answer = (script.answer ?? 'Done: I read {{count}} things in this project.').replace('{{count}}', String(results.length)).replace('{{results}}', JSON.stringify(results.map(({ name, isError, text }) => ({ name, isError, text }))));
  if (mode === 'run_big_answer') answer = 'x'.repeat(20 * 1024);
  if (mode === 'run_secret_answer') answer = `Here: sk-proj-${randomBytes(12).toString('hex')} and the token ${token} and Bearer ${token}.`;
  emit({ type: 'item.completed', item: { id: next(), type: 'agent_message', text: answer } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 0 } });
  return 0;
}

/**
 * `codex app-server` (codex-rs `app-server-protocol` at rust-v0.160.1): JSON-RPC over stdio without the
 * `jsonrpc` field, one message per line. Answers `initialize`, `config/read` (the effective configuration:
 * here exactly the root `-c` overrides, as the pinned server merges them as its session-flags layer) and
 * `account/rateLimits/read` (from `fake-rate-limits.json` in the home, or a limit reached with a reset).
 * Every method it receives is recorded, so tests see that Flux sends nothing else. Scenarios:
 * config_ignores_overrides (config/read without the `-c` layer), rate_limits_unreadable (an error).
 */
async function codexAppServer(argv: string[]): Promise<number> {
  const mode = scenario('codex');
  const config = codexOverrides(argv);
  let initialized = false;
  const reply = (message: Record<string, unknown>) => out(`${JSON.stringify(message)}\n`);
  const next = lineReader();
  for (;;) {
    const line = await next();
    if (line === null) return 0;
    if (!line.trim()) continue;
    let message: { id?: number; method?: string; params?: unknown };
    try { message = JSON.parse(line) as typeof message; } catch { continue; }
    record('codex', argv, { event: 'app_server', method: message.method ?? null });
    if (message.id === undefined) continue;
    if (message.method === 'initialize') {
      if (initialized) { reply({ id: message.id, error: { code: -32600, message: 'Already initialized' } }); continue; }
      initialized = true;
      reply({ id: message.id, result: { userAgent: 'codex_cli_rs/0.160.1 (fake)', codexHome: home('codex'), platformFamily: 'unix', platformOs: 'linux' } });
      continue;
    }
    if (!initialized) { reply({ id: message.id, error: { code: -32600, message: 'Not initialized' } }); continue; }
    if (message.method === 'config/read') { reply({ id: message.id, result: { config: mode === 'config_ignores_overrides' ? {} : config, origins: {} } }); continue; }
    if (message.method === 'account/rateLimits/read') {
      if (mode === 'rate_limits_unreadable') { reply({ id: message.id, error: { code: -32603, message: 'failed to fetch rate limits' } }); continue; }
      let rateLimits: unknown = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791374400 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1791900000 }, planType: 'plus' };
      try { rateLimits = JSON.parse(readHome('codex', 'fake-rate-limits.json') || 'null') ?? rateLimits; } catch { /* default */ }
      reply({ id: message.id, result: { rateLimits } });
      continue;
    }
    // A real app-server has many more methods (command/exec among them); the fake answers none of them.
    reply({ id: message.id, error: { code: -32601, message: `fake app-server: ${String(message.method).slice(0, 40)} not implemented` } });
  }
}

/** `codex login --with-api-key` / `--with-access-token`: the credential is read from stdin to its end. */
async function codexStdinLogin(argv: string[], kind: 'api_key' | 'access_token'): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const value = Buffer.concat(chunks).toString('utf8').trim();
  record('codex', argv, { event: 'stdin_login', kind, bytes: value.length });
  if (!value) { err('Error: no credential on stdin\n'); return 1; }
  writeFileSync(credentials('codex'), JSON.stringify(kind === 'api_key' ? { auth_mode: 'apikey', OPENAI_API_KEY: value } : { auth_mode: 'access_token', access_token: value }), { mode: 0o600 });
  err('Successfully logged in\n');
  return 0;
}

export async function fakeCli(client: FakeClient, argv: string[]): Promise<number> {
  const words = command(argv);
  const key = words.join(' ');
  const flags = words.filter((word) => word.startsWith('-'));
  record(client, argv);
  if (client === 'claude_code' && words[0] === '-p') return claudeRun(argv);
  if (client === 'claude_code' && words[0] === 'auth' && words[1] === 'login' && !flags.includes('--help')) return claudeLogin(argv, words.slice(2));
  if (client === 'codex' && key === 'login --device-auth') return codexDeviceLogin(argv);
  if (client === 'codex' && key === 'login --with-api-key') return codexStdinLogin(argv, 'api_key');
  if (client === 'codex' && key === 'login --with-access-token') return codexStdinLogin(argv, 'access_token');
  if (client === 'codex' && words[0] === 'exec' && words.includes('--json')) return codexRun(argv);
  if (client === 'codex' && key === 'app-server') return codexAppServer(argv);
  const mode = scenario(client);
  if (key === '--version') { out(client === 'claude_code' ? '2.1.285 (Claude Code) [fake]\n' : 'codex-cli 0.160.1 [fake]\n'); return 0; }
  const help = GOLDEN_HELP[client][words.filter((word) => word !== '-h' && word !== '--help').concat('--help').join(' ')];
  if (help && (flags.includes('--help') || flags.includes('-h') || key === 'auth')) { out(help); return 0; }
  if (client === 'claude_code' && words[0] === 'auth' && words[1] === 'status') {
    const status = claudeStatus(words.includes('--text'));
    out(status.body);
    return status.loggedIn ? 0 : 1;
  }
  if (client === 'claude_code' && key === 'auth logout') {
    if (mode === 'logout_fails') { err('Logout failed: Request failed with status code 503\n'); return 1; }
    if (mode === 'logout_hangs') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000); return 1; }
    rmSync(credentials(client), { force: true });
    rmSync(profileDir(), { recursive: true, force: true });
    out('Successfully logged out from your Anthropic account.\n');
    return 0;
  }
  // Codex writes its status and logout lines to stderr, never stdout.
  if (client === 'codex' && key === 'login status') {
    if (!existsSync(credentials(client))) { err('Not logged in\n'); return 1; }
    let mode = 'chatgpt';
    try { mode = String((JSON.parse(readFileSync(credentials(client), 'utf8')) as { auth_mode?: string }).auth_mode ?? mode); } catch { /* the default */ }
    err(mode === 'apikey' ? 'Logged in using an API key - sk-proj-***\n' : mode === 'access_token' ? 'Logged in using access token\n' : 'Logged in using ChatGPT\n');
    return 0;
  }
  if (client === 'codex' && key === 'logout') {
    if (mode === 'logout_fails') { err('Error logging out: could not reach the auth server\n'); return 1; }
    if (mode === 'logout_hangs') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000); return 1; }
    if (!existsSync(credentials(client))) { err('Not logged in\n'); return 0; }
    rmSync(credentials(client), { force: true });
    err('Successfully logged out\n');
    return 0;
  }
  err(`fake ${client}: not implemented: ${key.slice(0, 80)}\n`);
  return 2;
}
