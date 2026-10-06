import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// TEST ONLY (F-022 Docker test plan): fake `claude` and `codex` with the same command shapes as the
// pinned CLIs, so the runtime is tested without any subscription. They exist only in the
// `agent-runtime-test` image. Each call is recorded in the CLI's home (`fake-calls.jsonl`: the argv,
// the environment's names and the non-secret values the tests check). A scenario file in the same home
// (`fake-scenario`) selects failures. A fake never contacts a vendor.
//
// `claude auth login` (T4) behaves as Claude Code 2.1.285 did in a terminal on 2026-10-06: it prints
// "Opening browser to sign in…", the authorization URL as an OSC 8 hyperlink and "Paste code here if
// prompted > ", then reads one line at its prompt. A code shaped `fake-code-…` signs in: it writes
// `.credentials.json` (0600) holding a seeded fake credential, `fake-secret` in the home when present,
// which the secret-absence tests look for everywhere else. Anything else is refused as the real CLI
// does ("Invalid code…"). The login needs a terminal, so it proves the PTY.

export type FakeClient = 'claude_code' | 'codex';

const home = (client: FakeClient) => (client === 'claude_code' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) ?? '';
const credentials = (client: FakeClient) => join(home(client), client === 'claude_code' ? '.credentials.json' : 'auth.json');
const readHome = (client: FakeClient, name: string) => { try { return readFileSync(join(home(client), name), 'utf8').trim(); } catch { return ''; } };

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

/** Drops Codex's global `-c key=value` options, as the real CLI accepts them before a subcommand. */
function command(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-c' || argv[i] === '--config') { i += 1; continue; }
    out.push(argv[i]!);
  }
  return out;
}

const LOGIN_URLS: Record<string, string> = {
  'auth login': 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake-client&response_type=code',
  'auth login --claudeai': 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake-client&response_type=code',
  'auth login --console': 'https://platform.claude.com/oauth/authorize?code=true&client_id=fake-client&response_type=code',
  'auth login --sso': 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake-client&response_type=code&login_method=sso',
};

/** One line from the terminal, as the CLI's prompt reads it (the line discipline echoes and edits). */
function readLine(): Promise<string | null> {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
      const end = text.search(/[\r\n]/);
      if (end !== -1) { process.stdin.pause(); resolve(text.slice(0, end)); }
    });
    process.stdin.on('end', () => resolve(null));
  });
}

async function claudeLogin(key: string, argv: string[]): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('fake claude: auth login needs a terminal\n'); return 3; }
  const mode = scenario('claude_code');
  const url = `${LOGIN_URLS[key]}&state=${randomBytes(12).toString('base64url')}`;
  process.stdout.write(`Opening browser to sign in…\r\nIf the browser didn't open, visit: \u001b]8;;${url}\u0007\u001b[94m${url}\u001b[39m\u001b]8;;\u0007\r\nPaste code here if prompted > `);
  // Waits at its prompt without reading, until it is ended (a timer keeps the process alive).
  if (mode === 'login_hangs') { await new Promise(() => setInterval(() => undefined, 60_000)); }
  const code = await readLine();
  record('claude_code', argv, { event: 'code', code });
  if (code === null || !/^fake-code-[A-Za-z0-9_-]{1,64}$/.test(code.trim())) {
    process.stdout.write('\r\nInvalid code. Please make sure the full code was copied.\r\n');
    return 1;
  }
  if (mode !== 'login_without_credentials') {
    const secret = readHome('claude_code', 'fake-secret') || 'fake-secret-not-seeded';
    const method = key.endsWith('--console') ? 'console' : key.endsWith('--sso') ? 'sso' : 'claude_account';
    writeFileSync(credentials('claude_code'), JSON.stringify({ fakeMethod: method, claudeAiOauth: {
      accessToken: `sk-ant-oat01-${secret}`, refreshToken: `sk-ant-ort01-${secret}`, expiresAt: Date.now() + 3_600_000,
    } }), { mode: 0o600 });
  }
  process.stdout.write('\r\nLogin successful.\r\n');
  return 0;
}

/** `auth status` as the real CLI prints it, from the fake's own credential file. */
function claudeStatus(signedIn: boolean): string {
  if (!signedIn) return JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, null, 2);
  let method = 'claude_account';
  try { method = (JSON.parse(readFileSync(credentials('claude_code'), 'utf8')) as { fakeMethod?: string }).fakeMethod ?? method; } catch { /* keep the default */ }
  const account = readHome('claude_code', 'fake-account') || 'owner@example.org';
  return JSON.stringify({
    loggedIn: true, authMethod: method === 'console' ? 'api_key' : 'claude.ai', apiProvider: 'firstParty', email: account,
    orgId: `org-${account.split('@')[1] ?? 'none'}`, ...(method === 'console' ? {} : { subscriptionType: method === 'sso' ? 'enterprise' : 'max' }),
  }, null, 2);
}

export async function fakeCli(client: FakeClient, argv: string[]): Promise<number> {
  const words = command(argv);
  const key = words.join(' ');
  if (client === 'claude_code' && key in LOGIN_URLS) {
    record(client, argv);
    return claudeLogin(key, argv);
  }
  record(client, argv);
  const signedIn = existsSync(credentials(client));
  const mode = scenario(client);
  if (key === '--version') { process.stdout.write(client === 'claude_code' ? '2.1.285 (Claude Code) [fake]\n' : 'codex-cli 0.160.1 [fake]\n'); return 0; }
  if (key === (client === 'claude_code' ? 'auth status' : 'login status')) {
    if (client === 'claude_code') process.stdout.write(`${claudeStatus(signedIn)}\n`);
    else process.stdout.write(signedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
    return signedIn ? 0 : 1;
  }
  if (key === (client === 'claude_code' ? 'auth logout' : 'logout')) {
    if (mode === 'logout_fails') { process.stdout.write('Could not reach the vendor\n'); return 1; }
    if (mode === 'logout_hangs') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000); return 1; }
    rmSync(credentials(client), { force: true });
    process.stdout.write('Successfully logged out\n');
    return 0;
  }
  process.stderr.write(`fake ${client}: not implemented: ${key.slice(0, 80)}\n`);
  return 2;
}
