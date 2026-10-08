import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOLDEN_HELP, type GoldenClient } from './goldens.js';

// The one assertion table for sign-in, status and sign-out (F-022 T4 #279, founder direction 2026-10-08).
// It runs unchanged against the TEST ONLY fakes (app/tests/app/agent-runtime-cli-contract.test.ts, in
// the normal checks) and against the pinned REAL CLIs (scripts/check_runtime_cli_contract.sh: in
// `docker run --network none`, no account, opt-in). A difference between fake and real is a failing row,
// so the fakes cannot drift from the vendors' behaviour. Only what the real CLIs were observed to do
// without an account is asserted: no network call is ever made. The device-code banner talks to a mock
// issuer on loopback, which the real Codex reaches through its hidden `--experimental_issuer` flag.

export interface CliTarget { client: GoldenClient; path: string; label: string; /** Extra args after `login --device-auth` that point it at the mock issuer (real Codex only). */ issuerArgs?: (issuer: string) => string[] }
export interface CaseResult { target: string; name: string; ok: boolean; detail: string }

interface Run { code: number | null; stdout: string; stderr: string; timedOut: boolean }
const withoutNoise = (text: string) => text.split('\n').filter((line) => !line.startsWith('WARNING: proceeding, even though we could not create PATH aliases')).join('\n');

function environment(base: string, extra: Record<string, string> = {}) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'),
    DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...extra };
}

/** Runs one command; stdin is closed unless `script` feeds it. Ends the process at `until` or the timeout. */
function run(path: string, args: string[], base: string, options: { script?: (send: (line: string) => void, out: () => string) => Promise<void>; until?: (out: string) => boolean; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(path, args, { env: environment(base), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const done = (code: number | null) => { clearTimeout(timer); resolve({ code, stdout, stderr: withoutNoise(stderr), timedOut }); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 20_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (options.until?.(stdout)) child.kill('SIGKILL'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', done);
    if (options.script) {
      options.script((line) => child.stdin.write(line), () => stdout).then(() => child.kill('SIGKILL'), () => child.kill('SIGKILL'));
    } else child.stdin.end();
  });
}

async function freshBase(): Promise<string> {
  const base = await mkdtemp(join(process.env.FLUX_CONTRACT_TMP ?? tmpdir(), 'flux-auth-table-'));
  for (const dir of ['home', 'claude', 'codex']) await mkdir(join(base, dir), { mode: 0o700 });
  return base;
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const seconds = (ms: number) => Date.now() + ms;
const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

async function seedClaude(base: string) {
  await writeFile(join(base, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'sk-ant-oat01-contract', refreshToken: 'sk-ant-ort01-contract', expiresAt: seconds(36_000_000),
    scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }), { mode: 0o600 });
}

async function seedCodex(base: string) {
  const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email: 'contract@example.org', exp: 4_102_444_800, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc-contract', chatgpt_user_id: 'u-contract' } })}.sig`;
  await writeFile(join(base, 'codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: 'rt-contract', account_id: 'acc-contract' }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
}

function expect(run: Run, wanted: { code: number; stdout?: string | RegExp; stderr?: string | RegExp }): string[] {
  const problems: string[] = [];
  if (run.timedOut) problems.push('timed out');
  if (run.code !== wanted.code) problems.push(`exit ${run.code}, wanted ${wanted.code}`);
  for (const stream of ['stdout', 'stderr'] as const) {
    const want = wanted[stream];
    const got = run[stream];
    if (want === undefined) { if (got !== '') problems.push(`${stream} should be empty, got ${JSON.stringify(got.slice(0, 120))}`); continue; }
    if (typeof want === 'string' ? got !== want : !want.test(got)) problems.push(`${stream} ${JSON.stringify(got.slice(0, 300))} does not match ${want instanceof RegExp ? want : JSON.stringify(want)}`);
  }
  return problems;
}

const SIGNED_OUT_KEYS = ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory'];
const SIGNED_IN_KEYS = [...SIGNED_OUT_KEYS, 'email', 'orgId', 'orgName', 'subscriptionType'];
const URL_LINE = /^If the browser didn't open, visit: https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=[0-9a-f-]+&response_type=code&redirect_uri=https%3A%2F%2Fplatform\.claude\.com%2Foauth%2Fcode%2Fcallback&scope=[^&]+&code_challenge=[A-Za-z0-9_-]+&code_challenge_method=S256&state=[A-Za-z0-9_-]+$/;

function jsonKeys(text: string, keys: string[], loggedIn: boolean, base: string): string[] {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { return [`stdout is not JSON: ${JSON.stringify(text.slice(0, 120))}`]; }
  const problems: string[] = [];
  if (JSON.stringify(Object.keys(parsed)) !== JSON.stringify(keys)) problems.push(`keys ${JSON.stringify(Object.keys(parsed))}, wanted ${JSON.stringify(keys)}`);
  if (parsed.loggedIn !== loggedIn) problems.push(`loggedIn ${String(parsed.loggedIn)}`);
  if (parsed.authMethod !== (loggedIn ? 'claude.ai' : 'none')) problems.push(`authMethod ${String(parsed.authMethod)}`);
  if (parsed.apiProvider !== 'firstParty') problems.push(`apiProvider ${String(parsed.apiProvider)}`);
  if (parsed.configDirectory !== join(base, 'claude')) problems.push(`configDirectory ${String(parsed.configDirectory)}`);
  if (parsed.projectsDirectory !== join(base, 'claude', 'projects')) problems.push(`projectsDirectory ${String(parsed.projectsDirectory)}`);
  if (loggedIn && parsed.subscriptionType !== 'max') problems.push(`subscriptionType ${String(parsed.subscriptionType)}`);
  if (text !== `${JSON.stringify(parsed, null, 2)}\n`) problems.push('not 2-space pretty-printed with one trailing newline');
  return problems;
}

type Row = { name: string; run: (target: CliTarget, issuer: string) => Promise<string[]> };

async function inFresh<T>(body: (base: string) => Promise<T>): Promise<T> {
  const base = await freshBase();
  try { return await body(base); } finally { await rm(base, { recursive: true, force: true }); }
}

const helpRows = (client: GoldenClient): Row[] => Object.entries(GOLDEN_HELP[client]).map(([command, golden]) => ({
  name: `${command} matches the golden help`,
  run: (target) => inFresh(async (base) => {
    const result = await run(target.path, command.split(' '), base);
    return expect(result, { code: 0, stdout: golden });
  }),
}));

const claudeRows: Row[] = [
  ...helpRows('claude_code'),
  { name: 'auth status, signed out: JSON, exit 1', run: (t) => inFresh(async (base) => {
    const r = await run(t.path, ['auth', 'status'], base);
    return [...expect(r, { code: 1, stdout: /^\{/ }), ...jsonKeys(r.stdout, SIGNED_OUT_KEYS, false, base)];
  }) },
  { name: 'auth status --json equals the default', run: (t) => inFresh(async (base) => {
    const a = await run(t.path, ['auth', 'status'], base);
    const b = await run(t.path, ['auth', 'status', '--json'], base);
    return a.stdout === b.stdout && a.code === b.code ? [] : ['--json differs from the default'];
  }) },
  { name: 'auth status --text, signed out', run: (t) => inFresh(async (base) => expect(await run(t.path, ['auth', 'status', '--text'], base), { code: 1, stdout: 'Not logged in. Run claude auth login to authenticate.\n' })) },
  { name: 'auth status, signed in: claude.ai key set, exit 0', run: (t) => inFresh(async (base) => {
    await seedClaude(base);
    const r = await run(t.path, ['auth', 'status'], base);
    return [...expect(r, { code: 0, stdout: /^\{/ }), ...jsonKeys(r.stdout, SIGNED_IN_KEYS, true, base)];
  }) },
  { name: 'auth status --text, signed in', run: (t) => inFresh(async (base) => { await seedClaude(base); return expect(await run(t.path, ['auth', 'status', '--text'], base), { code: 0, stdout: 'Login method: Claude Max account\n' }); }) },
  { name: 'auth logout, signed in: message on stdout, exit 0, login file gone', run: (t) => inFresh(async (base) => {
    await seedClaude(base);
    const problems = expect(await run(t.path, ['auth', 'logout'], base), { code: 0, stdout: 'Successfully logged out from your Anthropic account.\n' });
    if (await exists(join(base, 'claude', '.credentials.json'))) problems.push('.credentials.json is still there');
    return problems;
  }) },
  { name: 'auth logout, signed out: same message, exit 0', run: (t) => inFresh(async (base) => expect(await run(t.path, ['auth', 'logout'], base), { code: 0, stdout: 'Successfully logged out from your Anthropic account.\n' })) },
  { name: 'auth login --console --claudeai is refused on stderr, exit 1', run: (t) => inFresh(async (base) => expect(await run(t.path, ['auth', 'login', '--console', '--claudeai'], base), { code: 1, stderr: 'Error: --console and --claudeai cannot be used together.\n' })) },
  { name: 'auth login: three stdout lines, code#state rule, keeps waiting', run: (t) => inFresh(async (base) => {
    const problems: string[] = [];
    let seen = '';
    const result = await run(t.path, ['auth', 'login'], base, { timeoutMs: 15_000, script: async (send, out) => {
      const wait = async (test: () => boolean) => { for (let i = 0; i < 300 && !test(); i += 1) await new Promise((r) => setTimeout(r, 50)); };
      await wait(() => out().includes('Paste code here if prompted > '));
      seen = out();
      send('garbage\n');
      await new Promise((r) => setTimeout(r, 500));
      send('#state-without-code\n');
      await new Promise((r) => setTimeout(r, 1000));
    } });
    const lines = seen.split('\n');
    if (lines.length !== 3) problems.push(`stdout has ${lines.length} lines, wanted 3: ${JSON.stringify(seen.slice(0, 200))}`);
    else {
      if (lines[0] !== 'Opening browser to sign in…') problems.push(`line 1 ${JSON.stringify(lines[0])}`);
      if (!URL_LINE.test(lines[1] ?? '')) problems.push(`line 2 ${JSON.stringify((lines[1] ?? '').slice(0, 200))}`);
      if (lines[2] !== 'Paste code here if prompted > ') problems.push(`line 3 ${JSON.stringify(lines[2])}, no trailing newline`);
    }
    if (result.stderr !== 'Invalid code. Please make sure the full code was copied.\nInvalid code. Please make sure the full code was copied.\n') problems.push(`stderr ${JSON.stringify(result.stderr.slice(0, 200))}: each malformed paste gets the message and the CLI keeps waiting`);
    if (result.code !== null) problems.push(`the CLI exited (${result.code}) instead of waiting`);
    return problems;
  }) },
];

const BANNER = (issuer: string) => (version: string) => new RegExp(`^\\n`
  + `Welcome to Codex \\[v\\u001b\\[90m${version.replace(/\./g, '\\.')}\\u001b\\[0m\\]\\n`
  + `\\u001b\\[90mOpenAI's command-line coding agent\\u001b\\[0m\\n\\n`
  + `Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n`
  + `1\\. Open this link in your browser and sign in to your account\\n   \\u001b\\[94m${issuer.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/codex/device\\u001b\\[0m\\n\\n`
  + `2\\. Enter this one-time code \\u001b\\[90m\\(expires in 15 minutes\\)\\u001b\\[0m\\n   \\u001b\\[94m[A-Z0-9]{4}-[A-Z0-9]{4,5}\\u001b\\[0m\\n\\n`
  + `\\u001b\\[90mContinue only if you started this login in Codex\\. If a website or another person gave you this code, cancel\\.\\u001b\\[0m\\n\\n`);

const codexRows: Row[] = [
  ...helpRows('codex'),
  { name: 'login status, signed out: stderr only, exit 1', run: (t) => inFresh(async (base) => expect(await run(t.path, ['login', 'status'], base), { code: 1, stderr: 'Not logged in\n' })) },
  { name: 'login status, signed in: stderr only, exit 0', run: (t) => inFresh(async (base) => { await seedCodex(base); return expect(await run(t.path, ['login', 'status'], base), { code: 0, stderr: 'Logged in using ChatGPT\n' }); }) },
  { name: 'logout, signed out: "Not logged in" on stderr, exit 0', run: (t) => inFresh(async (base) => expect(await run(t.path, ['logout'], base), { code: 0, stderr: 'Not logged in\n' })) },
  { name: 'logout, signed in: stderr only, exit 0, auth.json gone', run: (t) => inFresh(async (base) => {
    await seedCodex(base);
    const problems = expect(await run(t.path, ['logout'], base), { code: 0, stderr: 'Successfully logged out\n' });
    if (await exists(join(base, 'codex', 'auth.json'))) problems.push('auth.json is still there');
    return problems;
  }) },
  { name: 'login --device-auth prints the real banner on stdout', run: (t, issuer) => inFresh(async (base) => {
    const r = await run(t.path, ['login', '--device-auth', ...(t.issuerArgs?.(issuer) ?? [])], base, { timeoutMs: 15_000, until: (out) => out.endsWith('cancel.\u001b[0m\n\n') });
    const wanted = BANNER(t.issuerArgs ? issuer : 'https://auth.openai.com')('0.160.1');
    return wanted.test(r.stdout) ? [] : [`banner ${JSON.stringify(r.stdout.slice(0, 700))}`];
  }) },
];

/** A loopback issuer for the real Codex's device-code request: it answers usercode and never approves. */
async function mockIssuer() {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/usercode')) { response.end(JSON.stringify({ device_auth_id: 'device-contract', user_code: 'ABCD-1234', interval: '1' })); return; }
    response.statusCode = 403;
    response.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

export async function runAuthTable(targets: CliTarget[]): Promise<CaseResult[]> {
  const issuer = await mockIssuer();
  const results: CaseResult[] = [];
  try {
    for (const target of targets) {
      for (const row of target.client === 'claude_code' ? claudeRows : codexRows) {
        let problems: string[];
        try { problems = await row.run(target, issuer.url); } catch (error) { problems = [`threw ${(error as Error).message}`]; }
        results.push({ target: target.label, name: row.name, ok: problems.length === 0, detail: problems.join('; ') });
      }
    }
  } finally {
    await issuer.close();
  }
  return results;
}

export async function wrapperScript(dir: string, name: string, script: string, node = process.execPath) {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\nexec ${node} ${script} "$@"\n`);
  await chmod(path, 0o755);
  return path;
}
