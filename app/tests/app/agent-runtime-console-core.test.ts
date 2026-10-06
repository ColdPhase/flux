import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import {
  CONSOLE_FRAME, CONSOLE_LIMITS, CONSOLE_UPGRADE_ANSWER, ConsoleFrameReader, ConsoleLink, ConsoleStreamError, callSupervisor, encodeControl, encodeInput,
  encodeOpen, encodeOutput, encodeResize, openConsoleUpgrade, type ConsoleControl, type SupervisorResult,
} from '@flux/runtime-protocol';
import { createManagerServer } from '../../apps/runtime/src/manager/server.js';
import { ConsoleTickets, parseClientMessage } from '../../apps/server/src/agent-runtime/console.js';
import type { ConsoleClock } from '../../apps/runtime/src/supervisor/pty.js';
import { CLAUDE_LOGIN_HELP_OPTIONS, LOGIN_TEMPLATES, unofferedLoginOptions } from '../../apps/runtime/src/supervisor/templates.js';
import { maskAccount, statusFacts } from '../../apps/runtime/src/supervisor/status.js';
import { portOf, slotSecret, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// F-022 T4 (#279): the Claude Code sign-in console in a slot's supervisor and through runtime-manager,
// in process, with real PTYs (node-pty) and the TEST ONLY fake `claude`, whose `auth login` behaves as
// the pinned Claude Code 2.1.285 did in a terminal (2026-10-06): an OSC 8 sign-in URL, then "Paste code
// here if prompted > ". No database, no network beyond loopback.

type Login = { output: string; controls: ConsoleControl[]; link: ConsoleLink<'from_supervisor'>; ended: Promise<void> };

/** Opens a console upgrade to `path` and collects what comes back. */
async function connect(port: number, secret: string, path = '/v1/login'): Promise<Login> {
  const answer = await openConsoleUpgrade({ host: '127.0.0.1', port, path, secret });
  assert.ok(answer.ok, `upgrade refused: ${JSON.stringify(answer)}`);
  const link = new ConsoleLink(answer.socket, new ConsoleFrameReader('from_supervisor'));
  const login: Login = { output: '', controls: [], link, ended: new Promise((done) => link.onEnd(() => done())) };
  link.onFrame((frame) => {
    if (frame.type === 'output') login.output += frame.data.toString('utf8');
    else login.controls.push(frame.frame);
  });
  link.start(answer.head);
  return login;
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resume) => setTimeout(resume, 20));
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const result = (login: Login) => login.controls.find((frame): frame is { t: 'result'; result: SupervisorResult } => frame.t === 'result')?.result;
const errorOf = (login: Login) => login.controls.find((frame) => frame.t === 'error' || frame.t === 'relay_error') as { code: string } | undefined;
const target = (slot: TestSlot) => ({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });

async function bound(slot: TestSlot, options: { secret?: string; account?: string; scenario?: string } = {}) {
  const bindingId = randomUUID();
  assert.ok((await callSupervisor(target(slot), { kind: 'bind', bindingId })).ok);
  const home = join(slot.config.dataDir, bindingId, 'claude');
  if (options.secret) await writeFile(join(home, 'fake-secret'), options.secret, { mode: 0o600 });
  if (options.account) await writeFile(join(home, 'fake-account'), options.account, { mode: 0o600 });
  if (options.scenario) await writeFile(join(home, 'fake-scenario'), options.scenario, { mode: 0o600 });
  return { bindingId, home };
}

async function calls(home: string) {
  const text = await readFile(join(home, 'fake-calls.jsonl'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; pid: number; tty: boolean; envNames: string[]; env: Record<string, string>; event?: string; code?: string });
}

const PROMPT = 'Paste code here if prompted > ';
const open = (bindingId: string, method: string, extra: Record<string, unknown> = {}) => encodeOpen({ bindingId, client: 'claude_code', method, cols: 60, rows: 20, ...extra });

/** Timers a test advances by hand (the 15-minute end without waiting 15 minutes). */
function manualClock() {
  let now = 0;
  const timers = new Map<number, { at: number; ms: number; callback: () => void }>();
  let next = 1;
  const clock: ConsoleClock = {
    setTimeout: (callback, ms) => { const id = next++; timers.set(id, { at: now + ms, ms, callback }); return id; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
  };
  return {
    clock,
    pending: () => [...timers.values()].map((timer) => timer.ms),
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
        if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

/** A fresh slot for one test: a release ends a supervisor for good (in a slot, the restart policy brings a new one). */
async function withSlot(work: (slot: TestSlot) => Promise<void>, options: Parameters<typeof startTestSlot>[0] = {}) {
  const slot = await startTestSlot({ enabled: ['claude_code'], ...options });
  try { await work(slot); } finally { await slot.close(); }
}

describe('each sign-in method runs exactly its command in a PTY', () => {
  for (const method of ['claude_account', 'console', 'sso'] as const) {
    test(`${method}: the CLI's URL is shown, a pasted code reaches its prompt, then its status decides`, () => withSlot(async (slot) => {
      const secret = `seeded-${randomBytes(12).toString('hex')}`;
      const { bindingId, home } = await bound(slot, { secret, account: 'Ada.Lovelace@example.org' });
      const login = await connect(portOf(slot.url), slot.config.secret);
      login.link.send(open(bindingId, method));
      await until('the prompt', () => login.output.includes(PROMPT));
      // The URL as the CLI prints it, an OSC 8 hyperlink, for this method's sign-in page.
      const host = method === 'console' ? 'https://platform.claude.com/oauth/authorize' : 'https://claude.com/cai/oauth/authorize';
      assert.match(login.output, new RegExp(`\\u001b\\]8;;${host.replace(/[/.]/g, '\\$&')}\\?[^\\u0007]+\\u0007`));
      if (method === 'sso') assert.match(login.output, /login_method=sso/);
      assert.deepEqual(login.controls.map((frame) => frame.t), ['accepted', 'console']);
      const started = await calls(home);
      assert.deepEqual(started.map((entry) => entry.argv), [[...LOGIN_TEMPLATES.claude_code[method]!]], 'exactly the method\'s command');
      assert.equal(started[0]!.tty, true, 'in a terminal');
      assert.equal(started[0]!.env.TERM, 'xterm-256color');
      assert.ok(!started[0]!.envNames.some((name) => /FLUX|SECRET/.test(name)), `no supervisor variable reaches the CLI: ${started[0]!.envNames}`);
      assert.equal(alive(started[0]!.pid), true);
      // Not signed in before the code: the CLI is still at its prompt.
      assert.equal(result(login), undefined);
      login.link.send(encodeInput(Buffer.from('fake-code-abc123\r')));
      await login.ended;
      const done = result(login);
      assert.ok(done?.kind === 'login', JSON.stringify(login.controls));
      assert.equal(done.ended, 'exited');
      assert.equal(done.exitCode, 0);
      assert.equal(done.status.signedIn, true);
      assert.deepEqual(done.status.facts, { authMethod: method === 'console' ? 'api_key' : 'claude.ai', plan: method === 'console' ? null : method === 'sso' ? 'enterprise' : 'max',
        accountLabel: 'a***@example.org', accountDigest: done.status.facts!.accountDigest });
      assert.match(done.status.facts!.accountDigest!, /^[0-9a-f]{64}$/);
      const all = await calls(home);
      assert.equal(all.find((entry) => entry.event === 'code')?.code, 'fake-code-abc123', 'the pasted code reached the CLI\'s prompt');
      assert.deepEqual(all.filter((entry) => !entry.event).map((entry) => entry.argv), [[...LOGIN_TEMPLATES.claude_code[method]!], ['auth', 'status']],
        'the login command and then its status, nothing else');
      // The PTY ended with the command; the seeded login is only in the CLI's own file.
      await until("the CLI to exit", () => !alive(started[0]!.pid));
      assert.ok((await readFile(join(home, '.credentials.json'), 'utf8')).includes(secret));
      assert.ok(!login.output.includes(secret) && !JSON.stringify(login.controls).includes(secret), 'no frame carries the login');
      assert.ok(!JSON.stringify(login.controls).includes('Ada.Lovelace'), 'the address never leaves the slot');
    }));
  }
});

describe('the console signs in only when the CLI\'s status says so', () => {
  test('a login command that exits 0 without a login is not a sign-in', () => withSlot(async (slot) => {
    const { bindingId } = await bound(slot, { scenario: 'login_without_credentials' });
    const login = await connect(portOf(slot.url), slot.config.secret);
    login.link.send(open(bindingId, 'claude_account'));
    await until('the prompt', () => login.output.includes(PROMPT));
    login.link.send(encodeInput(Buffer.from('fake-code-ok\r')));
    await login.ended;
    const done = result(login);
    assert.ok(done?.kind === 'login');
    assert.equal(done.exitCode, 0, 'the command itself succeeded');
    assert.equal(done.status.signedIn, false, 'but its status reports no login');
    assert.equal(done.status.facts, null);
  }));

  test('typed text is only input for the CLI\'s prompt: a wrong code or shell text runs nothing', () => withSlot(async (slot) => {
    const { bindingId, home } = await bound(slot);
    const login = await connect(portOf(slot.url), slot.config.secret);
    login.link.send(open(bindingId, 'claude_account'));
    await until('the prompt', () => login.output.includes(PROMPT));
    const marker = join(slot.config.tmpDir, 'pwned');
    login.link.send(encodeInput(Buffer.from(`$(touch ${marker}); sh -c 'touch ${marker}'\r`)));
    await login.ended;
    assert.match(login.output, /Invalid code/);
    const done = result(login);
    assert.ok(done?.kind === 'login' && done.exitCode === 1 && !done.status.signedIn);
    assert.deepEqual((await readdir(slot.config.tmpDir)), [], 'nothing ran');
    assert.deepEqual((await calls(home)).filter((entry) => !entry.event).map((entry) => entry.argv), [['auth', 'login'], ['auth', 'status']]);
  }));
});

describe('the console cannot run any other command', () => {
  let slot: TestSlot;
  let bindingId: string;
  let home: string;
  before(async () => { slot = await startTestSlot({ enabled: ['claude_code'] }); ({ bindingId, home } = await bound(slot)); });
  after(async () => { await slot.close(); });

  test('every refused console starts no CLI; a valid one does (control)', async () => {
    const refused: [string, Buffer, string][] = [
      ['an unknown method', open(bindingId, 'setup_token'), 'invalid_request'],
      ['a Codex method for Claude Code', open(bindingId, 'device_code'), 'invalid_request'],
      ['a smuggled command line', open(bindingId, 'sso', { argv: ['sh', '-c', 'id'] }), 'invalid_request'],
      ['a smuggled flag', open(bindingId, 'sso', { flags: ['--dangerously-skip-permissions'] }), 'invalid_request'],
      ['a smuggled environment', open(bindingId, 'sso', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }), 'invalid_request'],
      ['a path for the binding', encodeOpen({ bindingId: '../../etc', client: 'claude_code', method: 'sso', cols: 60, rows: 20 }), 'invalid_request'],
      ['an impossible terminal size', open(bindingId, 'sso', { cols: 5000 }), 'invalid_request'],
      ['input before the login request', encodeInput(Buffer.from('claude --help\r')), 'invalid_request'],
      ['another binding', open(randomUUID(), 'sso'), 'no_binding'],
      ['Codex, which the operator did not enable', encodeOpen({ bindingId, client: 'codex', method: 'device_code', cols: 60, rows: 20 }), 'client_off'],
    ];
    for (const [what, frame, code] of refused) {
      const login = await connect(portOf(slot.url), slot.config.secret);
      login.link.send(frame);
      await login.ended;
      assert.equal(errorOf(login)?.code, code, what);
      assert.equal(login.output, '', what);
    }
    assert.deepEqual(await calls(home), [], 'no CLI ran for any refused console');
    // A raw frame of an unknown type, or an oversized one, ends the console without an answer.
    for (const raw of [Buffer.from([0x7f, 0, 0, 0, 1, 0]), Buffer.concat([Buffer.from([CONSOLE_FRAME.input, 0, 0, 0x10, 0])])]) {
      const login = await connect(portOf(slot.url), slot.config.secret);
      login.link.send(raw);
      await login.ended;
      assert.equal(login.controls.length, 0);
    }
    assert.deepEqual(await calls(home), []);
    // Control: the same console with a valid request runs the command.
    const login = await connect(portOf(slot.url), slot.config.secret);
    login.link.send(open(bindingId, 'sso'));
    await until('the prompt', () => login.output.includes(PROMPT));
    assert.deepEqual((await calls(home)).map((entry) => entry.argv), [['auth', 'login', '--sso']]);
    login.link.destroy();
    await until('the console to end', async () => !alive((await calls(home))[0]!.pid));
  });

  test('the upgrade needs the slot secret, the console path and the console protocol', async () => {
    const port = portOf(slot.url);
    assert.deepEqual(await openConsoleUpgrade({ host: '127.0.0.1', port, path: '/v1/login', secret: slotSecret() }), { ok: false, code: 'unauthorized', status: 401 });
    for (const path of ['/v1/shell', '/v1/run', '/v1/login?method=sso', '/v1/status']) {
      const answer = await openConsoleUpgrade({ host: '127.0.0.1', port, path, secret: slot.config.secret });
      assert.equal(answer.ok, false, path);
      assert.equal((answer as { status?: number }).status, 404, path);
    }
    // A WebSocket upgrade (another protocol) is not the console.
    const websocket = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/login', headers: { authorization: `Bearer ${slot.config.secret}`, connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(websocket, 404);
  });
});

describe('the PTY ends on exit, on disconnect and after 15 minutes', () => {
  test('on disconnect: closing the connection kills the CLI and frees the lane', async () => {
    const slot = await startTestSlot({ enabled: ['claude_code'] });
    try {
      const { bindingId, home } = await bound(slot);
      const login = await connect(portOf(slot.url), slot.config.secret);
      login.link.send(open(bindingId, 'claude_account'));
      await until('the prompt', () => login.output.includes(PROMPT));
      const pid = (await calls(home))[0]!.pid;
      await new Promise((resume) => setTimeout(resume, 300));
      assert.equal(alive(pid), true, 'control: still running while connected');
      login.link.destroy();
      await until('the CLI to be killed', () => !alive(pid), 5_000);
      // No status ran for a console nobody is attached to, and the next console runs at once.
      assert.deepEqual((await calls(home)).map((entry) => entry.argv), [['auth', 'login']]);
      const next = await connect(portOf(slot.url), slot.config.secret);
      next.link.send(open(bindingId, 'console'));
      await until('the next prompt', () => next.output.includes(PROMPT));
      next.link.destroy();
    } finally { await slot.close(); }
  });

  test('after 15 minutes (injected timers): not a moment before, then the CLI is ended and its status reported', async () => {
    const timers = manualClock();
    const slot = await startTestSlot({ enabled: ['claude_code'], console: { clock: timers.clock } });
    try {
      const { bindingId, home } = await bound(slot, { scenario: 'login_hangs' });
      const login = await connect(portOf(slot.url), slot.config.secret);
      login.link.send(open(bindingId, 'claude_account'));
      await until('the prompt', () => login.output.includes(PROMPT));
      assert.ok(timers.pending().includes(15 * 60_000), `the lifetime is 15 minutes: ${timers.pending()}`);
      assert.equal(CONSOLE_LIMITS.lifetimeMs, 15 * 60_000);
      const pid = (await calls(home))[0]!.pid;
      timers.advance(15 * 60_000 - 1);
      await new Promise((resume) => setTimeout(resume, 300));
      assert.equal(alive(pid), true, 'control: still running one millisecond before');
      timers.advance(1);
      await until('the CLI to be ended', () => !alive(pid), 5_000);
      await login.ended;
      assert.ok(login.controls.some((frame) => frame.t === 'console' && frame.state === 'timed_out'));
      const done = result(login);
      assert.ok(done?.kind === 'login' && done.ended === 'timed_out' && done.exitCode === null && !done.status.signedIn, JSON.stringify(done));
    } finally { await slot.close(); }
  });

  test('a console with no login request within the time allowed is refused', async () => {
    const timers = manualClock();
    const slot = await startTestSlot({ enabled: ['claude_code'], console: { clock: timers.clock } });
    try {
      const login = await connect(portOf(slot.url), slot.config.secret);
      await until('the open timer', () => timers.pending().includes(CONSOLE_LIMITS.openWithinMs));
      timers.advance(CONSOLE_LIMITS.openWithinMs);
      await login.ended;
      assert.equal(errorOf(login)?.code, 'invalid_request');
    } finally { await slot.close(); }
  });

  test('a second console waits for the first, then is refused as busy; a release ends an open console', async () => {
    const slot = await startTestSlot({ enabled: ['claude_code'] });
    try {
      const { bindingId, home } = await bound(slot);
      const first = await connect(portOf(slot.url), slot.config.secret);
      first.link.send(open(bindingId, 'claude_account'));
      await until('the prompt', () => first.output.includes(PROMPT));
      const second = await connect(portOf(slot.url), slot.config.secret);
      second.link.send(open(bindingId, 'sso'));
      await second.ended;
      assert.equal(errorOf(second)?.code, 'busy');
      assert.deepEqual((await calls(home)).map((entry) => entry.argv), [['auth', 'login']], 'the second never started');
      const pid = (await calls(home))[0]!.pid;
      const released = await callSupervisor(target(slot), { kind: 'release', bindingId });
      assert.ok(released.ok && released.result.kind === 'release' && released.result.dataEmpty, JSON.stringify(released));
      await first.ended;
      assert.equal(alive(pid), false);
    } finally { await slot.close(); }
  });
});

describe('runtime-manager relays the console and checks it', () => {
  let slot: TestSlot;
  let manager: Server;
  let port: number;
  const managerSecret = slotSecret();
  const logged: Record<string, unknown>[] = [];
  before(async () => {
    slot = await startTestSlot({ enabled: ['claude_code'] });
    manager = createManagerServer({ secret: managerSecret, slots: new Map([['runtime-1', target(slot)]]), log: (event) => logged.push(event) });
    await new Promise<void>((done) => manager.listen(0, '127.0.0.1', done));
    port = (manager.address() as AddressInfo).port;
  });
  after(async () => { manager.closeAllConnections(); await new Promise((done) => manager.close(done)); await slot.close(); });

  test('the API\'s console reaches the owner\'s slot through the manager, and the log names only the outcome', async () => {
    const secret = `seeded-${randomBytes(12).toString('hex')}`;
    const { bindingId } = await bound(slot, { secret });
    const login = await connect(port, managerSecret, '/v1/slots/runtime-1/login');
    login.link.send(open(bindingId, 'console'));
    login.link.send(encodeResize(80, 24));
    await until('the prompt', () => login.output.includes(PROMPT));
    login.link.send(encodeInput(Buffer.from('fake-code-relay\r')));
    await login.ended;
    const done = result(login);
    assert.ok(done?.kind === 'login' && done.status.signedIn, JSON.stringify(login.controls));
    await until('the log line', () => logged.some((event) => event.event === 'console'));
    const line = logged.find((event) => event.event === 'console')!;
    assert.deepEqual(Object.keys(line).sort(), ['event', 'ms', 'outcome', 'slot']);
    assert.equal(line.outcome, 'ended');
    const text = JSON.stringify(logged);
    for (const forbidden of [secret, 'fake-code-relay', 'oauth/authorize', PROMPT]) assert.ok(!text.includes(forbidden), `the log holds ${forbidden}`);
    // Signed out again (the CLI's logout, then its files are deleted) and the directory removed, for the next test.
    assert.ok((await callSupervisor(target(slot), { kind: 'logout', bindingId, client: 'claude_code' })).ok);
    await rm(join(slot.config.dataDir, bindingId), { recursive: true, force: true });
  });

  test('a wrong service secret, an unknown slot or a request outside the closed set never reaches a supervisor', async () => {
    const { bindingId, home } = await bound(slot);
    assert.deepEqual(await openConsoleUpgrade({ host: '127.0.0.1', port, path: '/v1/slots/runtime-1/login', secret: slot.config.secret }), { ok: false, code: 'unauthorized', status: 401 });
    for (const path of ['/v1/slots/runtime-2/login', '/v1/slots/../login', '/v1/slots/runtime-1/run', '/v1/slots/runtime-1/status']) {
      const answer = await openConsoleUpgrade({ host: '127.0.0.1', port, path, secret: managerSecret });
      assert.equal(answer.ok, false, path);
    }
    for (const frame of [open(bindingId, 'api_key'), open(bindingId, 'sso', { command: 'id' }), encodeInput(Buffer.from('x'))]) {
      const login = await connect(port, managerSecret, '/v1/slots/runtime-1/login');
      login.link.send(frame);
      await login.ended;
      assert.deepEqual(login.controls, [{ t: 'relay_error', code: 'invalid_request' }]);
    }
    assert.deepEqual(await calls(home), [], 'no CLI ran');
    // A plain (non-upgrade) login request is refused by the manager as well.
    const plain = await fetch(`http://127.0.0.1:${port}/v1/slots/runtime-1/login`, { method: 'POST', headers: { authorization: `Bearer ${managerSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bindingId, client: 'claude_code', method: 'sso', cols: 80, rows: 24 }) });
    assert.equal(plain.status, 400);
    await rm(join(slot.config.dataDir, bindingId), { recursive: true, force: true });
  });

  test('a misbehaving supervisor is cut off: malformed, oversized or relay-claiming frames end the console', async () => {
    for (const misbehave of [
      Buffer.from([0x99, 0, 0, 0, 1, 1]),
      Buffer.concat([Buffer.from([CONSOLE_FRAME.output, 0, 1, 0, 0])]),
      encodeControl({ t: 'relay_error', code: 'busy' }),
      Buffer.concat([Buffer.from([CONSOLE_FRAME.control, 0, 0, 0, 5]), Buffer.from('{"t":')]),
    ]) {
      const rogue = createServer();
      const sockets: Duplex[] = [];
      rogue.on('upgrade', (_req, socket) => { sockets.push(socket); socket.write(CONSOLE_UPGRADE_ANSWER); socket.write(encodeOutput(Buffer.from('hello'))); socket.write(misbehave); });
      await new Promise<void>((done) => rogue.listen(0, '127.0.0.1', done));
      const rogueManager = createManagerServer({ secret: managerSecret, log: () => undefined,
        slots: new Map([['runtime-1', { host: '127.0.0.1', port: (rogue.address() as AddressInfo).port, secret: slotSecret() }]]) });
      await new Promise<void>((done) => rogueManager.listen(0, '127.0.0.1', done));
      try {
        const login = await connect((rogueManager.address() as AddressInfo).port, managerSecret, '/v1/slots/runtime-1/login');
        login.link.send(open(randomUUID(), 'sso'));
        await login.ended;
        assert.ok(login.controls.every((frame) => frame.t === 'relay_error'), JSON.stringify(login.controls));
      } finally {
        for (const socket of sockets) socket.destroy();
        rogue.closeAllConnections(); rogueManager.closeAllConnections();
        await new Promise((done) => rogue.close(done));
        await new Promise((done) => rogueManager.close(done));
      }
    }
  });
});

describe('console frames are size-bounded and closed', () => {
  test('the reader refuses unknown, oversized, empty and out-of-set frames; random input never escapes as another error', () => {
    const toSupervisor = () => new ConsoleFrameReader('to_supervisor');
    assert.deepEqual(toSupervisor().push(encodeResize(80, 24)), [{ type: 'resize', cols: 80, rows: 24 }]);
    for (const bad of [encodeResize(19, 24), encodeResize(80, 121), encodeOutput(Buffer.from('x')), Buffer.from([CONSOLE_FRAME.input, 0, 0, 0, 0]),
      Buffer.from([CONSOLE_FRAME.input, 0, 0, 0x04, 0x01]), Buffer.concat([Buffer.from([CONSOLE_FRAME.open, 0, 0, 0, 2]), Buffer.from('[]')])]) {
      assert.throws(() => toSupervisor().push(bad), ConsoleStreamError, bad.subarray(0, 5).toString('hex'));
    }
    const typed = toSupervisor();
    assert.throws(() => { for (let i = 0; i < 70; i += 1) typed.push(encodeInput(Buffer.alloc(1024, 0x61))); }, (error: ConsoleStreamError) => error.code === 'input_too_large');
    const fromSupervisor = () => new ConsoleFrameReader('from_supervisor');
    assert.throws(() => fromSupervisor().push(encodeControl({ t: 'error', code: 'shell' } as unknown as ConsoleControl)), ConsoleStreamError);
    assert.throws(() => fromSupervisor().push(encodeInput(Buffer.from('x'))), ConsoleStreamError);
    // A frame split at every byte boundary still decodes.
    const whole = Buffer.concat([encodeOutput(Buffer.from('abc')), encodeControl({ t: 'console', state: 'started' })]);
    const split = fromSupervisor();
    const frames = [...whole].flatMap((byte) => split.push(Buffer.from([byte])));
    assert.equal(frames.length, 2);
    for (let i = 0; i < 2000; i += 1) {
      const reader = i % 2 ? toSupervisor() : fromSupervisor();
      const noise = randomBytes(1 + Math.floor(Math.random() * 64));
      try { reader.push(noise); } catch (error) { assert.ok(error instanceof ConsoleStreamError); }
    }
  });
});

describe('display facts and the login methods', () => {
  test('status facts: signed in only on exit 0 and a login; the address is masked and digested in the slot', () => {
    const status = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'Jo.Doe@Example.org', orgId: 'org-1', subscriptionType: 'max' });
    const facts = statusFacts('claude_code', 0, status);
    assert.equal(facts.signedIn, true);
    assert.equal(facts.facts?.accountLabel, 'j***@example.org');
    assert.equal(facts.facts?.plan, 'max');
    assert.ok(!JSON.stringify(facts).includes('Jo.Doe'));
    assert.deepEqual(statusFacts('claude_code', 1, status), { signedIn: false, facts: null }, 'exit code 1 is signed out');
    // The real CLI, signed out (Claude Code 2.1.285, 2026-10-06).
    assert.deepEqual(statusFacts('claude_code', 1, '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'), { signedIn: false, facts: null });
    assert.deepEqual(statusFacts('claude_code', 0, '{"loggedIn": false}'), { signedIn: false, facts: null });
    assert.equal(statusFacts('claude_code', 0, JSON.stringify({ loggedIn: true, authMethod: 'Bearer sk-ant-x' })).facts?.authMethod, 'unknown');
    assert.equal(statusFacts('claude_code', 0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'sk-ant-oat01-'.padEnd(80, 'x') })).facts?.plan, null);
    for (const [address, label] of [['a@B.C', 'a***@b.c'], ['@x.org', null], ['x@', null], ['ü@x.org', '****@x.org'], ['a@exa mple.org', 'a***@*'], ['nobody', null]] as const) {
      assert.equal(maskAccount(address), label, address);
    }
  });

  test('the console offers every option of the pinned `claude auth login --help`, or the check fails', () => {
    // Claude Code 2.1.285, `claude auth login --help`, recorded 2026-10-06 (scripts/check_runtime_cli_contract.sh runs it live).
    const help = `Usage: claude auth login [options]

Sign in to your Anthropic account

Options:
  --claudeai       Use Claude subscription (default)
  --console        Use Anthropic Console (API usage billing) instead of Claude
                   subscription
  --email <email>  Pre-populate email address on the login page
  -h, --help       Display help for command
  --sso            Force SSO login flow
`;
    assert.deepEqual(unofferedLoginOptions(help), []);
    const methods = Object.values(CLAUDE_LOGIN_HELP_OPTIONS).map((option) => option.method).filter(Boolean).sort();
    assert.deepEqual(methods, ['claude_account', 'console', 'sso']);
    for (const method of methods) assert.ok(LOGIN_TEMPLATES.claude_code[method!], `${method} has a command`);
    // Control: a new method in a later CLI fails the check.
    assert.deepEqual(unofferedLoginOptions(`${help}  --device-code    Sign in with a device code\n`), ['--device-code']);
  });
});

describe('the API\'s console tickets and browser messages', () => {
  test('a ticket works once, for its owner and session, for one minute', () => {
    let now = Date.parse('2026-10-06T12:00:00Z');
    const tickets = new ConsoleTickets('a'.repeat(48), () => now);
    const issue = () => tickets.issue({ ownerUserId: 'ada', client: 'claude_code', method: 'sso' }, 'session-1').ticket;
    assert.deepEqual(tickets.redeem(issue(), 'ada', 'session-1'), { ownerUserId: 'ada', client: 'claude_code', method: 'sso' }, 'control');
    const ticket = issue();
    assert.equal(tickets.redeem(ticket, 'bo', 'session-1'), null, 'another member');
    assert.equal(tickets.redeem(ticket, 'ada', 'session-2'), null, 'another session of the owner');
    assert.ok(tickets.redeem(ticket, 'ada', 'session-1'));
    assert.equal(tickets.redeem(ticket, 'ada', 'session-1'), null, 'used once');
    const late = issue();
    now += 60_001;
    assert.equal(tickets.redeem(late, 'ada', 'session-1'), null, 'expired after a minute');
    const [body, mac] = issue().split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), m: 'console' })).toString('base64url');
    assert.equal(tickets.redeem(`${forged}.${mac}`, 'ada', 'session-1'), null, 'a changed method breaks the signature');
    assert.equal(new ConsoleTickets('b'.repeat(48), () => now).redeem(issue(), 'ada', 'session-1'), null, 'another server secret');
    for (const junk of [undefined, 7, '', 'x', 'a.b.c', 'x'.repeat(600)]) assert.equal(tickets.redeem(junk, 'ada', 'session-1'), null);
  });

  test('browser messages are exactly the closed shapes; nothing carries a credential', () => {
    assert.deepEqual(parseClientMessage('{"t":"attach","ticket":"x","cols":80,"rows":24}'), { t: 'attach', ticket: 'x', cols: 80, rows: 24 });
    assert.deepEqual(parseClientMessage('{"t":"in","d":"fake-code-1\\r"}'), { t: 'in', d: 'fake-code-1\r' });
    assert.deepEqual(parseClientMessage('{"t":"size","cols":40,"rows":30}'), { t: 'size', cols: 40, rows: 30 });
    for (const bad of ['{"t":"attach","ticket":"x","cols":80,"rows":24,"setupToken":"sk-ant-oat01"}', '{"t":"in","d":"x","apiKey":"sk"}',
      '{"t":"login","method":"sso"}', '{"t":"exec","command":"sh"}', `{"t":"in","d":"${'x'.repeat(257)}"}`, '{"t":"in","d":""}', '{"t":"size","cols":10,"rows":30}',
      '[]', 'null', 'not json']) {
      assert.equal(parseClientMessage(bad), null, bad);
    }
  });

  test('no field for a setup-token, auth.json, session or API key exists in the runtime\'s API contract or its pages', async () => {
    const FORBIDDEN = /setup.?token|auth\.json|api.?key|session.?(key|token)|oauth.?token|access.?token|refresh.?token|credential|password/i;
    // The request bodies and messages the browser may send, as the contract and the server define them.
    const contract = await readFile('packages/contracts/src/agent-runtime.ts', 'utf8');
    const requestTypes = [...contract.matchAll(/export (?:interface|type) (AgentRuntime(?:Console(?:Request|ClientMessage)|ClientRequest))\b[^{]*\{([^}]*)\}/g)];
    assert.ok(requestTypes.length >= 2, 'the request types were found');
    for (const [, name, body] of requestTypes) assert.doesNotMatch(body!, FORBIDDEN, name);
    // Every field a person can type into on the runtime's pages: the sign-in method (radio) and the code
    // for the CLI's own prompt. Nothing else.
    const pages = await Promise.all(['RuntimeSection.tsx', 'ClaudeCodeSignIn.tsx', 'SignInConsole.tsx'].map((file) => readFile(`apps/web/src/agent-runtime/${file}`, 'utf8')));
    const fields = pages.flatMap((page) => [...page.matchAll(/<(input|textarea|select)\b[^>]*>/g)].map((match) => match[0]));
    assert.deepEqual(fields.map((field) => /type="radio"/.test(field) ? 'radio' : /id="rt-code"/.test(field) ? 'code' : field), ['radio', 'code']);
    for (const field of fields) assert.doesNotMatch(field, FORBIDDEN);
    const labels = pages.flatMap((page) => [...page.matchAll(/<label\b[^>]*>([^<]*)/g)].map((match) => match[1]!.trim()).filter(Boolean));
    assert.ok(labels.includes('Paste the code from the sign-in page'), JSON.stringify(labels));
    for (const label of labels) assert.doesNotMatch(label, FORBIDDEN);
    // Control: the matcher catches such a field.
    for (const name of ['setupToken', 'setup_token', 'CLAUDE_CODE_OAUTH_TOKEN', 'auth.json', 'apiKey', 'sessionKey', 'Paste your API key']) assert.match(name, FORBIDDEN);
  });
});
