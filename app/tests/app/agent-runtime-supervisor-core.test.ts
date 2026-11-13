import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { callSupervisor, NdjsonReader, parseSupervisorFrame, type ClientStatus, type SupervisorCallOutcome, type SupervisorRequest } from '@flux/runtime-protocol';
import { clearClientFiles, clearLeftovers, clearScratch, hasUnconfirmed, recordUnconfirmed, removeBinding } from '../../apps/runtime/src/supervisor/data.js';
import { runFixed } from '../../apps/runtime/src/supervisor/process.js';
import { removeTreeScript, walkTree } from '../../apps/runtime/src/supervisor/tree.js';
import { Lane } from '../../apps/runtime/src/supervisor/server.js';
import { catalogForAccount, CLAUDE_MODELS_TEMPLATE, CLAUDE_OWN_TOOLS, CODEX_FEATURE_REVIEW, CODEX_MODEL_CATALOG, CODEX_MODEL_REVIEW, CODEX_NO_OWN_TOOLS, codexListOverrides, codexRunOverrides, fluxCodexCatalog, LOGOUT_TEMPLATES, RUN_TEMPLATES, sandboxEnvironment, STATUS_TEMPLATES } from '../../apps/runtime/src/supervisor/templates.js';
import { classifyCodexError, classifyError, CODEX_RESOURCE_READERS, codexResourceReader, codexSearchFound, effectiveConfigHolds, searchQuery, searchResultAddresses } from '../../apps/runtime/src/supervisor/run.js';
import { APP_SERVER_METHODS, openAppServer, readRateLimits } from '../../apps/runtime/src/supervisor/app-server.js';
import { claudeSignInReader, deviceSignInReader } from '../../apps/runtime/src/supervisor/device.js';
import { statusFacts } from '../../apps/runtime/src/supervisor/status.js';
import { portOf, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// F-022 T3: a slot's supervisor, in process, over temporary /data and /tmp with the TEST ONLY fake CLIs.
// No database and no network beyond loopback.

const target = (slot: TestSlot) => ({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });
type FixtureRequest<T> = T extends { bootId: string } ? Omit<T, 'bootId'> & { bootId?: string } : T;
const call = (slot: TestSlot, request: FixtureRequest<SupervisorRequest>) => callSupervisor(target(slot),
  ('client' in request && ['status', 'models', 'logout', 'login'].includes(request.kind) ? { bootId: slot.config.bootId, ...request } : request) as SupervisorRequest, { timeoutMs: 20_000 });

/** The client status of a successful status request, or a failed assertion. */
function clientStatus(out: SupervisorCallOutcome): ClientStatus {
  assert.ok(out.ok && out.result.kind === 'status' && 'client' in out.result, JSON.stringify(out));
  return (out.result as { client: ClientStatus }).client;
}

async function raw(slot: TestSlot, path: string, body: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${slot.url}${path}`, { method: 'POST', body,
    headers: { authorization: `Bearer ${slot.config.secret}`, 'content-type': 'application/json', ...headers } });
  const reader = new NdjsonReader(parseSupervisorFrame);
  const frames = reader.push(Buffer.from(await response.arrayBuffer()));
  reader.end();
  return { status: response.status, frames };
}

async function signIn(slot: TestSlot, bindingId: string, client: 'claude_code' | 'codex' = 'claude_code') {
  const file = join(slot.config.dataDir, bindingId, client === 'claude_code' ? 'claude' : 'codex', client === 'claude_code' ? '.credentials.json' : 'auth.json');
  await writeFile(file, '{"fake":true}', { mode: 0o600 });
  return file;
}

async function calls(slot: TestSlot, bindingId: string, client: 'claude' | 'codex' = 'claude') {
  const text = await readFile(join(slot.config.dataDir, bindingId, client, 'fake-calls.jsonl'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; cwd: string; envNames: string[]; env: Record<string, string> });
}

describe('the supervisor answers only its closed request set', () => {
  let slot: TestSlot;
  before(async () => { slot = await startTestSlot(); });
  after(async () => { await slot.close(); });

  test('refuses a missing or wrong secret before reading anything', async () => {
    for (const authorization of [undefined, 'Bearer wrong-secret-wrong-secret-wrong-secret', `Basic ${slot.config.secret}`, `Bearer ${slot.config.secret}x`]) {
      const response = await fetch(`${slot.url}/v1/status`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) } });
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse((await response.text()).trim()), { t: 'error', code: 'unauthorized' });
    }
    const other = await callSupervisor({ ...target(slot), secret: 'another-slots-secret-another-slots-secret' }, { kind: 'status' });
    assert.deepEqual(other, { ok: false, code: 'unauthorized' });
  });

  test('refuses any other request, method, body type or oversized body', async () => {
    for (const path of ['/v1/exec', '/v1/shell', '/v1/bind/x', '/v1/', '/status', '/v1/Bind', '/v1/status?x=1']) {
      const { status, frames } = await raw(slot, path, '{}');
      assert.equal(status, 404, path);
      assert.deepEqual(frames, [{ t: 'error', code: 'unknown_request' }]);
    }
    assert.equal((await fetch(`${slot.url}/v1/status`, { headers: { authorization: `Bearer ${slot.config.secret}` } })).status, 404);
    assert.deepEqual((await raw(slot, '/v1/status', '{}', { 'content-type': 'text/plain' })).frames, [{ t: 'error', code: 'invalid_request' }]);
    assert.deepEqual((await raw(slot, '/v1/status', '{not json')).frames, [{ t: 'error', code: 'invalid_request' }]);
    assert.deepEqual((await raw(slot, '/v1/bind', JSON.stringify({ bindingId: randomUUID(), pad: 'x'.repeat(70_000) }))).frames, [{ t: 'error', code: 'invalid_request' }]);
    const bindingId = randomUUID();
    for (const extra of [{ argv: ['sh'] }, { command: 'id' }, { env: { PATH: '/tmp' } }, { path: '/etc' }, { flags: ['--sso'] }]) {
      const { status, frames } = await raw(slot, '/v1/logout', JSON.stringify({ bindingId, client: 'claude_code', ...extra }));
      assert.equal(status, 400);
      assert.deepEqual(frames, [{ t: 'error', code: 'invalid_request' }]);
    }
    // Nothing was created by any refused request.
    assert.deepEqual(await readdir(slot.config.dataDir), []);
  });
});

describe('binding directories', () => {
  let slot: TestSlot;
  before(async () => { slot = await startTestSlot(); });
  after(async () => { await slot.close(); });

  test('bind creates /data/<uuid> 0700 with private CLI homes, is idempotent, and any number of people have theirs (#860)', async () => {
    const bindingId = randomUUID();
    const bound = await call(slot, { kind: 'bind', bindingId });
    assert.ok(bound.ok && bound.result.kind === 'bind' && bound.bootId === slot.config.bootId);
    const dir = join(slot.config.dataDir, bindingId);
    assert.equal((await lstat(dir)).mode & 0o777, 0o700);
    for (const sub of ['claude', 'codex', 'home', 'tmp']) assert.equal((await lstat(join(dir, sub))).mode & 0o777, 0o700);
    assert.ok((await call(slot, { kind: 'bind', bindingId })).ok, 'a retried bind of the same binding is accepted');
    const others = Array.from({ length: 6 }, () => randomUUID());
    for (const other of others) assert.ok((await call(slot, { kind: 'bind', bindingId: other })).ok, 'no fixed number of people');
    const report = await call(slot, { kind: 'status' });
    assert.ok(report.ok && report.result.kind === 'status' && 'slot' in report.result);
    assert.deepEqual(report.result.slot.data, { bindings: [bindingId, ...others].sort(), other: 0 });
    assert.equal(report.result.slot.slot, 'runtime-1');
    assert.equal(report.result.slot.capacity, 2);
    assert.deepEqual(report.result.slot.installed, { claude_code: true, codex: true });
  });

  test('an entry in /data that is not a person\'s directory is reported', async () => {
    const stray = await startTestSlot();
    try {
      for (const entry of ['.hidden', 'notes.txt', 'lost+found']) await writeFile(join(stray.config.dataDir, entry), '');
      await mkdir(join(stray.config.dataDir, 'not-a-uuid'));
      const report = await call(stray, { kind: 'status' });
      assert.ok(report.ok && 'slot' in report.result);
      assert.deepEqual(report.result.slot.data, { bindings: [], other: 4 });
    } finally { await stray.close(); }
  });

  test('a symlinked or loosened binding directory is refused for every CLI operation', async () => {
    const unsafe = await startTestSlot();
    try {
      const linked = randomUUID();
      await mkdir(join(unsafe.config.tmpDir, 'elsewhere'), { mode: 0o700 });
      await symlink(join(unsafe.config.tmpDir, 'elsewhere'), join(unsafe.config.dataDir, linked));
      for (const request of [{ kind: 'logout', bindingId: linked, client: 'claude_code' }, { kind: 'status', bindingId: linked, client: 'claude_code' }] as SupervisorRequest[]) {
        assert.deepEqual(await call(unsafe, request), { ok: false, code: 'binding_unsafe' });
      }
      const report = await call(unsafe, { kind: 'status' });
      assert.ok(report.ok && 'slot' in report.result && report.result.slot.data.other === 1 && report.result.slot.data.bindings.length === 0);
      // Release removes the link itself, never what it points to.
      const released = await call(unsafe, { kind: 'release', bindingId: linked });
      assert.ok(released.ok && released.result.kind === 'release' && released.result.deleted);
      assert.deepEqual(await readdir(unsafe.config.tmpDir), ['elsewhere']);
    } finally { await unsafe.close(); }
    const loose = await startTestSlot();
    try {
      const bindingId = randomUUID();
      assert.ok((await call(loose, { kind: 'bind', bindingId })).ok);
      await chmod(join(loose.config.dataDir, bindingId), 0o755);
      assert.deepEqual(await call(loose, { kind: 'logout', bindingId, client: 'claude_code' }), { ok: false, code: 'binding_unsafe' });
    } finally { await loose.close(); }
  });
});

describe('fixed command templates and a clean CLI environment', () => {
  let slot: TestSlot;
  const bindingId = randomUUID();
  before(async () => { slot = await startTestSlot({ enabled: ['claude_code'] }); assert.ok((await call(slot, { kind: 'bind', bindingId })).ok); });
  after(async () => { await slot.close(); });

  test('status runs exactly the template, in the binding directory, with only Flux\'s fixed variables', async () => {
    const first = clientStatus(await call(slot, { kind: 'status', bindingId, client: 'claude_code' }));
    assert.equal(first.signedIn, false);
    assert.equal(first.credentialFile, 'missing');
    const file = await signIn(slot, bindingId);
    const signed = clientStatus(await call(slot, { kind: 'status', bindingId, client: 'claude_code' }));
    assert.ok(signed.signedIn && signed.credentialFile === 'ok');
    await chmod(file, 0o644);
    assert.equal(clientStatus(await call(slot, { kind: 'status', bindingId, client: 'claude_code' })).credentialFile, 'loose_mode');
    const recorded = await calls(slot, bindingId);
    assert.equal(recorded.length, 3);
    const dir = join(slot.config.dataDir, bindingId);
    for (const entry of recorded) {
      assert.deepEqual(entry.argv, [...STATUS_TEMPLATES.claude_code]);
      assert.equal(entry.cwd, dir);
      assert.deepEqual(entry.envNames.filter((name) => !['PWD', 'SHLVL', '_'].includes(name)), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'HOME', 'HTTPS_PROXY', 'LANG', 'NO_PROXY', 'PATH', 'TMPDIR', 'https_proxy', 'no_proxy']);
      assert.equal(entry.env.CLAUDE_CONFIG_DIR, `${dir}/claude`);
      assert.equal(entry.env.HOME, `${dir}/home`);
      assert.equal(entry.env.HTTPS_PROXY, 'http://runtime-egress:3128');
      assert.ok(!JSON.stringify(entry).includes(slot.config.secret), 'the slot secret never reaches a CLI');
    }
  });

  test('a client the operator did not enable is refused; login runs only in the console; a run without a reachable Flux stops at its read-back', async () => {
    assert.deepEqual(await call(slot, { kind: 'status', bindingId, client: 'codex' }), { ok: false, code: 'client_off' });
    // A sign-in is never a plain request: only the console's upgrade runs `auth login` (T4).
    assert.deepEqual(await call(slot, { kind: 'login', bindingId, client: 'codex', method: 'device_code', cols: 80, rows: 24 }), { ok: false, code: 'invalid_request' });
    assert.deepEqual(await call(slot, { kind: 'login', bindingId, client: 'claude_code', method: 'sso', cols: 80, rows: 24 }), { ok: false, code: 'invalid_request' });
    const run: SupervisorRequest = { kind: 'run', bindingId, client: 'claude_code', runId: randomUUID(), prompt: 'Hello', runToken: 'aa.bb.cc', tools: ['flux_get_doc'],
      caps: { maxTurns: 10, wallClockSeconds: 300, idleSeconds: 60, maxAnswerBytes: 16384 } };
    // T5: the run starts; with no Flux MCP server reachable its start-up list shows no connected Flux, so it stops with no answer.
    const ran = await call(slot, run);
    assert.ok(ran.ok && ran.result.kind === 'run' && ran.result.outcome === 'local_tool' && ran.result.answer === null, JSON.stringify(ran));
    assert.deepEqual(await call(slot, { ...run, bindingId: randomUUID() }), { ok: false, code: 'no_binding' });
    const stop = await call(slot, { kind: 'stop', bindingId, runId: randomUUID() });
    assert.ok(stop.ok && stop.result.kind === 'stop' && stop.result.state === 'not_running');
  });

  test('#860: a release stops the person\'s run at once instead of waiting out its hour; nobody else\'s run is touched', async () => {
    const mcp = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { tools: [{ name: 'flux_get_doc' }] } }));
    });
    await new Promise<void>((listening) => mcp.listen(0, '127.0.0.1', listening));
    const server = await startTestSlot({ mcpUrl: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp` });
    try {
      const runOf = (id: string): SupervisorRequest => ({ kind: 'run', bindingId: id, client: 'claude_code', runId: randomUUID(), prompt: 'Hello', runToken: 'aa.bb.cc',
        tools: ['flux_get_doc'], caps: { maxTurns: 200, wallClockSeconds: 3600, idleSeconds: 600, maxAnswerBytes: 16384 } });
      const [ada, jonas] = [randomUUID(), randomUUID()];
      for (const id of [ada, jonas]) {
        assert.ok((await call(server, { kind: 'bind', bindingId: id })).ok);
        await writeFile(join(server.config.dataDir, id, 'claude', 'fake-scenario'), 'run_slow');
      }
      const [adaRequest, jonasRequest] = [runOf(ada), runOf(jonas)] as [Extract<SupervisorRequest, { kind: 'run' }>, Extract<SupervisorRequest, { kind: 'run' }>];
      const running = [call(server, adaRequest), call(server, jonasRequest)];
      for (const id of [ada, jonas]) {
        for (let tries = 0; !(await calls(server, id)).some((entry) => (entry as { event?: string }).event === 'tools_list'); tries += 1) {
          assert.ok(tries < 200, 'the CLI started');
          await new Promise((wait) => setTimeout(wait, 50));
        }
      }
      const third = randomUUID();
      assert.ok((await call(server, { kind: 'bind', bindingId: third })).ok);
      assert.deepEqual(await call(server, { kind: 'stop', bindingId: third, runId: jonasRequest.runId }), { ok: false, code: 'binding_mismatch' }, 'a stop names its person');
      const released = await call(server, { kind: 'release', bindingId: ada });
      assert.ok(released.ok && released.result.kind === 'release' && released.result.deleted, JSON.stringify(released));
      const ended = await running[0]!;
      assert.ok(ended.ok && ended.result.kind === 'run' && ended.result.outcome === 'stopped', JSON.stringify(ended));
      const report = await call(server, { kind: 'status' });
      assert.ok(report.ok && report.result.kind === 'status' && 'slot' in report.result);
      assert.deepEqual([...report.result.slot.running].sort(), [adaRequest.runId, jonasRequest.runId].sort(), 'the report has the running one, and the one that just ended');
      const still = await call(server, { kind: 'stop', bindingId: jonas, runId: jonasRequest.runId });
      assert.ok(still.ok && still.result.kind === 'stop' && still.result.state === 'stopping', 'Jonas\'s run was still going');
      const his = await running[1]!;
      assert.ok(his.ok && his.result.kind === 'run' && his.result.outcome === 'stopped');
    } finally {
      await server.close();
      await new Promise((closed) => mcp.close(closed));
    }
  });

  test('#860: a link a CLI planted leads nowhere: the cleanup stays inside the person\'s directory and makes no file through it', async () => {
    const server = await startTestSlot();
    try {
      const [ada, jonas] = [randomUUID(), randomUUID()];
      for (const id of [ada, jonas]) assert.ok((await call(server, { kind: 'bind', bindingId: id })).ok);
      const dir = join(server.config.dataDir, ada);
      const his = join(server.config.dataDir, jonas);
      await writeFile(join(his, 'claude', '.credentials.json'), 'his login');
      const untouched = async () => assert.equal(await readFile(join(his, 'claude', '.credentials.json'), 'utf8'), 'his login');
      await rm(join(dir, 'tmp'), { recursive: true });
      await symlink(his, join(dir, 'tmp'));
      assert.equal(await clearScratch(dir, null), true);
      await untouched();
      assert.ok((await lstat(join(dir, 'tmp'))).isDirectory(), 'her scratch is real again');
      await rm(join(dir, 'claude'), { recursive: true });
      await symlink(join(his, 'claude'), join(dir, 'claude'));
      assert.equal(await clearClientFiles(dir, 'claude_code', null), true);
      await untouched();
      assert.ok((await lstat(join(dir, 'claude'))).isDirectory(), 'her CLI home is real again');
      const stray = join(server.config.dataDir, 'stray-from-the-supervisor');
      await symlink(stray, join(dir, 'unconfirmed-claude_code'));
      await recordUnconfirmed(dir, 'claude_code');
      await assert.rejects(lstat(stray), { code: 'ENOENT' }, 'the marker opens nothing that already stands there');
      assert.equal(await hasUnconfirmed(dir, 'claude_code'), true, 'and what stands there counts as recorded');
    } finally { await server.close(); }
  });

  test('#860: a sign-out leaves nothing of the sign-in in the person\'s scratch or in the shared /tmp', async () => {
    const server = await startTestSlot();
    try {
      const id = randomUUID();
      assert.ok((await call(server, { kind: 'bind', bindingId: id })).ok);
      await writeFile(join(server.config.dataDir, id, 'tmp', 'left-by-the-sign-in'), 'x');
      const out = await call(server, { kind: 'logout', bindingId: id, client: 'claude_code', bootId: server.config.bootId });
      assert.ok(out.ok, JSON.stringify(out));
      assert.deepEqual(await readdir(join(server.config.dataDir, id, 'tmp')), []);
    } finally { await server.close(); }
  });

  test('#910: a directory a CLI left with no rights does not stay: the scratch and the shared /tmp are emptied of it', async () => {
    const server = await startTestSlot();
    try {
      const id = randomUUID();
      assert.ok((await call(server, { kind: 'bind', bindingId: id })).ok);
      const dir = join(server.config.dataDir, id);
      // Mode 000 all the way down: `rm -rf` alone cannot open it, only its owner can give the rights back.
      const closed = async (root: string) => {
        await mkdir(join(root, 'inner', 'deeper'), { recursive: true });
        await writeFile(join(root, 'inner', 'deeper', 'file'), 'left');
        for (const path of [join(root, 'inner', 'deeper'), join(root, 'inner'), root]) await chmod(path, 0);
      };
      await closed(join(dir, 'tmp', 'closed'));
      await writeFile(join(dir, 'tmp', 'plain'), 'left');
      assert.equal(await clearScratch(dir, null), true);
      assert.deepEqual(await readdir(join(dir, 'tmp')), [], 'her scratch is a fresh, empty directory');
      assert.equal(((await lstat(join(dir, 'tmp'))).mode & 0o777), 0o700);
      const person = { uid: process.getuid!(), gid: process.getgid!() };
      await closed(join(server.config.tmpDir, 'closed'));
      await writeFile(join(server.config.tmpDir, 'plain'), 'left');
      await symlink(join(dir, 'tmp'), join(server.config.tmpDir, 'link'));
      assert.equal(await clearLeftovers(server.config.tmpDir, person), true);
      assert.deepEqual(await readdir(server.config.tmpDir), [], 'nothing of theirs stays in /tmp');
      assert.equal((await lstat(join(dir, 'tmp'))).isDirectory(), true, 'and the link led nowhere');
    } finally { await server.close(); }
  });

  test('#910: leftovers that cannot be removed are not reported as removed', { skip: process.getuid?.() === 0 && 'root can remove anything' }, async () => {
    const server = await startTestSlot();
    const person = { uid: process.getuid!(), gid: process.getgid!() };
    try {
      await writeFile(join(server.config.tmpDir, 'stuck'), 'left');
      await chmod(server.config.tmpDir, 0o500);
      assert.equal(await clearLeftovers(server.config.tmpDir, person), false, 'a file of theirs stays, so the answer is no');
      await chmod(server.config.tmpDir, 0o700);
      assert.equal(await clearLeftovers(server.config.tmpDir, person), true);
      assert.deepEqual(await readdir(server.config.tmpDir), []);
    } finally {
      await chmod(server.config.tmpDir, 0o700).catch(() => undefined);
      await server.close();
    }
  });

  // A tree deeper than PATH_MAX, built the only way it can be: a few thousand levels of one-letter names, changing directory each time (#915).
  const DEEP_TREE = 'const fs = require("node:fs"); fs.mkdirSync(process.argv[1], { mode: 0o755 }); process.chdir(process.argv[1]); for (let level = 0; level < 2200; level += 1) { fs.mkdirSync("d"); process.chdir("d"); } fs.writeFileSync("file", "left");';
  const deepTree = async (path: string) => {
    const built = await runFixed(process.execPath, ['-e', DEEP_TREE, path], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 60_000, person: null });
    assert.equal(built.code, 0, 'the tree was built');
  };
  const exists = (path: string) => lstat(path).then(() => true, () => false);

  test('#915: a tree deeper than PATH_MAX does not keep a release open: the scratch, the shared /tmp and /data/<id> are all emptied of it', async () => {
    const server = await startTestSlot();
    try {
      const id = randomUUID();
      assert.ok((await call(server, { kind: 'bind', bindingId: id })).ok);
      const dir = join(server.config.dataDir, id);
      const person = { uid: process.getuid!(), gid: process.getgid!() };
      await deepTree(join(server.config.tmpDir, 'deep'));
      await assert.rejects(rm(join(server.config.tmpDir, 'deep'), { recursive: true, force: true }), 'control: rm cannot enter it');
      assert.equal(await clearLeftovers(server.config.tmpDir, person), true);
      assert.equal(await exists(join(server.config.tmpDir, 'deep')), false);
      await deepTree(join(dir, 'tmp', 'deep'));
      assert.equal(await clearScratch(dir, null), true);
      assert.deepEqual(await readdir(join(dir, 'tmp')), []);
      await deepTree(join(dir, 'home', 'deep'));
      assert.equal(await removeBinding(server.config.dataDir, id), true);
      assert.equal(await exists(dir), false, 'the binding directory is gone');
      assert.deepEqual(await readdir(server.config.dataDir), [], 'and nothing was made in /data');
    } finally { await server.close(); }
  });

  test('#915: the walk removes one person\'s entries wherever they stand, looks through other people\'s, and follows no link', async () => {
    const server = await startTestSlot();
    try {
      const me = { uid: process.getuid!(), gid: process.getgid!() };
      const nobody = { uid: me.uid + 1, gid: me.gid + 1 };
      const root = server.config.tmpDir;
      const outside = join(server.config.dataDir, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'precious'), 'kept');
      await mkdir(join(root, 'shared', 'inner', 'deeper'), { recursive: true });
      await writeFile(join(root, 'shared', 'inner', 'deeper', 'file'), 'left');
      await symlink(outside, join(root, 'shared', 'inner', 'link'));
      await symlink(outside, join(root, 'toplink'));
      // Another user id owns none of it: nothing is removed, and nothing is followed to somewhere else.
      assert.equal(await walkTree(null, ['sweep', root, String(nobody.uid)]), true);
      assert.equal(await exists(join(root, 'shared', 'inner', 'deeper', 'file')), true);
      assert.equal(await exists(join(root, 'toplink')), true);
      // Its owner's sweep finds all of it, also deep inside, and removes a link without touching what it points to.
      assert.equal(await walkTree(null, ['sweep', root, String(me.uid)]), true);
      assert.deepEqual(await readdir(root), []);
      assert.equal(await readFile(join(outside, 'precious'), 'utf8'), 'kept');
      // `remove` takes one path: a link at the top is removed itself, and what is not there is already gone.
      await symlink(outside, join(root, 'again'));
      assert.equal(await removeTreeScript(null, join(root, 'again')), true);
      assert.equal(await removeTreeScript(null, join(root, 'not-there')), true);
      assert.equal(await readFile(join(outside, 'precious'), 'utf8'), 'kept');
    } finally { await server.close(); }
  });

  test('a run is refused while the binding directory exceeds its size limit', async () => {
    const small = await startTestSlot({ bindingLimitBytes: 64 * 1024 });
    try {
      const id = randomUUID();
      assert.ok((await call(small, { kind: 'bind', bindingId: id })).ok);
      await writeFile(join(small.config.dataDir, id, 'home', 'big'), Buffer.alloc(128 * 1024, 1));
      const run: SupervisorRequest = { kind: 'run', bindingId: id, client: 'claude_code', runId: randomUUID(), prompt: 'Hello', runToken: 'aa.bb.cc', tools: ['flux_get_doc'],
        caps: { maxTurns: 10, wallClockSeconds: 300, idleSeconds: 60, maxAnswerBytes: 16384 } };
      assert.deepEqual(await call(small, run), { ok: false, code: 'binding_too_large' });
      assert.ok(clientStatus(await call(small, { kind: 'status', bindingId: id, client: 'claude_code' })).bindingOverLimit);
    } finally { await small.close(); }
  });

  test('logout runs the CLI\'s own logout, then deletes its files even when the logout fails', async () => {
    await signIn(slot, bindingId);
    const out = await call(slot, { kind: 'logout', bindingId, client: 'claude_code' });
    assert.ok(out.ok && out.result.kind === 'logout' && out.result.logout === 'ok');
    assert.deepEqual(out.ok && out.steps, [{ step: 'logout', outcome: 'ok', client: 'claude_code' }]);
    assert.deepEqual(await readdir(join(slot.config.dataDir, bindingId, 'claude')), []);
    await signIn(slot, bindingId);
    await writeFile(join(slot.config.dataDir, bindingId, 'claude', 'fake-scenario'), 'logout_fails');
    const failed = await call(slot, { kind: 'logout', bindingId, client: 'claude_code' });
    assert.ok(failed.ok && failed.result.kind === 'logout' && failed.result.logout === 'failed');
    assert.deepEqual(await readdir(join(slot.config.dataDir, bindingId, 'claude')), [], 'the credential file is deleted anyway');
  });

  test('logout also deletes the keyless Console profile that lives outside CLAUDE_CONFIG_DIR, even when the CLI\'s logout fails', async () => {
    const profile = join(slot.config.dataDir, bindingId, 'home', '.config', 'anthropic');
    for (const scenario of ['', 'logout_fails']) {
      await signIn(slot, bindingId);
      await mkdir(join(profile, 'configs'), { recursive: true });
      await writeFile(join(profile, 'active_config'), 'default');
      await writeFile(join(profile, 'configs', 'default.json'), '{"authentication":{"type":"oauth"}}');
      if (scenario) await writeFile(join(slot.config.dataDir, bindingId, 'claude', 'fake-scenario'), scenario);
      assert.ok((await call(slot, { kind: 'logout', bindingId, client: 'claude_code' })).ok);
      await assert.rejects(lstat(profile), { code: 'ENOENT' }, `the Console profile survived sign-out (${scenario || 'logout ok'})`);
      assert.deepEqual(await readdir(join(slot.config.dataDir, bindingId, 'claude')), []);
    }
  });
});

describe('release', () => {
  test('signs out every CLI and deletes that person\'s directory; the supervisor keeps serving everyone else (#860)', async () => {
    const slot = await startTestSlot();
    try {
      const bindingId = randomUUID();
      const other = randomUUID();
      assert.ok((await call(slot, { kind: 'bind', bindingId })).ok);
      assert.ok((await call(slot, { kind: 'bind', bindingId: other })).ok);
      await signIn(slot, other, 'claude_code');
      await signIn(slot, bindingId, 'claude_code');
      await signIn(slot, bindingId, 'codex');
      const out = await call(slot, { kind: 'release', bindingId });
      assert.ok(out.ok && out.result.kind === 'release');
      assert.deepEqual(out.result, { kind: 'release', bindingId, logout: { claude_code: 'ok', codex: 'ok' }, deleted: true });
      assert.deepEqual(out.ok && out.steps.map((step) => step.step), ['logout', 'logout', 'delete', 'verify']);
      assert.deepEqual(await readdir(slot.config.dataDir), [other]);
      const signedIn = await call(slot, { kind: 'status', bindingId: other, client: 'claude_code', bootId: slot.config.bootId });
      assert.ok(signedIn.ok && signedIn.result.kind === 'status' && 'client' in signedIn.result && signedIn.result.client.signedIn, 'the other person keeps their login');
      assert.ok((await call(slot, { kind: 'bind', bindingId: randomUUID() })).ok, 'and the next person gets a place at once');
    } finally { await slot.close(); }
  });

  test('a person\'s slow command never holds up another person\'s (#860)', async () => {
    const slot = await startTestSlot({ cliTimeoutMs: 2_500 });
    try {
      const [ada, jonas] = [randomUUID(), randomUUID()];
      assert.ok((await call(slot, { kind: 'bind', bindingId: ada })).ok);
      assert.ok((await call(slot, { kind: 'bind', bindingId: jonas })).ok);
      await writeFile(join(slot.config.dataDir, ada, 'claude', 'fake-scenario'), 'logout_hangs');
      const started = Date.now();
      const hanging = call(slot, { kind: 'logout', bindingId: ada, bootId: slot.config.bootId, client: 'claude_code' });
      const other = await call(slot, { kind: 'status', bindingId: jonas, client: 'claude_code', bootId: slot.config.bootId });
      assert.ok(other.ok, 'his request was answered');
      assert.ok(Date.now() - started < 2_000, 'while hers still hung');
      await hanging;
    } finally { await slot.close(); }
  });

  test('a failed or hanging logout still deletes the directory', async () => {
    const slot = await startTestSlot({ cliTimeoutMs: 1_500 });
    try {
      const bindingId = randomUUID();
      assert.ok((await call(slot, { kind: 'bind', bindingId })).ok);
      await signIn(slot, bindingId, 'claude_code');
      await writeFile(join(slot.config.dataDir, bindingId, 'claude', 'fake-scenario'), 'logout_hangs');
      await writeFile(join(slot.config.dataDir, bindingId, 'codex', 'fake-scenario'), 'logout_fails');
      const out = await call(slot, { kind: 'release', bindingId });
      assert.ok(out.ok && out.result.kind === 'release');
      assert.deepEqual(out.result.logout, { claude_code: 'timeout', codex: 'failed' });
      assert.equal(out.result.deleted, true);
    } finally { await slot.close(); }
  });

  test('templates are fixed: logout argv per client', () => {
    assert.deepEqual([...LOGOUT_TEMPLATES.claude_code], ['auth', 'logout']);
    assert.deepEqual([...LOGOUT_TEMPLATES.codex], ['-c', 'cli_auth_credentials_store=file', 'logout']);
  });
});

describe('one serial lane', () => {
  test('runs tasks one at a time, in order, and answers busy beyond its queue', async () => {
    const lane = new Lane(3);
    const order: string[] = [];
    let active = 0;
    const task = (name: string) => async () => { active += 1; assert.equal(active, 1); order.push(`start ${name}`); await new Promise((done) => setTimeout(done, 20)); order.push(`end ${name}`); active -= 1; };
    const runs = [lane.run(task('a')), lane.run(task('b')), lane.run(task('c'))];
    assert.equal(lane.run(task('d')), null);
    assert.equal(lane.busy, true);
    await Promise.all(runs);
    await new Promise((done) => setTimeout(done, 0));
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    assert.equal(lane.busy, false);
  });
});

describe('a run\'s error results (F-022 T5; the wording is first verified against a real account in T10)', () => {
  test('a plan limit, an expired login and a refusal each have their own outcome; anything else is a crash', () => {
    assert.deepEqual(classifyError('Claude AI usage limit reached|1791374400'), { outcome: 'plan_limit', resetsAt: '2026-10-07T12:00:00.000Z' });
    assert.deepEqual(classifyError('5-hour limit reached ∙ resets 2pm'), { outcome: 'plan_limit', resetsAt: null });
    for (const text of ['Invalid API key · Please run /login', 'OAuth token has expired. Please run /login', 'Not logged in', 'API Error: 401 authentication_error'])
      assert.equal(classifyError(text).outcome, 'sign_in_again', text);
    assert.equal(classifyError('Claude refused this request under the usage policy').outcome, 'refused');
    assert.equal(classifyError('Something else went wrong').outcome, 'crashed');
  });

  test('#1129: the pinned CLIs\' own texts and stream fields for a 429, an over-long prompt and a dead sign-in (observed 2026-11-09)', () => {
    // Claude Code 2.1.285 against the vendor mock (scripts/check_cli_runtime.sh): the result text, the `assistant` event's `error`, the `terminal_reason`.
    assert.deepEqual(classifyError('API Error: Request rejected (429) · Number of request tokens has exceeded your per-minute rate limit', { error: 'rate_limit', terminalReason: 'api_error' }),
      { outcome: 'plan_limit', resetsAt: null });
    assert.equal(classifyError('API Error: Request rejected (429) · anything').outcome, 'plan_limit', 'the text alone too');
    assert.equal(classifyError('Prompt is too long · the request is ~250123 tokens (limit 200000) but this conversation is only ~150 tokens', { error: 'invalid_request', terminalReason: 'prompt_too_long' }).outcome,
      'input_too_large');
    assert.equal(classifyError('Something new', { terminalReason: 'prompt_too_long' }).outcome, 'input_too_large');
    assert.equal(classifyError('Invalid API key · Fix external API key', { error: 'authentication_failed', terminalReason: 'api_error' }).outcome, 'sign_in_again');
    assert.equal(classifyError('Failed to authenticate: OAuth token revoked. Please run /login').outcome, 'sign_in_again');
    // A plan's own limits (strings of the 2.1.285 binary: `You've hit your <name> limit`; seen only signed in with a plan).
    for (const text of ['You\'ve hit your session limit · resets 3:45pm', 'You’ve hit your weekly limit · resets Mon 9am', 'You\'ve hit your monthly spend limit.',
      'You\'ve hit your team\'s shared budget. /model to switch models.'])
      assert.equal(classifyError(text).outcome, 'plan_limit', text);
    // The vendor's own capacity is not the person's limit.
    assert.equal(classifyError('API Error: Server is temporarily limiting requests (not your usage limit)', { error: 'rate_limit' }).outcome, 'crashed');
    // Codex rust-v0.160.1.
    assert.equal(classifyCodexError('Codex ran out of room in the model\'s context window. Start a new thread or clear earlier history before retrying.'), 'input_too_large');
    assert.equal(classifyCodexError('exceeded retry limit, last status: 429 Too Many Requests, request id: req_1'), 'plan_limit');
    assert.equal(classifyCodexError('Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'), 'sign_in_again');
  });

  test('AST-11: a model the account cannot use is its own outcome, for both CLIs', () => {
    assert.equal(classifyError('There\'s an issue with the selected model (opus). It may not exist or you may not have access to it. Run /model to pick a different model.').outcome, 'model_unavailable');
    assert.equal(classifyCodexError('The model `gpt-6-astra` does not exist or you do not have access to it.'), 'model_unavailable');
    assert.equal(classifyCodexError('{"error":{"code":"model_not_found"}}'), 'model_unavailable');
    // A plan limit or an expired login that mentions a model is still its own outcome, and ordinary words are not a model error.
    assert.equal(classifyError('Claude AI usage limit reached|1791374400').outcome, 'plan_limit');
    assert.equal(classifyCodexError('You’ve hit your usage limit for this model.'), 'plan_limit');
    assert.equal(classifyError('The model is thinking about it').outcome, 'crashed');
  });

  test('AST-11: the run templates add the model flag only when a model is named, and only as its value', () => {
    const input = { tools: ['flux_get_doc'], caps: { maxTurns: 10, wallClockSeconds: 300, idleSeconds: 60, maxAnswerBytes: 16384 }, mcpConfigPath: '/tmp/mcp.json', mcpUrl: 'http://x:8080/mcp', brief: 'brief' };
    const withModel = RUN_TEMPLATES.claude_code({ ...input, model: 'opus' });
    assert.deepEqual(withModel.slice(withModel.indexOf('--model') - 2), ['--max-turns', '10', '--model', 'opus', '--append-system-prompt', 'brief']);
    assert.ok(!RUN_TEMPLATES.claude_code(input).includes('--model'));
    const codex = RUN_TEMPLATES.codex({ ...input, model: 'gpt-6-luna' });
    assert.deepEqual(codex.slice(codex.indexOf('-m'), codex.indexOf('-m') + 2), ['-m', 'gpt-6-luna']);
    assert.ok(codex.indexOf('-m') < codex.length - 1 && codex.at(-1) === '-', 'the prompt marker stays last');
    assert.ok(!RUN_TEMPLATES.codex(input).includes('-m'));
  });

  test('#1065: with the web on Claude Code keeps exactly its WebSearch, named in --tools and --allowedTools, never WebFetch; Codex searches on the cached index', () => {
    const input = { tools: ['flux_get_doc', 'flux_read_web'], caps: { maxTurns: 10, wallClockSeconds: 300, idleSeconds: 60, maxAnswerBytes: 16384 }, mcpConfigPath: '/tmp/mcp.json', mcpUrl: 'http://x:8080/mcp', brief: 'brief' };
    const on = RUN_TEMPLATES.claude_code({ ...input, webSearch: true });
    assert.deepEqual(on.slice(on.indexOf('--tools'), on.indexOf('--tools') + 3), ['--tools', 'WebSearch', '--disable-slash-commands']);
    assert.deepEqual(on.slice(on.indexOf('--allowedTools') + 1, on.indexOf('--permission-mode')), ['mcp__flux__flux_get_doc', 'mcp__flux__flux_read_web', 'WebSearch']);
    assert.ok(!on.some((arg) => /WebFetch|Bash|Read|Write/.test(arg)), 'no other built-in, and never the one that opens pages from the runtime');
    const off = RUN_TEMPLATES.claude_code(input);
    assert.deepEqual(off.slice(off.indexOf('--tools'), off.indexOf('--tools') + 2), ['--tools', ''], 'with the web off every built-in is removed, as before');
    assert.ok(!off.includes('WebSearch'));
    const codex = RUN_TEMPLATES.codex({ ...input, webSearch: true });
    assert.ok(codex.includes('web_search="cached"') && !codex.includes('web_search="disabled"'), 'Codex searches on OpenAI\'s cached index');
    assert.ok(!codex.some((arg) => /standalone|live|indexed/.test(arg)), 'never live or indexed, and no search feature of its own');
    assert.ok(RUN_TEMPLATES.codex(input).includes('web_search="disabled"'), 'with the web off it has none');
  });

  test('#1437: with Flux\'s sandbox, Claude Code keeps its own shell and file tools and Codex its shell, in the run\'s scratch; never WebFetch', () => {
    const input = { tools: ['flux_get_doc'], caps: { maxTurns: 10, wallClockSeconds: 300, idleSeconds: 60, maxAnswerBytes: 16384 }, mcpConfigPath: '/tmp/mcp.json', mcpUrl: 'http://x:8080/mcp', brief: 'brief' };
    const claude = RUN_TEMPLATES.claude_code({ ...input, ownTools: true, webSearch: true });
    assert.deepEqual(claude.slice(claude.indexOf('--tools'), claude.indexOf('--tools') + 2), ['--tools', 'Bash,Read,Write,Edit,Glob,Grep,WebSearch']);
    assert.ok(claude.includes('--restricted'), 'its file tools stay in the working directory');
    assert.deepEqual(claude.slice(claude.indexOf('--allowedTools') + 1, claude.indexOf('--permission-mode')), ['mcp__flux__flux_get_doc', 'Bash', 'Read(./**)', 'Edit(./**)', 'WebSearch']);
    assert.ok(!claude.some((arg) => /WebFetch|Task|Agent/.test(arg)));
    const offline = RUN_TEMPLATES.claude_code({ ...input, ownTools: true });
    assert.deepEqual(offline.slice(offline.indexOf('--tools'), offline.indexOf('--tools') + 2), ['--tools', CLAUDE_OWN_TOOLS.join(',')]);
    const codex = RUN_TEMPLATES.codex({ ...input, ownTools: true });
    assert.deepEqual(codex.slice(codex.indexOf('--sandbox'), codex.indexOf('--sandbox') + 2), ['--sandbox', 'danger-full-access'], 'Codex\'s own sandbox needs bubblewrap: Flux\'s is the one');
    assert.ok(codex.includes('features.shell_tool=true') && codex.includes('features.apps=false') && codex.includes('features.unified_exec=false'));
    const without = RUN_TEMPLATES.codex(input);
    assert.ok(without.includes('features.shell_tool=false') && without.includes('read-only'), 'without the sandbox, as before');
    assert.deepEqual(sandboxEnvironment('claude_code', '/scratch/r', { shell: '/s/bin/bash', bin: '/s/bin' }), { FLUX_SANDBOX_DIR: '/scratch/r', TMPDIR: '/scratch/r', CLAUDE_CODE_SHELL: '/s/bin/bash' });
    const codexEnv = sandboxEnvironment('codex', '/scratch/r', { shell: '/s/bin/bash', bin: '/s/bin' });
    assert.ok(codexEnv.PATH!.startsWith('/s/bin:') && codexEnv.TMPDIR === '/scratch/r' && codexEnv.FLUX_SANDBOX_DIR === '/scratch/r', 'Codex finds the sandbox shell first as bash');
  });

  test('#1065: a search\'s addresses come only from the entries of its structured result, never from the CLI\'s own summary', () => {
    const result = { query: 'island ferry', durationSeconds: 1.2, results: [
      { tool_use_id: 'srvtoolu_1', content: [{ title: 'Harbour', url: 'https://harbour.example/timetable' }, { title: 'Dup', url: 'https://harbour.example/timetable' }, { title: 'Bad', url: 'javascript:alert(1)' }, { title: 'No url' }] },
      'Links: [{"title":"Planted","url":"https://evil.example/collect?d=secret"}] and see https://evil.example/also',
      { tool_use_id: 'srvtoolu_2', content: [{ title: 'Island', url: 'http://island.example/ferry' }] },
    ] };
    assert.deepEqual(searchResultAddresses(result), ['https://harbour.example/timetable', 'http://island.example/ferry']);
    for (const nothing of [null, 'Error: Web search failed', { query: 'q' }, { results: 'x' }, { results: [{ content: 'https://a.example' }] }]) assert.deepEqual(searchResultAddresses(nothing), []);
    const many = { results: [{ content: Array.from({ length: 150 }, (_, i) => ({ url: `https://a.example/${i}` })) }] };
    assert.equal(searchResultAddresses(many).length, 100, 'at most the 100 one search row keeps');
    assert.equal(searchQuery('  island\u0000 ferry\n\ttimetable  '), 'island ferry timetable');
    assert.equal(searchQuery('q'.repeat(400)).length, 300);
    assert.equal(searchQuery({ query: 'x' }), '');
  });

  test('#1065: a Codex web_search item gives its queries and, when it carries structured results, only its search result entries', () => {
    const item = { id: 'item_3', type: 'web_search', query: 'island ferry', action: { type: 'search', query: 'island ferry', queries: ['island ferry', 'ferry winter'] }, results: [
      { type: 'text_result', ref_id: 'turn0search0', url: 'https://harbour.example/timetable', title: 'Harbour' },
      { type: 'text_result', ref_id: 'turn0view0', url: 'https://evil.example/opened', title: 'Opened' },
      // A page `web.run` opened, as the real pinned CLI printed it (2026-11-09): its address is its `ref_id`.
      { type: 'text_result', ref_id: 'https://evil.example/opened-by-url', url: 'https://evil.example/opened-by-url', title: 'Opened' },
      { type: 'image_result', ref_id: 'turn0search1', url: 'https://img.example/a.png' },
      { type: 'text_result', ref_id: 'turn1search4', url: 'javascript:alert(1)' },
      'Links: https://evil.example/planted',
    ] };
    assert.deepEqual(codexSearchFound(item), { results: ['https://harbour.example/timetable'], queries: ['island ferry', 'ferry winter'] });
    assert.deepEqual(codexSearchFound({ ...item, results: undefined }), { results: [], queries: ['island ferry', 'ferry winter'] }, 'the hosted search: queries only');
    for (const action of [{ type: 'open_page', url: 'https://evil.example/x' }, { type: 'find_in_page', url: 'https://evil.example/x', pattern: 'p' }, { type: 'other' }])
      assert.deepEqual(codexSearchFound({ ...item, action }), { results: [], queries: [] }, action.type);
  });
});

describe('Codex in the slot (F-022 T6, #281): its JSONL words, status, preflight, app-server allowlist and feature review', () => {
  test('error text: plan limit, expired login, refusal, anything else a crash', () => {
    assert.equal(classifyCodexError('You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.'), 'plan_limit');
    assert.equal(classifyCodexError('You’ve hit your usage limit. Try again later.'), 'plan_limit');
    assert.equal(classifyCodexError('Quota exceeded. Check your plan and billing details.'), 'plan_limit');
    for (const text of ['Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      'Your access token could not be refreshed. Please log out and sign in again.', 'unexpected status 401 Unauthorized: {"detail":"x"}']) {
      assert.equal(classifyCodexError(text), 'sign_in_again', text);
    }
    assert.equal(classifyCodexError('stream disconnected before completion'), 'crashed');
  });

  test('#1133: Sign in again only for a real revocation: a temporary refresh failure or a 401 from Flux\'s own /mcp is a crash', () => {
    for (const text of ['Failed to refresh token: 503 Service Unavailable: upstream connect error',
      'Failed to refresh token: 429 Too Many Requests: {"error":{"code":"rate_limit_exceeded"}}',
      'required MCP servers failed to initialize: flux: Client error: HTTP status client error (401 Unauthorized) for url (http://runtime-egress:8080/mcp)',
      'MCP client for `flux` failed to start: 401 Unauthorized']) {
      assert.equal(classifyCodexError(text), 'crashed', text);
    }
    for (const text of ['Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.', 'Not logged in',
      'unexpected status 401 Unauthorized: {"error":{"code":"invalid_api_key"}}']) {
      assert.equal(classifyCodexError(text), 'sign_in_again', text);
    }
  });

  test('`codex login status` on stderr: ChatGPT, an API key or an access token; not logged in is signed out', () => {
    assert.deepEqual(statusFacts('codex', 0, 'Logged in using ChatGPT\n'), { signedIn: true, facts: { authMethod: 'chatgpt', plan: null, accountLabel: null, accountDigest: null } });
    assert.equal(statusFacts('codex', 0, 'Logged in using an API key - sk-proj-***\n').facts?.authMethod, 'openai_api_key');
    assert.equal(statusFacts('codex', 0, 'Logged in using access token\n').facts?.authMethod, 'access_token');
    assert.deepEqual(statusFacts('codex', 1, 'Not logged in\n'), { signedIn: false, facts: null });
    assert.deepEqual(statusFacts('codex', 0, ''), { signedIn: false, facts: null }, 'exit 0 without the line is not a sign-in');
  });

  test('rate limits: the window at 100 % and its reset (Unix seconds); any other shape is unknown, never zero', () => {
    assert.deepEqual(readRateLimits({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1791374400 }, secondary: { usedPercent: 30, resetsAt: 1791900000 } } }),
      { limited: true, resetsAt: new Date(1791374400 * 1000).toISOString() });
    assert.deepEqual(readRateLimits({ rateLimits: { primary: { usedPercent: 40 } } }), { limited: false, resetsAt: null });
    for (const junk of [null, {}, { rateLimits: {} }, { rateLimits: { primary: { usedPercent: 'x' } } }]) assert.deepEqual(readRateLimits(junk), { limited: null, resetsAt: null });
  });

  test('the preflight accepts only the effective config with every reviewed feature off, web search disabled and Flux alone with the exact tools', () => {
    const tools = ['flux_list_contexts', 'flux_get_doc'];
    const url = 'http://runtime-egress:8080/mcp';
    const config = { features: Object.fromEntries(Object.entries(CODEX_FEATURE_REVIEW).filter(([, review]) => review.action !== 'kept').map(([key]) => [key, false])),
      web_search: 'disabled', model_catalog_json: CODEX_MODEL_CATALOG,
      mcp_servers: { flux: { url, bearer_token_env_var: 'FLUX_RUN_TOKEN', required: true, enabled_tools: tools, default_tools_approval_mode: 'approve' } } };
    assert.equal(effectiveConfigHolds(config, tools, url), true);
    // #1127: the vendor's own catalog (code mode only) is not Flux's, and Codex itself asking before a Flux tool would refuse it in `exec`.
    assert.equal(effectiveConfigHolds({ ...config, model_catalog_json: undefined }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, model_catalog_json: '/tmp/models.json' }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, mcp_servers: { flux: { ...config.mcp_servers.flux, default_tools_approval_mode: 'auto' } } }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, features: { ...config.features, shell_tool: true } }, tools, url), false);
    // #1437: with the run's own tools the shell is on, exactly then; every other reviewed feature stays off.
    const own = { ...config, features: { ...config.features, shell_tool: true } };
    assert.equal(effectiveConfigHolds(own, tools, url, false, CODEX_MODEL_CATALOG, true), true);
    assert.equal(effectiveConfigHolds(config, tools, url, false, CODEX_MODEL_CATALOG, true), false, 'the shell off where the run should have it is not the run Flux started');
    assert.equal(effectiveConfigHolds({ ...own, features: { ...own.features, apps: true } }, tools, url, false, CODEX_MODEL_CATALOG, true), false);
    assert.equal(effectiveConfigHolds({ ...config, web_search: 'cached' }, tools, url), false);
    // #1065: with the web on, exactly the cached index; disabled or live is refused.
    assert.equal(effectiveConfigHolds({ ...config, web_search: 'cached' }, tools, url, true), true);
    for (const mode of ['disabled', 'live', 'indexed', undefined]) assert.equal(effectiveConfigHolds({ ...config, web_search: mode }, tools, url, true), false, String(mode));
    assert.equal(effectiveConfigHolds({ ...config, mcp_servers: { ...config.mcp_servers, github: { url: 'https://x' } } }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, mcp_servers: { flux: { ...config.mcp_servers.flux, enabled_tools: [...tools, 'flux_create_task'] } } }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, mcp_servers: { flux: { ...config.mcp_servers.flux, required: false } } }, tools, url), false);
    assert.equal(effectiveConfigHolds({}, tools, url), false);
    assert.throws(() => codexRunOverrides([], url, 'brief'), /non-empty/);
  });

  test('#1165: Codex\'s three resource readers on Flux go through; any other server, or any other tool of the `codex` server, does not', () => {
    assert.deepEqual([...CODEX_RESOURCE_READERS], ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
    // A list of every server is labelled `codex` (codex-rs list_mcp_resources.rs); a call that names Flux is labelled `flux`.
    for (const tool of CODEX_RESOURCE_READERS) for (const server of ['flux', 'codex']) assert.equal(codexResourceReader({ server, tool }), true, `${server} ${tool}`);
    assert.equal(codexResourceReader({ server: 'flux', tool: 'read_mcp_resource', arguments: { server: 'flux', uri: 'http://169.254.169.254/latest/meta-data/' } }), true,
      'the address is data for Flux\'s server, which never opens it');
    for (const item of [{ server: 'github', tool: 'read_mcp_resource' }, { server: 'codex_apps', tool: 'list_mcp_resources' }, { server: 'Flux', tool: 'list_mcp_resources' },
      { server: 'codex', tool: 'subscribe_mcp_resource' }, { server: 'codex', tool: 'flux_list_contexts' }, { server: 'flux', tool: 'flux_list_contexts' },
      { tool: 'list_mcp_resources' }, { server: 'flux' }, { server: ['flux'], tool: 'list_mcp_resources' }, { server: 'flux', tool: ['read_mcp_resource'] }]) {
      assert.equal(codexResourceReader(item), false, JSON.stringify(item));
    }
  });

  test('every default-on feature of the pinned Codex is reviewed; the review switches off every tool feature named in F-022', () => {
    // codex-rs/features/src/lib.rs at rust-v0.160.1 (c3e23d4, read 2026-10-16): Stable features with default_enabled true
    // (`secret_auth_storage` is on only on Windows). scripts/check_runtime_cli_contract.sh checks this against the binary's `features list`.
    const PINNED_DEFAULT_ON = ['daemon_auto_start', 'shell_tool', 'view_image', 'sleep_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'content_item_kinds',
      'code_mode_host', 'write_stdin_approval', 'hooks', 'enable_request_compression', 'unbounded_connection_retries', 'worktrees', 'system_proxy_fallback', 'multi_agent',
      'apps', 'tool_suggest', 'plugins', 'in_app_browser', 'in_app_chat', 'in_app_dictation', 'in_app_local_automation', 'in_app_updates', 'browser_use',
      'browser_use_full_cdp_access', 'browser_use_external', 'computer_use', 'remote_plugin', 'plugin_sharing', 'image_generation', 'skill_mcp_dependency_install',
      'skill_search', 'mentions_v2', 'guardian_approval', 'guardian_reuse_parent_compaction', 'goals', 'tool_call_mcp_elicitation', 'auth_elicitation', 'fast_mode',
      'realtime_conversation', 'compaction_image_budget', 'workspace_dependencies'];
    assert.deepEqual(PINNED_DEFAULT_ON.filter((key) => !Object.hasOwn(CODEX_FEATURE_REVIEW, key)), [], 'an unreviewed default-on feature');
    for (const key of ['unified_exec', 'apps', 'multi_agent', 'skill_mcp_dependency_install', 'hooks', 'goals', 'remote_plugin', 'memories', 'view_image',
      'code_mode_host', 'browser_use', 'computer_use', 'image_generation', 'plugins', 'daemon_auto_start']) assert.equal(CODEX_FEATURE_REVIEW[key]?.action, 'off', key);
    // #1437: the shell is the run's own tool where the runtime has Flux's sandbox, and off everywhere else.
    assert.equal(CODEX_FEATURE_REVIEW.shell_tool?.action, 'own_tools');
    const argv = codexRunOverrides(['flux_get_doc'], 'http://x:8080/mcp', 'brief');
    assert.ok(argv.includes('web_search="disabled"') && argv.includes('mcp_servers.flux.required=true') && argv.includes('mcp_servers.flux.enabled_tools=["flux_get_doc"]'));
    assert.ok(!argv.some((value) => value.startsWith('tools.view_image')), '`tools.view_image` is not a key of the pinned Codex; features.view_image is');
    assert.ok(argv.includes(`model_catalog_json=${JSON.stringify(CODEX_MODEL_CATALOG)}`) && argv.includes('tools.experimental_request_user_input.enabled=false')
      && argv.includes('mcp_servers.flux.default_tools_approval_mode="approve"'), '#1127');
  });

  test('#1127, #1437: Flux\'s Codex model catalog gives every model plain tools, no sub-agents, tool search or extra tools; a run without its own tools also no shell or file edits', () => {
    // The shape of the pinned catalog (codex-rs models-manager/models.json at rust-v0.160.1): Flux's models are `code_mode_only`, `v2`.
    const vendor = { models: [
      { slug: 'gpt-6.1-sol', tool_mode: 'code_mode_only', multi_agent_version: 'v2', multi_agent_reasoning_effort: 'xhigh', apply_patch_tool_type: 'freeform',
        shell_type: 'shell_command', supports_search_tool: true, experimental_supported_tools: ['send_user_message_async', 'clock'], context_window: 272000,
        model_messages: { instructions_template: 'the vendor\'s' } },
      { slug: 'gpt-5.5', tool_mode: null } ] };
    const catalog = fluxCodexCatalog(vendor);
    assert.deepEqual(catalog.models.map((model) => model.slug), ['gpt-6.1-sol', 'gpt-5.5']);
    for (const model of catalog.models) {
      assert.deepEqual({ tool_mode: model.tool_mode, multi_agent_version: model.multi_agent_version, multi_agent_reasoning_effort: model.multi_agent_reasoning_effort,
        experimental_supported_tools: model.experimental_supported_tools, supports_search_tool: model.supports_search_tool }, { ...CODEX_MODEL_REVIEW, experimental_supported_tools: [] });
    }
    assert.deepEqual([catalog.models[0]!.apply_patch_tool_type, catalog.models[0]!.shell_type], ['freeform', 'shell_command'], 'the shell and apply_patch stay the vendor\'s in the image\'s copy');
    const without = catalogForAccount(catalog, ['gpt-6.1-sol'])!.models[0]!;
    assert.deepEqual([without.apply_patch_tool_type, without.shell_type], [CODEX_NO_OWN_TOOLS.apply_patch_tool_type, CODEX_NO_OWN_TOOLS.shell_type], 'a run without its own tools has neither');
    const own = catalogForAccount(catalog, ['gpt-6.1-sol'], true)!.models[0]!;
    assert.deepEqual([own.apply_patch_tool_type, own.shell_type, own.tool_mode], ['freeform', 'shell_command', 'direct'], 'a run with them keeps the vendor\'s, and Flux\'s review');
    assert.equal(catalog.models[0]!.context_window, 272000, 'everything else stays the vendor\'s');
    assert.deepEqual(catalog.models[0]!.model_messages, { instructions_template: 'the vendor\'s' });
    for (const junk of [null, {}, { models: [] }, { models: [{}] }, { models: 'x' }]) assert.throws(() => fluxCodexCatalog(junk), /Not a Codex model catalog/);
  });

  test('#1332: a run\'s model catalog is the reviewed one cut down to what the account offers; the list session carries no catalog', () => {
    const catalog = fluxCodexCatalog({ models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5'].map((slug) => ({ slug, tool_mode: 'code_mode_only', context_window: 272000 })) });
    const cut = catalogForAccount(catalog, ['gpt-6.1-sol', 'gpt-6-luna']);
    assert.deepEqual(cut?.models.map((model) => model.slug), ['gpt-6.1-sol'], 'a model the account lacks is gone, and a model Flux has no review for is not made up');
    assert.deepEqual([cut?.models[0]?.tool_mode, cut?.models[0]?.context_window], ['direct', 272000], 'what is left keeps Flux\'s review and the vendor\'s settings');
    assert.equal(catalogForAccount(catalog, ['gpt-6-luna']), null, 'none of the account\'s models is in it');
    assert.equal(catalogForAccount(catalog, []), null);
    assert.throws(() => catalogForAccount({ models: [] }, ['gpt-6.1-sol']), /Not a Codex model catalog/);
    const own = codexRunOverrides(['flux_get_doc'], 'http://x:8080/mcp', 'brief', false, '/tmp/run-1/models.json');
    assert.ok(own.includes(`model_catalog_json=${JSON.stringify('/tmp/run-1/models.json')}`), 'the run names its own catalog');
    assert.ok(!own.includes(`model_catalog_json=${JSON.stringify(CODEX_MODEL_CATALOG)}`));
    const listing = codexListOverrides().filter((value) => value !== '-c');
    assert.ok(!listing.some((value) => value.startsWith('model_catalog_json')), 'the list session carries no catalog: it would only echo Flux\'s own');
    assert.ok(listing.includes('features.plugins=false') && listing.includes('web_search="disabled"') && listing.includes('analytics.enabled=false'), 'but the reviewed features stay off, as in a run');
    assert.ok(!listing.some((value) => value.startsWith('mcp_servers')), 'and no MCP server');
    const config = { model_catalog_json: '/tmp/run-1/models.json' };
    assert.equal(effectiveConfigHolds({ ...config }, ['t'], 'u', false, CODEX_MODEL_CATALOG), false, 'the preflight wants the catalog it was started with, not the image\'s whole copy');
  });

  test('#1332: Claude Code\'s models are read from its initialization answer with the run\'s tool restrictions and no prompt', () => {
    assert.deepEqual(CLAUDE_MODELS_TEMPLATE.slice(0, 5), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']);
    for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(CLAUDE_MODELS_TEMPLATE.includes(flag), flag);
    assert.equal(CLAUDE_MODELS_TEMPLATE[CLAUDE_MODELS_TEMPLATE.indexOf('--tools') + 1], '', 'no built-in tool');
    for (const flag of ['--mcp-config', '--allowedTools', '--model', '--append-system-prompt']) assert.ok(!CLAUDE_MODELS_TEMPLATE.includes(flag), `${flag} is a run's`);
  });

  test('the app-server client sends only initialize, config/read, account/rateLimits/read and model/list; command/exec is refused before it is written', async () => {
    const slot = await startTestSlot({ enabled: ['codex'] });
    try {
      const bindingId = randomUUID();
      assert.ok((await callSupervisor(target(slot), { kind: 'bind', bindingId })).ok);
      const dir = join(slot.config.dataDir, bindingId);
      const session = await openAppServer(slot.config.cliPaths.codex, dir, '127.0.0.1', { timeoutMs: 10_000, person: null });
      for (const method of ['command/exec', 'thread/start', 'turn/start', 'config/write', 'initialize']) {
        await assert.rejects(session.request(method, {}), (error: Error) => error.name === 'AppServerMethodRefused', method);
      }
      assert.ok(await session.request('config/read', {}));
      session.close();
      const methods = (await calls(slot, bindingId, 'codex') as unknown as { event?: string; method?: string }[]).filter((entry) => entry.event === 'app_server').map((entry) => entry.method);
      assert.deepEqual(methods.filter((method) => method !== 'initialized'), ['initialize', 'config/read'], 'nothing else reached the app-server');
      assert.deepEqual(APP_SERVER_METHODS, ['initialize', 'config/read', 'account/rateLimits/read', 'model/list']);
    } finally { await slot.close(); }
  });

  test('the Claude sign-in reader: only the sign-in URL, once, whole lines only, Anthropic hosts only', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc-1&scope=a%3Ab+c&state=xyz_-1';
    const reader = claudeSignInReader();
    assert.deepEqual(reader.feed(`Opening browser to sign in…\nIf the browser didn't open, visit: \u001b]8;;${url}\u0007\u001b[94m${url.slice(0, 40)}`), [], 'not before the line ends');
    assert.deepEqual(reader.feed(`${url.slice(40)}\u001b[39m\u001b]8;;\u0007\r\nPaste code here if prompted > `), [{ t: 'signin', e: 'url', url }]);
    assert.deepEqual(reader.feed(`visit: ${url}\n`), [], 'once');
    assert.deepEqual(claudeSignInReader().feed('visit: https://evil.example/cai/oauth/authorize?code=true\n'), [], 'only Anthropic\'s hosts');
    assert.deepEqual(claudeSignInReader().feed('visit: http://claude.com/cai/oauth/authorize?code=true\n'), [], 'https only');
  });

  test('the device sign-in reader: the URL and code once, Journey 6\'s two failures once each, nothing from other text', () => {
    const reader = deviceSignInReader();
    assert.deepEqual(reader.feed('Welcome to Codex\n1. Open this link\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code '), []);
    assert.deepEqual(reader.feed('\u001b[90m(expires in 15 minutes)\u001b[0m\r\n   \u001b[94mAB12-CD34E\u001b[0m\r\n'), [{ t: 'signin', e: 'device', url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34E' }]);
    assert.deepEqual(reader.feed('again https://auth.openai.com/codex/device one-time code\n XY12-ZZZZZ\n'), [], 'once');
    assert.deepEqual(reader.feed('Error logging in with device code: device auth timed out after 15 minutes\n'), [{ t: 'signin', e: 'problem', problem: 'code_expired' }]);
    const other = deviceSignInReader();
    assert.deepEqual(other.feed('Error logging in with device code: device code login is not enabled for this Codex server.\n'), [{ t: 'signin', e: 'problem', problem: 'device_auth_disabled' }]);
    assert.deepEqual(deviceSignInReader().feed('https://evil.example/codex/device one-time code\n AB12-CD34E\n'), [], 'only the issuer\'s page');
  });
});
