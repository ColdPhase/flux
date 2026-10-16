import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { callSupervisor, NdjsonReader, parseSupervisorFrame, type ClientStatus, type SupervisorCallOutcome, type SupervisorRequest } from '@flux/runtime-protocol';
import { Lane } from '../../apps/runtime/src/supervisor/server.js';
import { CODEX_FEATURE_REVIEW, codexRunOverrides, LOGOUT_TEMPLATES, STATUS_TEMPLATES } from '../../apps/runtime/src/supervisor/templates.js';
import { classifyCodexError, classifyError, effectiveConfigHolds } from '../../apps/runtime/src/supervisor/run.js';
import { APP_SERVER_METHODS, openAppServer, readRateLimits } from '../../apps/runtime/src/supervisor/app-server.js';
import { deviceSignInReader } from '../../apps/runtime/src/supervisor/device.js';
import { statusFacts } from '../../apps/runtime/src/supervisor/status.js';
import { portOf, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// F-022 T3: a slot's supervisor, in process, over temporary /data and /tmp with the TEST ONLY fake CLIs.
// No database and no network beyond loopback.

const target = (slot: TestSlot) => ({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });
type FixtureRequest<T> = T extends { bootId: string } ? Omit<T, 'bootId'> & { bootId?: string } : T;
const call = (slot: TestSlot, request: FixtureRequest<SupervisorRequest>) => callSupervisor(target(slot),
  ('client' in request && ['status', 'logout', 'login'].includes(request.kind) ? { bootId: slot.config.bootId, ...request } : request) as SupervisorRequest, { timeoutMs: 20_000 });

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

describe('a run\'s error results (F-022 T5; the wording is first verified against a real account in T10)', () => {
  test('a plan limit, an expired login and a refusal each have their own outcome; anything else is a crash', () => {
    assert.deepEqual(classifyError('Claude AI usage limit reached|1791374400'), { outcome: 'plan_limit', resetsAt: '2026-10-07T12:00:00.000Z' });
    assert.deepEqual(classifyError('5-hour limit reached ∙ resets 2pm'), { outcome: 'plan_limit', resetsAt: null });
    for (const text of ['Invalid API key · Please run /login', 'OAuth token has expired. Please run /login', 'Not logged in', 'API Error: 401 authentication_error'])
      assert.equal(classifyError(text).outcome, 'sign_in_again', text);
    assert.equal(classifyError('Claude refused this request under the usage policy').outcome, 'refused');
    assert.equal(classifyError('Something else went wrong').outcome, 'crashed');
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
    const config = { features: Object.fromEntries(Object.entries(CODEX_FEATURE_REVIEW).filter(([, review]) => review.action === 'off').map(([key]) => [key, false])),
      web_search: 'disabled', mcp_servers: { flux: { url, bearer_token_env_var: 'FLUX_RUN_TOKEN', required: true, enabled_tools: tools } } };
    assert.equal(effectiveConfigHolds(config, tools, url), true);
    assert.equal(effectiveConfigHolds({ ...config, features: { ...config.features, shell_tool: true } }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, web_search: 'cached' }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, mcp_servers: { ...config.mcp_servers, github: { url: 'https://x' } } }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, mcp_servers: { flux: { ...config.mcp_servers.flux, enabled_tools: [...tools, 'flux_create_task'] } } }, tools, url), false);
    assert.equal(effectiveConfigHolds({ ...config, mcp_servers: { flux: { ...config.mcp_servers.flux, required: false } } }, tools, url), false);
    assert.equal(effectiveConfigHolds({}, tools, url), false);
    assert.throws(() => codexRunOverrides([], url, 'brief'), /non-empty/);
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
    for (const key of ['shell_tool', 'unified_exec', 'apps', 'multi_agent', 'skill_mcp_dependency_install', 'hooks', 'goals', 'remote_plugin', 'memories', 'view_image',
      'code_mode_host', 'browser_use', 'computer_use', 'image_generation', 'plugins', 'daemon_auto_start']) assert.equal(CODEX_FEATURE_REVIEW[key]?.action, 'off', key);
    const argv = codexRunOverrides(['flux_get_doc'], 'http://x:8080/mcp', 'brief');
    assert.ok(argv.includes('web_search="disabled"') && argv.includes('mcp_servers.flux.required=true') && argv.includes('mcp_servers.flux.enabled_tools=["flux_get_doc"]'));
    assert.ok(!argv.some((value) => value.startsWith('tools.view_image')), '`tools.view_image` is not a key of the pinned Codex; features.view_image is');
  });

  test('the app-server client sends only initialize, config/read and account/rateLimits/read; command/exec is refused before it is written', async () => {
    const slot = await startTestSlot({ enabled: ['codex'] });
    try {
      const bindingId = randomUUID();
      assert.ok((await callSupervisor(target(slot), { kind: 'bind', bindingId })).ok);
      const dir = join(slot.config.dataDir, bindingId);
      const session = await openAppServer(slot.config.cliPaths.codex, dir, '127.0.0.1', { timeoutMs: 10_000 });
      for (const method of ['command/exec', 'thread/start', 'turn/start', 'config/write', 'initialize']) {
        await assert.rejects(session.request(method, {}), (error: Error) => error.name === 'AppServerMethodRefused', method);
      }
      assert.ok(await session.request('config/read', {}));
      session.close();
      const methods = (await calls(slot, bindingId, 'codex') as unknown as { event?: string; method?: string }[]).filter((entry) => entry.event === 'app_server').map((entry) => entry.method);
      assert.deepEqual(methods.filter((method) => method !== 'initialized'), ['initialize', 'config/read'], 'nothing else reached the app-server');
      assert.deepEqual(APP_SERVER_METHODS, ['initialize', 'config/read', 'account/rateLimits/read']);
    } finally { await slot.close(); }
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
