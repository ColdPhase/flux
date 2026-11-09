// TEST ONLY (#1125, scripts/check_cli_runtime.sh): the REAL pinned Codex of the runtime image, started exactly as the supervisor
// starts a run (RUN_TEMPLATES.codex, cliEnvironment, the prompt on stdin), against the vendor mock, for what Flux cannot reach
// through a run while #1127 stops every Codex run at its first event: a token refresh, the usage limit with the plan's reset time
// read through Flux's own app-server client, an over-long prompt, a revoked sign-in and a `web_search` item. Its texts go through
// Flux's own classifier. Run in the runtime container under a user id no person has: `node /opt/flux-cli-mock/codex-contract.mjs`.
/* global fetch, setTimeout, clearTimeout, console */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const dist = '/opt/flux-runtime/apps/runtime/dist/supervisor';
const { CLI_PATHS, RUN_TEMPLATES, cliEnvironment } = await import(`${dist}/templates.js`);
const { classifyCodexError, RUN_BRIEF } = await import(`${dist}/run.js`);
const { openAppServer, readRateLimits, readUsage } = await import(`${dist}/app-server.js`);

const mockUrl = 'http://providermock:8095';
const codex = CLI_PATHS.codex;
const tools = ['flux_get_conversation'];
const mcpUrl = `${mockUrl}/cli/mcp`;

async function mock(path, body) {
  const response = await fetch(`${mockUrl}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, path);
  return response.json();
}
const journal = async () => (await mock('/__cli/journal')).journal;
const since = async (n) => (await journal()).filter((entry) => entry.n > n);
const last = async () => (await journal()).at(-1)?.n ?? 0;

const dir = await mkdtemp('/tmp/codex-contract-');
for (const name of ['codex', 'home', 'tmp']) await mkdir(join(dir, name), { mode: 0o700 });
const env = cliEnvironment('codex', dir, 'runtime-egress', { FLUX_RUN_TOKEN: 'not-a-flux-token' });

/** Codex's device sign-in, approved at the mock issuer once the code is printed. */
function signIn() {
  return new Promise((resolve, reject) => {
    const child = spawn(codex, ['-c', 'cli_auth_credentials_store=file', 'login', '--device-auth'], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let approved = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`sign-in timed out: ${out}`)); }, 60_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (!approved && out.includes('cancel.')) { approved = true; mock('/__cli/approve', {}).catch(reject); }
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out); else reject(new Error(`sign-in exited ${code}: ${out}`));
    });
  });
}

/** One run as the supervisor starts it; its JSONL events. */
function run(prompt) {
  const argv = RUN_TEMPLATES.codex({ tools, caps: { maxTurns: 6 }, mcpConfigPath: '', mcpUrl, brief: RUN_BRIEF, model: 'gpt-6.1-sol' });
  return new Promise((resolve) => {
    const child = spawn(codex, argv, { env, cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stdin.end(prompt);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, events: out.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)) });
    });
  });
}
const items = (events) => events.filter((event) => event.type === 'item.completed').map((event) => event.item);
const failure = (events) => events.find((event) => event.type === 'turn.failed')?.error?.message ?? '';
const say = (key, value) => console.log(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);

try {
  // A sign-in whose access token is about to expire, so the first run refreshes it (codex-rs: within five minutes of `exp`).
  await mock('/__cli/script', { client: 'codex', steps: [], accessLifetimeSeconds: 60 });
  let from = await last();
  await signIn();
  await mock('/__cli/script', { client: 'codex', steps: [{ text: 'Done.' }], accessLifetimeSeconds: 3600 });
  const refreshed = await run('Say done.');
  let entries = await since(from);
  const order = entries.filter((entry) => ['code_exchange', 'refresh', 'main'].includes(entry.kind)).map((entry) => `${entry.kind}${entry.detail?.known === false ? ':unknown' : ''}`);
  assert.deepEqual(order.slice(0, 3), ['code_exchange', 'refresh', 'main'], `the first run refreshed the token before its model request: ${order}`);
  assert.ok(refreshed.events.some((event) => event.type === 'turn.completed'), JSON.stringify(refreshed.events).slice(0, 800));
  // #1127: the first item is Codex's own error about code mode, which Flux's run reader stops as a local tool.
  assert.equal(items(refreshed.events)[0]?.type, 'error', 'the code mode error item is still there (#1127)');
  say('CODEX_REFRESH', 'ok');

  // The usage limit: the model request answers 429 `usage_limit_reached`; Flux's classifier says plan_limit and its app-server
  // client reads the reset time from the plan's usage.
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  await mock('/__cli/script', { client: 'codex', usage: { usedPercent: 100, resetsAt }, steps: [{ error: { status: 429,
    body: { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: resetsAt } } } }] });
  from = await last();
  const limited = await run('Say done.');
  const limitText = failure(limited.events);
  assert.notEqual(limited.code, 0);
  assert.equal(classifyCodexError(limitText), 'plan_limit', limitText);
  const session = await openAppServer(codex, dir, 'runtime-egress', { timeoutMs: 15_000, person: null });
  let read;
  try { read = await session.request('account/rateLimits/read', {}); } finally { session.close(); }
  assert.deepEqual(readRateLimits(read), { limited: true, resetsAt: new Date(resetsAt * 1000).toISOString() }, JSON.stringify(read));
  assert.equal(readUsage(read)?.leftPercent, 0);
  assert.ok((await since(from)).some((entry) => entry.client === 'chatgpt' && entry.kind === '/wham/usage'), 'the usage came from the ChatGPT backend');
  say('CODEX_USAGE_LIMIT', { text: limitText, outcome: 'plan_limit', resetsAt: new Date(resetsAt * 1000).toISOString() });

  // An over-long prompt: the stream ends with `response.failed` `context_length_exceeded`.
  await mock('/__cli/script', { client: 'codex', usage: { usedPercent: 12 }, steps: [{ failed: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } }] });
  const overflow = await run('Say done.');
  const overflowText = failure(overflow.events);
  assert.match(overflowText, /context window/i);
  say('CODEX_CONTEXT', { text: overflowText, outcome: classifyCodexError(overflowText) });

  // Codex's own web search (off in Flux's runs, RT-5): the item it reports is one Flux's run reader stops (only messages, reasoning
  // and the run's Flux tools pass).
  await mock('/__cli/script', { client: 'codex', steps: [{ search: { query: 'camera low light', results: [{ url: 'http://public.test/read/notes', title: 'Notes' }] } }, { text: 'Done.' }] });
  const searched = await run('Search the web.');
  const kinds = items(searched.events).map((item) => item.type);
  assert.ok(kinds.includes('web_search'), JSON.stringify(kinds));
  say('CODEX_WEB_SEARCH_ITEM', kinds);

  // The sign-in was revoked: the model answers 401 and the refresh is refused; Flux's classifier says sign in again.
  // Codex first reloads its login and asks again, then refreshes: every model request answers 401.
  const expired = { error: { status: 401, body: { error: { message: 'Your authentication token has expired. Please try signing in again.', type: 'invalid_request_error', code: 'token_expired' } } } };
  await mock('/__cli/script', { client: 'codex', revokeRefreshTokens: true, steps: [expired, expired, expired, expired] });
  from = await last();
  const revoked = await run('Say done.');
  const revokedText = failure(revoked.events);
  entries = await since(from);
  assert.ok(entries.some((entry) => entry.kind === 'refresh' && entry.detail?.known === false), 'Codex tried to refresh');
  assert.equal(classifyCodexError(revokedText), 'sign_in_again', revokedText);
  say('CODEX_REVOKED', { text: revokedText, outcome: 'sign_in_again' });
} finally {
  await rm(dir, { recursive: true, force: true });
}
