import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Browser as Chromium } from 'playwright';
import { password } from './people.js';

/**
 * Shared harness for the opt-in checks that drive the REAL pinned `codex` and `claude` clients against the Compose Flux
 * instance (docker/Dockerfile `mcp-clients`; scripts/check_mcp_clients.sh). No vendor account: the person signs in to Flux
 * in Chromium, and the models are `client-model-mock.ts`.
 */
export const origin = process.env.FLUX_PUBLIC_ORIGIN!;
export const mcpUrl = `${origin}/mcp`;
export const scopes = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
export const claudeBin = '/opt/flux-tools/claude/bin/claude';
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const root = mkdtempSync(join(tmpdir(), 'mcp-clients-'));

/** The clients reach Flux at its public origin (127.0.0.1), which inside this container is this proxy. */
export function startFluxProxy() {
  const proxy = http.createServer((request, response) => {
    const forward = http.request({ host: upstream.hostname, port: upstream.port || 80, method: request.method, path: request.url, headers: request.headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
    });
    forward.on('error', () => response.destroy()); request.pipe(forward);
  });
  return {
    listen: () => new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve)),
    close: async () => { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); },
  };
}

export interface Running { output: () => string; done: Promise<number | null>; kill: () => void }
export function run(command: string, args: string[], env: Record<string, string>, cwd: string, keepStdin = false): Running {
  const child: ChildProcess = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  if (!keepStdin) child.stdin!.end();
  let text = '';
  child.stdout!.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  const done = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000); done.then(() => clearTimeout(timer));
  return { output: () => text, done, kill: () => child.kill('SIGKILL') };
}
export async function waitFor(running: Running, pattern: RegExp, label: string): Promise<RegExpMatchArray> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const match = running.output().match(pattern);
    if (match) return match;
    if (await Promise.race([running.done, new Promise((resolve) => setTimeout(resolve, 150, 'wait'))]) !== 'wait') {
      const last = running.output().match(pattern);
      if (last) return last;
      throw new Error(`${label}: exited without ${pattern}:\n${running.output()}`);
    }
  }
  throw new Error(`${label}: no ${pattern} in\n${running.output()}`);
}
export const sh = async (command: string, args: string[], env: Record<string, string>, cwd: string) => {
  const running = run(command, args, env, cwd);
  return { code: await running.done, output: running.output() };
};

/** One client installation: a clean HOME and config directory, as a person who just installed the client has. */
export interface ClientSpec { key: string; client: 'codex' | 'claude'; label: string; designation: 'codex' | 'claude_code'; port: number }
export interface ClientHome { spec: ClientSpec; env: Record<string, string>; cwd: string }

/** Registers the OAuth client Flux would otherwise learn from the client's metadata; the CLIs use their pre-registered client-id option. */
export async function seedOauthClient(pool: Pool, spec: ClientSpec) {
  const clientId = `flux-clientcontract-${spec.key}-${randomUUID()}`;
  await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, true, now(), now())`, [randomUUID(), clientId, `${spec.label} (pinned ${spec.client} contract)`,
    [`http://127.0.0.1:${spec.port}/callback`, `http://localhost:${spec.port}/callback`], ['authorization_code', 'refresh_token'], ['code'], [...scopes, 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1,$2,$3,now())', [randomUUID(), clientId, mcpUrl]);
  return clientId;
}

export function cleanClientHome(spec: ClientSpec): ClientHome {
  const home = join(root, spec.key); const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true }); mkdirSync(join(home, 'codex'), { recursive: true }); mkdirSync(join(home, 'claude'), { recursive: true });
  const base = { HOME: home, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  return spec.client === 'codex'
    ? { spec, cwd, env: { ...base, CODEX_HOME: join(home, 'codex'), MOCK_MODEL_KEY: 'not-a-vendor-key', RUST_LOG: 'warn,codex_mcp=debug,codex_rmcp_client=debug,rmcp=debug' } }
    : { spec, cwd, env: { ...base, CLAUDE_CONFIG_DIR: join(home, 'claude'), ANTHROPIC_API_KEY: 'sk-ant-not-a-vendor-key' } };
}

/** The real person signs in and consents in Chromium for exactly the connection the client is for. */
export async function authorizeInBrowser(browser: Chromium, email: string, spec: ClientSpec, url: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(url); await page.waitForURL(`${origin}/login?**`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(`${origin}/connect-agent?**`);
    await page.locator('.connection__saved').filter({ hasText: spec.label }).getByRole('radio').check();
    await page.getByRole('button', { name: 'Continue to consent' }).click(); await page.waitForURL(`${origin}/consent?**`);
    await page.locator('.connection__summary').filter({ hasText: spec.label }).waitFor({ state: 'visible' });
    const callback = page.waitForURL(new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${spec.port}/callback`), { waitUntil: 'commit' }).catch(() => undefined);
    await page.getByRole('button', { name: 'Allow access' }).click();
    await callback;
  } catch (error) {
    throw new Error(`${(error as Error).message}\nauthorization URL: ${url}`);
  } finally { await context.close(); }
}

const authorizeUrl = /(https?:\/\/[^\s"']*\/api\/auth\/oauth2\/authorize\?[^\s"']+)/;

/** Each client's own commands: add Flux, authenticate through Flux's OAuth, then ask the client for its MCP status. */
export async function connectClient(browser: Chromium, email: string, home: ClientHome, clientId?: string) {
  const { spec, env, cwd } = home;
  if (spec.client === 'codex') {
    const add = run('codex', ['mcp', 'add', 'flux', '--url', mcpUrl,
      ...(clientId ? ['--oauth-client-id', clientId] : []), '-c', `mcp_oauth_callback_port=${spec.port}`], env, cwd);
    // `mcp add` starts the login itself when the server offers OAuth; otherwise `mcp login` does.
    let match: RegExpMatchArray | null = await waitFor(add, authorizeUrl, 'codex mcp add').catch(() => null);
    let login = add;
    if (!match) {
      assert.equal(await add.done, 0, add.output());
      login = run('codex', ['mcp', 'login', 'flux', '--no-browser', '-c', `mcp_oauth_callback_port=${spec.port}`], env, cwd);
      match = await waitFor(login, authorizeUrl, 'codex mcp login');
    }
    await authorizeInBrowser(browser, email, spec, match![1]!);
    assert.equal(await login.done, 0, login.output());
    const get = await sh('codex', ['mcp', 'get', 'flux'], env, cwd);
    assert.equal(get.code, 0, get.output);
    assert.match(get.output, new RegExp(mcpUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const listed = await sh('codex', ['mcp', 'list'], env, cwd);
    assert.match(listed.output, /flux/); assert.doesNotMatch(listed.output, /Not logged in|Unsupported/i, listed.output);
  } else {
    if (!clientId) throw new Error('Claude pre-registered fixture requires its own client ID');
    const add = await sh(claudeBin, ['mcp', 'add', '--transport', 'http', '--scope', 'user', '--client-id', clientId, '--callback-port', String(spec.port), 'flux', mcpUrl], env, cwd);
    assert.equal(add.code, 0, add.output);
    // Claude Code refuses to log in without a terminal; `script` gives it one and the paste prompt waits on stdin.
    const login = run('script', ['-qefc', `${claudeBin} mcp login flux --no-browser`, '/dev/null'], env, cwd, true);
    const match = await waitFor(login, authorizeUrl, 'claude mcp login');
    // The terminal output wraps the URL in an OSC-8 hyperlink, which repeats it after an escape.
    await authorizeInBrowser(browser, email, spec, match[1]!.split(String.fromCharCode(27))[0]!.split(/(?=https?:\/\/)/)[0]!);
    assert.equal(await login.done, 0, login.output());
    const listed = await sh(claudeBin, ['mcp', 'list'], env, cwd);
    assert.match(listed.output, /flux: .*Connected/, listed.output);
  }
}

/** The few fields read from `codex exec --json` and `claude -p --output-format stream-json` lines. */
export interface ClientEvent {
  type?: string;
  item?: { type?: string; server?: string; tool?: string; result?: { content?: { text?: string }[] }; error?: { message?: string } };
  message?: { content?: { type?: string; id?: string; name?: string; tool_use_id?: string; content?: string | { text?: string }[] }[] };
}
export function clientEvents(output: string): ClientEvent[] {
  return output.split('\n').filter((line) => line.startsWith('{')).map((line): ClientEvent => { try { return JSON.parse(line) as ClientEvent; } catch { return {}; } });
}
