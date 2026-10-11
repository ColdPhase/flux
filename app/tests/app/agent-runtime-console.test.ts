import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import {
  AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CHECK_PATH, AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_NOTICE_PATH, AGENT_RUNTIME_PATH, AGENT_RUNTIME_SIGN_OUT_PATH,
  type AgentRuntimeConsoleServerMessage, type AgentRuntimeStatus,
} from '@flux/contracts';
import { reconcileAgentRuntime, type AgentRuntimeConfig } from '@flux/core';
import { agentRuntimeStore, createDatabase } from '@flux/db';
import { createRuntimeManagerClient, runtimeManagerPort } from '@flux/runtime-protocol';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { agentRuntimeRoutes } from '../../apps/server/src/agent-runtime/routes.js';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { connectionString } from './support/db.js';
import { Browser } from './support/http.js';
import { expectStatus, password, person, type Person } from './support/people.js';
import { slotSecret, startTestSlot, type TestSlot } from './support/runtime-slot.js';
import { pastedLine } from './support/runtime-login.js';

// F-022 T4 (#279): the Claude Code sign-in console end to end in process: the API's routes and
// WebSocket with its own Better Auth (same database and secret as the API container), runtime-manager
// and a slot's supervisor with real PTYs and the TEST ONLY fake `claude`. The Docker check with every
// runtime service is scripts/check_agent_runtime.sh.

const { db, pool } = createDatabase(connectionString);
const origin = 'http://127.0.0.1:18279';
const authSecret = process.env.FLUX_AUTH_SECRET ?? `runtime-console-${'x'.repeat(40)}`;
// Two slots: each describe's owner keeps theirs (a released test supervisor does not restart).
const base = 900 + Math.floor(Math.random() * 98);
const slotNames = [`runtime-${base}`, `runtime-${base + 1}`];
const managerSecret = slotSecret();
const logs: string[] = [];
const managerLogs: Record<string, unknown>[] = [];
const slots = new Map<string, TestSlot>();
let manager: Server;
let app: FastifyInstance;
let appUrl: string;
let config: AgentRuntimeConfig;

before(async () => {
  for (const name of slotNames) slots.set(name, await startTestSlot({ slot: name, enabled: ['claude_code'] }));
  manager = createManagerServer({ secret: managerSecret, log: (event) => managerLogs.push(event),
    slots: new Map([...slots].map(([name, slot]) => [name, { host: '127.0.0.1', port: Number(new URL(slot.url).port), secret: slot.config.secret }])) });
  await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
  config = { clients: ['claude_code'], commercialTermsAgreedOn: '2026-10-05', idleDays: null,
    manager: { url: `http://127.0.0.1:${(manager.address() as AddressInfo).port}`, secret: managerSecret } };
  // Every API log line is kept, to prove no console frame, code or login reaches the log.
  app = Fastify({ logger: { level: 'trace', stream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }) } });
  const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: origin, FLUX_AUTH_SECRET: authSecret, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(agentRuntimeRoutes, { db, sessions: identity, config, secret: authSecret, publicOrigin: origin });
  await app.listen({ host: '127.0.0.1', port: 0 });
  appUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  // The worker's reconciliation sees the slot and offers it.
  const port = runtimeManagerPort(createRuntimeManagerClient(config.manager!));
  await reconcileAgentRuntime({ config, store: agentRuntimeStore(db), manager: port });
  const { rows } = await pool.query<{ state: string }>('SELECT state FROM agent_runtime_slots WHERE slot = ANY($1)', [slotNames]);
  assert.deepEqual(rows.map((row) => row.state), ['ready', 'ready']);
  // Only these slots may be offered in this shared database.
  const others = await pool.query(`SELECT count(*)::int AS n FROM agent_runtime_slots WHERE state = 'ready' AND slot <> ALL($1)`, [slotNames]);
  assert.equal(others.rows[0].n, 0);
});

after(async () => {
  await app?.close();
  manager?.closeAllConnections();
  await new Promise((done) => manager?.close(done));
  for (const slot of slots.values()) await slot.close();
  await pool.query(`DELETE FROM agent_runtime_bindings WHERE slot = ANY($1)`, [slotNames]).catch(() => undefined);
  await pool.query(`DELETE FROM agent_runtime_slots WHERE slot = ANY($1)`, [slotNames]).catch(() => undefined);
  await pool.end();
});

async function session(someone: Person): Promise<Browser> {
  const browser = new Browser(appUrl, origin);
  expectStatus(await browser.request('POST', '/api/auth/sign-in/email', { body: { email: someone.email, password } }), 200);
  return browser;
}

type Console = { messages: AgentRuntimeConsoleServerMessage[]; output: string; raw: string; socket: WebSocket; closed: Promise<number> };

/** A browser's console WebSocket: everything it receives is kept, binary and text. */
function openConsole(browser: Browser | null, options: { origin?: string | null } = {}): Promise<Console> {
  const headers: Record<string, string> = {};
  const sent = options.origin === undefined ? origin : options.origin;
  if (sent !== null) headers.origin = sent;
  if (browser?.cookies.size) headers.cookie = browser.cookieHeader();
  const socket = new WebSocket(`${appUrl.replace('http', 'ws')}${AGENT_RUNTIME_CONSOLE_PATH}`, { headers });
  const view: Console = { messages: [], output: '', raw: '', socket, closed: new Promise((resolve) => socket.on('close', (code) => resolve(code))) };
  socket.on('message', (data, binary) => {
    const text = data.toString();
    view.raw += text;
    if (binary) view.output += text; else view.messages.push(JSON.parse(text) as AgentRuntimeConsoleServerMessage);
  });
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(view));
    socket.on('unexpected-response', (_request, response) => reject(Object.assign(new Error(`upgrade refused: ${response.statusCode}`), { status: response.statusCode })));
    socket.on('error', reject);
  });
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resume) => setTimeout(resume, 20));
  }
}

const ticketFor = async (browser: Browser, method = 'claude_account') =>
  (expectStatus(await browser.request('POST', AGENT_RUNTIME_CONSOLE_PATH, { body: { client: 'claude_code', method } }), 200) as { ticket: string }).ticket;
const status = async (browser: Browser) => expectStatus(await browser.request('GET', AGENT_RUNTIME_PATH), 200) as AgentRuntimeStatus;
const attach = (view: Console, ticket: string) => view.socket.send(JSON.stringify({ t: 'attach', ticket, cols: 60, rows: 20 }));
const typeInto = (view: Console, text: string) => view.socket.send(JSON.stringify({ t: 'in', d: text }));
const PROMPT = 'Paste code here if prompted > ';

async function bindingOf(someone: Person) {
  const { rows } = await pool.query<{ id: string; slot: string }>(`SELECT id, slot FROM agent_runtime_bindings WHERE owner_user_id = $1 AND state = 'active'`, [someone.id]);
  const { id, slot } = rows[0]!;
  const dataDir = slots.get(slot)!.config.dataDir;
  return { id, dataDir, home: join(dataDir, id, 'claude') };
}
const fakeCalls = async (home: string) => (await readFile(join(home, 'fake-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as { argv: string[]; pid: number; event?: string });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('the console is the owner\'s own, in this session only', () => {
  let ada: Person; let bo: Person;
  let adaBrowser: Browser; let adaOther: Browser; let boBrowser: Browser;
  before(async () => {
    [ada, bo] = await Promise.all([person('Console Ada'), person('Console Bo')]);
    [adaBrowser, adaOther, boBrowser] = await Promise.all([session(ada), session(ada), session(bo)]);
  });

  test('another member\'s session, another session of the owner, a reused or a forged ticket cannot attach', async () => {
    const ticket = await ticketFor(adaBrowser, 'sso');
    const { home } = await bindingOf(ada);
    for (const [who, browser, value] of [['another member', boBrowser, ticket], ['another session of the owner', adaOther, ticket],
      ['a forged ticket', adaBrowser, `${ticket.split('.')[0]}.${randomBytes(32).toString('base64url')}`], ['no ticket', adaBrowser, '']] as const) {
      const view = await openConsole(browser);
      attach(view, value);
      assert.equal(await view.closed, 4403, who);
      assert.deepEqual(view.messages, [{ t: 'error', code: 'refused' }], who);
    }
    assert.deepEqual(await fakeCalls(home), [], 'no CLI started for any refused attach');
    // Control: the owner's own session attaches with the same ticket, once.
    const own = await openConsole(adaBrowser);
    attach(own, ticket);
    await until('the prompt', () => own.output.includes(PROMPT));
    assert.deepEqual((await fakeCalls(home)).map((call) => call.argv), [['auth', 'login', '--sso']]);
    const again = await openConsole(adaBrowser);
    attach(again, ticket);
    assert.equal(await again.closed, 4403, 'a ticket is used once');
    // Leaving the page (closing the socket) ends the sign-in in the slot.
    const pid = (await fakeCalls(home))[0]!.pid;
    assert.equal(alive(pid), true);
    own.socket.close(1000);
    await until('the CLI to be ended in the slot', () => !alive(pid), 5_000);
    assert.equal((await status(adaBrowser)).connections.claude_code?.state ?? 'signed_out', 'signed_out', 'a console that ended unseen signs nothing in');
  });

  test('the upgrade needs a live session and this server\'s origin; the console needs the attach message first', async () => {
    await assert.rejects(openConsole(adaBrowser, { origin: 'https://evil.example' }), (error: { status?: number }) => error.status === 403);
    await assert.rejects(openConsole(adaBrowser, { origin: null }), (error: { status?: number }) => error.status === 403);
    await assert.rejects(openConsole(null), (error: { status?: number }) => error.status === 401);
    for (const message of [{ t: 'in', d: 'claude --help\r' }, { t: 'attach', ticket: 'x', cols: 60, rows: 20, method: 'sso' }, { t: 'attach', ticket: 'x', cols: 2, rows: 20 }, ['x']]) {
      const view = await openConsole(adaBrowser);
      view.socket.send(JSON.stringify(message));
      assert.equal(await view.closed, 4400, JSON.stringify(message));
    }
    const binary = await openConsole(adaBrowser);
    binary.socket.send(Buffer.from('fake-code-x\r'));
    assert.equal(await binary.closed, 4400, 'binary input is refused');
  });
});

describe('signing in through the console', () => {
  let ada: Person; let browser: Browser;
  const secret = `seeded-login-${randomBytes(16).toString('hex')}`;
  const code = `fake-code-${randomBytes(8).toString('hex')}`;
  const seen: string[] = [];
  before(async () => {
    ada = await person('Signin Ada');
    browser = await session(ada);
    await ticketFor(browser);
    const { home } = await bindingOf(ada);
    await writeFile(join(home, 'fake-secret'), secret, { mode: 0o600 });
    await writeFile(join(home, 'fake-account'), 'ada.lovelace@example.org', { mode: 0o600 });
  });

  test('the CLI\'s URL is shown, the pasted code reaches its prompt, and only its status signs in', async () => {
    const before = await status(browser);
    assert.equal(before.connections.claude_code, null);
    const view = await openConsole(browser);
    attach(view, await ticketFor(browser, 'claude_account'));
    await until('the prompt', () => view.output.includes(PROMPT));
    assert.ok(view.output.includes('\u001b]8;;https://claude.com/cai/oauth/authorize?'), 'the CLI\'s sign-in URL, as its own hyperlink');
    assert.deepEqual(view.messages, [{ t: 'state', state: 'starting' }, { t: 'state', state: 'running' }]);
    assert.equal((await status(browser)).connections.claude_code, null, 'not signed in while the CLI waits');
    typeInto(view, pastedLine(view.output, code));
    assert.equal(await view.closed, 1000);
    const done = view.messages.at(-1);
    assert.ok(done?.t === 'done', JSON.stringify(view.messages));
    assert.equal(done.signedIn, true);
    assert.equal(done.ended, 'exited');
    const connection = done.status.connections.claude_code!;
    assert.deepEqual({ ...connection, signedInAt: null }, { state: 'signed_in', signInMethod: 'claude_account', authMethod: 'claude.ai', plan: 'max',
      accountLabel: 'a***@example.org', signedInAt: null, payer: 'claude_plan', accountChange: null, signOut: null });
    seen.push(view.raw, JSON.stringify(done));
    const { home } = await bindingOf(ada);
    assert.ok((await readFile(join(home, '.credentials.json'), 'utf8')).includes(secret), 'control: the login is in the slot');
    const reread = await status(browser);
    seen.push(JSON.stringify(reread));
    assert.equal(reread.connections.claude_code?.state, 'signed_in');
  });

  test('seeded-secret scan: the login never appears in the database, the logs, the frames or the API answers; the code never in the database or the logs', async () => {
    const checked = expectStatus(await browser.request('POST', AGENT_RUNTIME_CHECK_PATH, { body: { client: 'claude_code' } }), 200) as AgentRuntimeStatus;
    assert.equal(checked.connections.claude_code?.state, 'signed_in');
    seen.push(JSON.stringify(checked));
    for (const text of seen) assert.ok(!text.includes(secret), 'a frame or an API answer holds the login');
    assert.ok(seen[0]!.includes(code), 'control: the frames did carry the code the owner pasted (echoed by the CLI)');
    const { rows: tables } = await pool.query<{ schema: string; name: string }>(`SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`);
    assert.ok(tables.length > 20);
    for (const { schema, name } of tables) {
      const { rows } = await pool.query<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM "${schema}"."${name}" x WHERE x::text LIKE $1 OR x::text LIKE $2) AS found`, [`%${secret}%`, `%${code}%`]);
      assert.equal(rows[0]!.found, false, `${schema}.${name} holds the login or the code`);
    }
    const logged = `${logs.join('')}${JSON.stringify(managerLogs)}`;
    assert.ok(logged.length > 1000, 'control: the API did log its requests');
    for (const forbidden of [secret, code, 'oauth/authorize', PROMPT, 'ada.lovelace']) assert.ok(!logged.includes(forbidden), `a log holds ${forbidden}`);
  });

  test('a sign-in to a different account shows a notice until dismissed', async () => {
    const signOut = expectStatus(await browser.request('POST', AGENT_RUNTIME_SIGN_OUT_PATH, { body: { client: 'claude_code' } }), 200) as AgentRuntimeStatus;
    assert.equal(signOut.connections.claude_code?.state, 'signed_out');
    assert.equal(signOut.connections.claude_code?.signOut?.failed, false);
    const { home } = await bindingOf(ada);
    assert.equal(existsSync(join(home, '.credentials.json')), false, 'sign-out deleted the login');
    await writeFile(join(home, 'fake-account'), 'mallory@example.net', { mode: 0o600 });
    const view = await openConsole(browser);
    attach(view, await ticketFor(browser, 'sso'));
    await until('the prompt', () => view.output.includes(PROMPT));
    typeInto(view, pastedLine(view.output, 'fake-code-second'));
    await view.closed;
    const done = view.messages.at(-1);
    assert.ok(done?.t === 'done' && done.signedIn, JSON.stringify(view.messages));
    assert.equal(done.status.connections.claude_code?.accountLabel, 'm***@example.net');
    assert.equal(done.status.connections.claude_code?.accountChange?.previousLabel, 'a***@example.org');
    const dismissed = expectStatus(await browser.request('POST', AGENT_RUNTIME_NOTICE_PATH, { body: { client: 'claude_code' } }), 200) as AgentRuntimeStatus;
    assert.equal(dismissed.connections.claude_code?.accountChange, null);
  });

  test('a failed logout still deletes the login and tells the owner', async () => {
    const { home } = await bindingOf(ada);
    await writeFile(join(home, 'fake-scenario'), 'logout_fails', { mode: 0o600 });
    const out = expectStatus(await browser.request('POST', AGENT_RUNTIME_SIGN_OUT_PATH, { body: { client: 'claude_code' } }), 200) as AgentRuntimeStatus;
    assert.equal(out.connections.claude_code?.state, 'signed_out');
    assert.equal(out.connections.claude_code?.signOut?.failed, true);
    assert.equal(existsSync(join(home, '.credentials.json')), false);
    assert.equal(existsSync(join(home, 'fake-scenario')), false, 'every file of the CLI was deleted');
  });

  test('no setup-token, auth.json, session or API-key field: every request outside the closed shapes is refused', async () => {
    const extra = [{ setupToken: 'sk-ant-oat01-x' }, { apiKey: 'sk-ant-api03-x' }, { authJson: '{}' }, { sessionKey: 'x' }, { token: 'x' }, { credentials: {} }, { oauthToken: 'x' }];
    for (const fields of extra) {
      for (const [path, body] of [[AGENT_RUNTIME_CONSOLE_PATH, { client: 'claude_code', method: 'sso' }], [AGENT_RUNTIME_SIGN_OUT_PATH, { client: 'claude_code' }],
        [AGENT_RUNTIME_CHECK_PATH, { client: 'claude_code' }], [AGENT_RUNTIME_NOTICE_PATH, { client: 'claude_code' }]] as const) {
        const refused = expectStatus(await browser.request('POST', path, { body: { ...body, ...fields } }), 400) as { code: string };
        assert.equal(refused.code, 'AGENT_RUNTIME_INVALID_INPUT', `${path} ${JSON.stringify(fields)}`);
      }
    }
    for (const body of [{ client: 'claude_code', method: 'setup_token' }, { client: 'claude_code', method: 'api_key' }, { client: 'codex', method: 'sso' }, { client: 'claude_code' }]) {
      expectStatus(await browser.request('POST', AGENT_RUNTIME_CONSOLE_PATH, { body }), 400);
    }
    expectStatus(await browser.request('POST', `${AGENT_RUNTIME_CONSOLE_PATH}?method=sso`, { body: { client: 'claude_code', method: 'sso' } }), 400);
    expectStatus(await browser.request('POST', AGENT_RUNTIME_BINDING_PATH, { body: { setupToken: 'x' } }), 400);
  });

  test('Remove runtime signs out first, deletes the directory and frees the slot; a failed logout is told', async () => {
    const { id, home, dataDir } = await bindingOf(ada);
    const slotName = (await pool.query<{ slot: string }>('SELECT slot FROM agent_runtime_bindings WHERE id = $1', [id])).rows[0]!.slot;
    await writeFile(join(home, 'fake-scenario'), 'logout_fails', { mode: 0o600 });
    await writeFile(join(home, '.credentials.json'), '{"fakeMethod":"claude_account"}', { mode: 0o600 });
    const removing = expectStatus(await browser.request('DELETE', AGENT_RUNTIME_BINDING_PATH), 202) as AgentRuntimeStatus;
    assert.equal(removing.binding?.state, 'releasing');
    assert.equal(removing.connections.claude_code, null, 'the connection is revoked at once');
    await reconcileAgentRuntime({ config, store: agentRuntimeStore(db), manager: runtimeManagerPort(createRuntimeManagerClient(config.manager!)) });
    const removed = await status(browser);
    assert.equal(removed.binding, null);
    assert.equal(removed.lastRelease?.reason, 'owner');
    assert.equal(removed.lastRelease?.signOutFailed, true);
    assert.equal(existsSync(join(dataDir, id)), false, 'the binding directory is gone');
    const { rows } = await pool.query<{ state: string }>('SELECT state FROM agent_runtime_slots WHERE slot = $1', [slotName]);
    assert.equal(rows[0]?.state, 'wiping', 'freed once a new supervisor reports an empty /data');
  });
});
