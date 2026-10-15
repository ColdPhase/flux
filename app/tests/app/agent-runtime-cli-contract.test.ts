import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { runAuthTable, wrapperScript } from '../../apps/runtime/src/contract/auth-table.js';

// F-022 T4 (#279): the TEST ONLY fake `claude` and `codex` against the one assertion table that also runs
// against the pinned real CLIs (scripts/check_runtime_cli_contract.sh, opt-in, `--network none`, no
// account). The golden `--help` texts, the status JSON keys, exit codes and stdout-vs-stderr streams are
// asserted once for both. Below it, the behaviour only the fakes have to provide: the `code#state` rule,
// scenarios and the keyless Console profile outside CLAUDE_CONFIG_DIR.

let root = '';
let claude = '';
let codex = '';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'flux-fake-contract-'));
  claude = await wrapperScript(root, 'claude', resolve('apps/runtime/dist/fakes/fake-claude.js'));
  codex = await wrapperScript(root, 'codex', resolve('apps/runtime/dist/fakes/fake-codex.js'));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

describe('the fakes against the shared assertion table', () => {
  test('every row passes for the fake claude and the fake codex', async () => {
    const results = await runAuthTable([{ client: 'claude_code', path: claude, label: 'claude (fake)' }, { client: 'codex', path: codex, label: 'codex (fake)' }]);
    assert.ok(results.length >= 20, `${results.length} rows`);
    const failed = results.filter((row) => !row.ok).map((row) => `${row.target}: ${row.name}: ${row.detail}`);
    assert.deepEqual(failed, []);
  });
});

type Session = { base: string; home: string; config: string; codexHome: string; env: Record<string, string> };
async function session(scenario = ''): Promise<Session> {
  const base = await mkdtemp(join(root, 'case-'));
  const home = join(base, 'home');
  const config = join(base, 'claude');
  const codexHome = join(base, 'codex');
  for (const dir of [home, config, codexHome]) await mkdir(dir, { mode: 0o700 });
  if (scenario) { await writeFile(join(config, 'fake-scenario'), scenario); await writeFile(join(codexHome, 'fake-scenario'), scenario); }
  return { base, home, config, codexHome, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: codexHome } };
}

/** Starts a fake and gives its output and a way to send lines; resolves when it exits. */
function start(path: string, args: string[], s: Session, env: Record<string, string> = {}) {
  const child = spawn(path, args, { env: { ...s.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => { state.stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { state.stderr += chunk.toString('utf8'); });
  const exited = new Promise<number | null>((done) => child.on('close', done));
  const until = async (test: () => boolean) => { for (let i = 0; i < 200 && !test(); i += 1) await new Promise((r) => setTimeout(r, 25)); assert.ok(test(), `waited for output: ${JSON.stringify(state)}`); };
  return { child, state, exited, until, send: (line: string) => child.stdin.write(line) };
}
const stateOf = (stdout: string) => /state=([A-Za-z0-9_-]+)/.exec(stdout)?.[1] ?? assert.fail(`no state in ${stdout}`);
async function runToEnd(path: string, args: string[], s: Session) {
  const run = start(path, args, s);
  run.child.stdin.end();
  return { code: await run.exited, ...run.state };
}

describe('fake claude auth login', () => {
  test('a pasted code is accepted only as code#state with the state it printed', async () => {
    const s = await session();
    const login = start(claude, ['auth', 'login'], s);
    await login.until(() => login.state.stdout.includes('Paste code here if prompted > '));
    const state = stateOf(login.state.stdout);
    for (const bad of ['plain-code', `code#`, '#state', `code#wrong-${state}`, `a#b#${state}`]) login.send(`${bad}\n`);
    await login.until(() => login.state.stderr.split('Invalid code. Please make sure the full code was copied.\n').length === 6);
    assert.ok(!existsSync(join(s.config, '.credentials.json')));
    login.send(`any-code#${state}\n`);
    assert.equal(await login.exited, 0);
    assert.equal(login.state.stdout.endsWith('Login successful.\n'), true, login.state.stdout);
    const stored = JSON.parse(await readFile(join(s.config, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } };
    assert.match(stored.claudeAiOauth.accessToken, /^sk-ant-oat01-/);
  });

  test('login_failed prints the vendor failure on stderr and exits 1 without a login', async () => {
    const s = await session('login_failed');
    const login = start(claude, ['auth', 'login'], s);
    await login.until(() => login.state.stdout.includes('Paste code here'));
    login.send(`c#${stateOf(login.state.stdout)}\n`);
    assert.equal(await login.exited, 1);
    assert.match(login.state.stderr, /^Login failed: /m);
    assert.ok(!existsSync(join(s.config, '.credentials.json')));
  });

  test('login_timeout and closed input: a timeout exits 1, closed input keeps waiting as the real CLI does', async () => {
    const s = await session('login_timeout');
    const timeout = await runToEnd(claude, ['auth', 'login'], s);
    assert.equal(timeout.code, 1);
    assert.match(timeout.stderr, /^Login failed: timed out/);
    const open = start(claude, ['auth', 'login'], await session());
    await open.until(() => open.state.stdout.includes('Paste code here'));
    open.child.stdin.end();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(open.child.exitCode, null, 'still waiting');
    open.child.kill('SIGKILL');
    await open.exited;
  });

  test('the methods differ in the authorize URL and --console with --claudeai is refused', async () => {
    const urls: Record<string, string> = {};
    for (const flag of ['--claudeai', '--console', '--sso']) {
      const login = start(claude, ['auth', 'login', flag], await session());
      await login.until(() => login.state.stdout.includes('Paste code here'));
      urls[flag] = login.state.stdout;
      login.child.kill('SIGKILL');
      await login.exited;
    }
    assert.match(urls['--claudeai']!, /claude\.com\/cai\/oauth\/authorize/);
    assert.match(urls['--console']!, /platform\.claude\.com\/oauth\/authorize/);
    assert.match(urls['--sso']!, /login_method=sso/);
    const both = await runToEnd(claude, ['auth', 'login', '--console', '--claudeai'], await session());
    assert.deepEqual([both.code, both.stdout, both.stderr], [1, '', 'Error: --console and --claudeai cannot be used together.\n']);
  });

  test('console_profile keeps the keyless Console login outside CLAUDE_CONFIG_DIR and logout deletes it', async () => {
    const s = await session('console_profile');
    const login = start(claude, ['auth', 'login', '--console'], s);
    await login.until(() => login.state.stdout.includes('Paste code here'));
    login.send(`c#${stateOf(login.state.stdout)}\n`);
    assert.equal(await login.exited, 0);
    assert.ok(existsSync(join(s.home, '.config', 'anthropic', 'active_config')), 'the profile is under HOME');
    assert.ok(!existsSync(join(s.config, '.credentials.json')), 'and nothing is in CLAUDE_CONFIG_DIR');
    const signedIn = await runToEnd(claude, ['auth', 'status'], s);
    assert.equal(signedIn.code, 0);
    assert.equal((JSON.parse(signedIn.stdout) as { loggedIn: boolean }).loggedIn, true);
    assert.equal((await runToEnd(claude, ['auth', 'logout'], s)).code, 0);
    assert.ok(!existsSync(join(s.home, '.config', 'anthropic')));
  });
});

describe('fake sign-out failures', () => {
  test('claude logout_fails: stderr and exit 1, the login stays (Flux deletes it itself)', async () => {
    const s = await session('logout_fails');
    await writeFile(join(s.config, '.credentials.json'), '{"claudeAiOauth":{}}');
    const out = await runToEnd(claude, ['auth', 'logout'], s);
    assert.deepEqual([out.code, out.stdout, /^Logout failed: /.test(out.stderr)], [1, '', true]);
    assert.ok(existsSync(join(s.config, '.credentials.json')));
  });
  test('codex logout_fails: stderr and exit 1; codex device login failure scenarios', async () => {
    const s = await session('logout_fails');
    const out = await runToEnd(codex, ['logout'], s);
    assert.deepEqual([out.code, out.stdout, /^Error logging out: /.test(out.stderr)], [1, '', true]);
    for (const [scenario, text] of [['login_failed', /device auth failed with status/], ['login_timeout', /device auth timed out after 15 minutes/]] as const) {
      const failing = await session(scenario);
      const run = await runToEnd(codex, ['login', '--device-auth'], failing);
      assert.equal(run.code, 1);
      assert.match(run.stderr, text);
      assert.ok(!existsSync(join(failing.codexHome, 'auth.json')));
    }
    const ok = await session();
    const done = await runToEnd(codex, ['login', '--device-auth'], ok);
    assert.deepEqual([done.code, done.stderr], [0, 'Successfully logged in\n']);
    assert.equal((await runToEnd(codex, ['login', 'status'], ok)).code, 0);
  });
});
