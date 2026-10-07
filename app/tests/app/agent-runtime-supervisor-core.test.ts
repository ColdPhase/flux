import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { callSupervisor, NdjsonReader, parseSupervisorFrame, type ClientStatus, type SupervisorCallOutcome, type SupervisorRequest } from '@flux/runtime-protocol';
import { Lane } from '../../apps/runtime/src/supervisor/server.js';
import { LOGOUT_TEMPLATES, STATUS_TEMPLATES } from '../../apps/runtime/src/supervisor/templates.js';
import { portOf, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// F-022 T3: a slot's supervisor, in process, over temporary /data and /tmp with the TEST ONLY fake CLIs.
// No database and no network beyond loopback.

const target = (slot: TestSlot) => ({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });
const call = (slot: TestSlot, request: SupervisorRequest) => callSupervisor(target(slot), request, { timeoutMs: 20_000 });

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

  test('bind creates /data/<uuid> 0700 with private CLI homes, is idempotent, and refuses a second binding', async () => {
    const bindingId = randomUUID();
    const bound = await call(slot, { kind: 'bind', bindingId });
    assert.ok(bound.ok && bound.result.kind === 'bind' && bound.bootId === slot.config.bootId);
    const dir = join(slot.config.dataDir, bindingId);
    assert.equal((await lstat(dir)).mode & 0o777, 0o700);
    for (const sub of ['claude', 'codex', 'home']) assert.equal((await lstat(join(dir, sub))).mode & 0o777, 0o700);
    assert.ok((await call(slot, { kind: 'bind', bindingId })).ok, 'a retried bind of the same binding is accepted');
    assert.deepEqual(await call(slot, { kind: 'bind', bindingId: randomUUID() }), { ok: false, code: 'data_not_empty' });
    const report = await call(slot, { kind: 'status' });
    assert.ok(report.ok && report.result.kind === 'status' && 'slot' in report.result);
    assert.deepEqual(report.result.slot.data, { empty: false, bindings: [bindingId], other: 0 });
    assert.equal(report.result.slot.slot, 'runtime-1');
    assert.deepEqual(report.result.slot.installed, { claude_code: true, codex: true });
  });

  test('refuses to bind while /data holds any entry at all', async () => {
    const empty = await startTestSlot();
    try {
      for (const entry of ['.hidden', 'notes.txt', 'lost+found']) {
        await writeFile(join(empty.config.dataDir, entry), '');
        assert.deepEqual(await call(empty, { kind: 'bind', bindingId: randomUUID() }), { ok: false, code: 'data_not_empty' }, entry);
        await rm(join(empty.config.dataDir, entry));
      }
      await mkdir(join(empty.config.dataDir, 'not-a-uuid'));
      assert.deepEqual(await call(empty, { kind: 'bind', bindingId: randomUUID() }), { ok: false, code: 'data_not_empty' });
    } finally { await empty.close(); }
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
      assert.ok(released.ok && released.result.kind === 'release' && released.result.dataEmpty);
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

  test('a client the operator did not enable is refused; login and run wait for T4 and T5', async () => {
    assert.deepEqual(await call(slot, { kind: 'status', bindingId, client: 'codex' }), { ok: false, code: 'client_off' });
    assert.deepEqual(await call(slot, { kind: 'login', bindingId, client: 'codex', method: 'device_code' }), { ok: false, code: 'client_off' });
    assert.deepEqual(await call(slot, { kind: 'login', bindingId, client: 'claude_code', method: 'sso' }), { ok: false, code: 'not_available' });
    const run: SupervisorRequest = { kind: 'run', bindingId, client: 'claude_code', runId: randomUUID(), prompt: 'Hello', runToken: 'aa.bb.cc', tools: ['flux_get_doc'],
      caps: { maxTurns: 10, wallClockSeconds: 300, idleSeconds: 60, maxAnswerBytes: 16384 } };
    assert.deepEqual(await call(slot, run), { ok: false, code: 'not_available' });
    assert.deepEqual(await call(slot, { ...run, bindingId: randomUUID() }), { ok: false, code: 'no_binding' });
    const stop = await call(slot, { kind: 'stop', bindingId, runId: randomUUID() });
    assert.ok(stop.ok && stop.result.kind === 'stop' && stop.result.state === 'not_running');
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
});

describe('release', () => {
  test('signs out every CLI, deletes the directory, confirms /data is empty, answers, then ends the process', async () => {
    const slot = await startTestSlot();
    try {
      const bindingId = randomUUID();
      assert.ok((await call(slot, { kind: 'bind', bindingId })).ok);
      await signIn(slot, bindingId, 'claude_code');
      await signIn(slot, bindingId, 'codex');
      const out = await call(slot, { kind: 'release', bindingId });
      assert.ok(out.ok && out.result.kind === 'release');
      assert.deepEqual(out.result, { kind: 'release', bindingId, logout: { claude_code: 'ok', codex: 'ok' }, dataEmpty: true, exiting: true });
      assert.deepEqual(out.ok && out.steps.map((step) => step.step), ['logout', 'logout', 'delete', 'verify']);
      assert.deepEqual(await readdir(slot.config.dataDir), []);
      await new Promise((done) => setTimeout(done, 50));
      assert.equal(slot.released, 1, 'onReleased ran once the answer was sent');
      // While it exits, nothing else is accepted.
      assert.deepEqual(await call(slot, { kind: 'bind', bindingId: randomUUID() }), { ok: false, code: 'busy' });
    } finally { await slot.close(); }
  });

  test('does not end the process when /data cannot be confirmed empty', async () => {
    const slot = await startTestSlot();
    try {
      const bindingId = randomUUID();
      assert.ok((await call(slot, { kind: 'bind', bindingId })).ok);
      await writeFile(join(slot.config.dataDir, 'stray'), '');
      const out = await call(slot, { kind: 'release', bindingId });
      assert.ok(out.ok && out.result.kind === 'release' && !out.result.dataEmpty && !out.result.exiting);
      assert.equal(slot.released, 0);
      assert.deepEqual(await readdir(slot.config.dataDir), ['stray']);
      assert.ok((await call(slot, { kind: 'status' })).ok, 'the supervisor keeps answering, out of the pool');
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
      assert.equal(out.result.dataEmpty, true);
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
