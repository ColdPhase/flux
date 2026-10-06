import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// TEST ONLY (F-022 Docker test plan): fake `claude` and `codex` with the same command shapes as the
// pinned CLIs, so the runtime is tested without any subscription. They exist only in the
// `agent-runtime-test` image. Each call is recorded in the CLI's home (`fake-calls.jsonl`: the argv,
// the environment's names and the non-secret values the tests check). A scenario file in the same home
// (`fake-scenario`) selects failures. A fake never contacts a vendor.

export type FakeClient = 'claude_code' | 'codex';

const home = (client: FakeClient) => (client === 'claude_code' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) ?? '';
const credentials = (client: FakeClient) => join(home(client), client === 'claude_code' ? '.credentials.json' : 'auth.json');

function record(client: FakeClient, argv: string[]) {
  const dir = home(client);
  if (!dir || !existsSync(dir)) return;
  const shown = ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HTTPS_PROXY', 'NO_PROXY', 'DISABLE_UPDATES', 'ENABLE_CLAUDEAI_MCP_SERVERS'];
  appendFileSync(join(dir, 'fake-calls.jsonl'), `${JSON.stringify({
    argv, cwd: process.cwd(), envNames: Object.keys(process.env).sort(),
    env: Object.fromEntries(shown.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
  })}\n`, { mode: 0o600 });
}

function scenario(client: FakeClient): string {
  try { return readFileSync(join(home(client), 'fake-scenario'), 'utf8').trim(); } catch { return ''; }
}

/** Drops Codex's global `-c key=value` options, as the real CLI accepts them before a subcommand. */
function command(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-c' || argv[i] === '--config') { i += 1; continue; }
    out.push(argv[i]!);
  }
  return out;
}

export function fakeCli(client: FakeClient, argv: string[]): number {
  record(client, argv);
  const words = command(argv);
  const signedIn = existsSync(credentials(client));
  const mode = scenario(client);
  const key = words.join(' ');
  if (key === '--version') { process.stdout.write(client === 'claude_code' ? '2.1.285 (Claude Code) [fake]\n' : 'codex-cli 0.160.1 [fake]\n'); return 0; }
  if (key === (client === 'claude_code' ? 'auth status' : 'login status')) {
    if (client === 'claude_code') process.stdout.write(`${JSON.stringify(signedIn ? { loggedIn: true, authMethod: 'claude.ai' } : { loggedIn: false })}\n`);
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
  process.stderr.write(`fake ${client}: not implemented in T3: ${key.slice(0, 80)}\n`);
  return 2;
}
