import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ENCRYPTED_WORKSPACES_PATH } from '@flux/contracts';
import { httpKeyring, ProcessKeys, swapFiles, swapSafety, SwapUnsafeError, type SwapFileReader } from '@flux/core';
import { createKeyring, LOCKED_LINE } from '../../apps/keyring/src/server.js';
import { swapSafe } from '../../apps/keyring/src/swap.js';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { person } from './support/people.js';

// AC-2 of F-030 (#655, S1), keyring and swap: the keyring's fixed answers and silent logs, its constant-time token check,
// the swap rule (the same in the keyring and in core), the keyring's refusal to start with swap possible, and the API's
// 503 SWAP_UNSAFE for unlock and creation (FLUX_SWAP_ACKNOWLEDGED=encrypted-swap lets it pass). #1559: a running keyring asks the swap
// rule again (every minute and before every request), wipes its boot key when swap has become possible, and serves again only after
// a restart; API and worker take that as swap unsafe and lock the spaces.

const token = randomBytes(32).toString('base64url');
const lines: string[] = [];
const keyring = createKeyring({ token, log: (line) => lines.push(line) });
let base = '';
before(async () => {
  await new Promise<void>((resolve) => keyring.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(keyring.server.address() as AddressInfo).port}`;
});
after(() => keyring.close());

const call = (path: string, init: RequestInit = {}, bearer: string | null = token) => fetch(`${base}${path}`, {
  ...init, headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), 'content-type': 'application/json', ...init.headers as Record<string, string> },
});

describe('F-030 keyring', () => {
  test('a wrong or missing token, a malformed or oversized body all get a fixed answer, with nothing echoed or logged', async () => {
    const canary = `CANARY-${randomUUID()}`;
    const cases: [Promise<Response>, number, unknown][] = [
      [call('/v1/boot', {}, `${token}x`), 401, { error: 'unauthorized' }],
      [call('/v1/boot', {}, null), 401, { error: 'unauthorized' }],
      [call(`/v1/seal?q=${canary}`, { method: 'POST', body: `{"workspaceId":"${canary}"` }), 400, { error: 'bad_request' }],
      [call('/v1/seal', { method: 'POST', body: JSON.stringify({ workspaceId: randomUUID(), keyVersion: 1, dek: `${canary}!` }) }), 400, { error: 'bad_request' }],
      [call('/v1/seal', { method: 'POST', body: JSON.stringify({ pad: canary.repeat(200) }) }), 413, { error: 'too_large' }],
      [call('/v1/open', { method: 'POST', body: JSON.stringify({ workspaceId: randomUUID(), keyVersion: 1, bootId: keyring.bootId, sealed: 'AAAA' }) }), 400, { error: 'bad_request' }],
      [call(`/v1/${canary}`), 404, { error: 'not_found' }],
    ];
    for (const [response, status, body] of cases) {
      const answer = await response;
      const text = await answer.text();
      assert.equal(answer.status, status, text);
      assert.deepEqual(JSON.parse(text), body);
      assert.equal(text.includes(canary), false);
      assert.equal(answer.headers.get('cache-control'), 'no-store');
    }
    assert.ok(lines.length >= cases.length);
    for (const line of lines) {
      assert.match(line, /^(GET|POST) \/[^ ?]* \d{3} \d+ms$/, 'method, path, status and duration only');
      assert.equal(line.includes('CANARY'), line.startsWith('GET /v1/CANARY'), 'no body, query or parse snippet is logged');
    }
  });

  test('seal and open: the boot id is the heartbeat; another boot\'s row answers 409; another workspace or version fails', async () => {
    const boot = await (await call('/v1/boot')).json() as { bootId: string };
    assert.equal(boot.bootId, keyring.bootId);
    const workspaceId = randomUUID();
    const dek = randomBytes(32);
    const sealed = await (await call('/v1/seal', { method: 'POST', body: JSON.stringify({ workspaceId, keyVersion: 1, dek: dek.toString('base64url') }) })).json() as { bootId: string; sealed: string };
    assert.equal(sealed.bootId, keyring.bootId);
    assert.equal(sealed.sealed.includes(dek.toString('base64url')), false);
    const open = (body: Record<string, unknown>) => call('/v1/open', { method: 'POST', body: JSON.stringify({ workspaceId, keyVersion: 1, bootId: keyring.bootId, sealed: sealed.sealed, ...body }) });
    assert.equal((await (await open({})).json() as { dek: string }).dek, dek.toString('base64url'));
    assert.equal((await open({ bootId: randomUUID() })).status, 409);
    assert.equal((await open({ workspaceId: randomUUID() })).status, 400);
    assert.equal((await open({ keyVersion: 2 })).status, 400);
  });

  test('the boot-key reveal exists only when asked for (test deployments)', async () => {
    assert.equal((await call('/v1/test/boot-key')).status, 404);
    const revealing = createKeyring({ token, log: () => undefined, revealBootKey: true });
    await new Promise<void>((resolve) => revealing.server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(revealing.server.address() as AddressInfo).port}/v1/test/boot-key`;
      assert.equal((await fetch(url)).status, 401, 'behind the token like every route');
      const answer = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(Buffer.from((await answer.json() as { bootKey: string }).bootKey, 'base64url').length, 32);
    } finally { await revealing.close(); }
  });

  test('the token is compared with timingSafeEqual over SHA-256 digests (the time does not depend on the token)', async () => {
    const source = await readFile(new URL('../../apps/keyring/src/server.ts', import.meta.url), 'utf8');
    assert.match(source, /timingSafeEqual\(digest\(header \?\? ''\), digest\(`Bearer \$\{token\}`\)\)/);
    assert.doesNotMatch(source, /authorization\s*===|=== `Bearer/);
  });
});

/** Fake cgroup and /proc files under a root. */
async function swapRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flux-swap-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
const HEADER = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n';
const UNSAFE = { '/sys/fs/cgroup/memory.swap.max': 'max\n', '/proc/swaps': `${HEADER}/dev/sda2                               partition\t8388604\t\t0\t\t-2\n` };

describe('F-030 swap rule', () => {
  const reader = (files: Record<string, string>): SwapFileReader => (path) => files[path] ?? null;
  const cases: [string, Record<string, string>, Record<string, string>, boolean][] = [
    ['cgroup v2 forbids swap', { '/sys/fs/cgroup/memory.swap.max': '0\n', '/proc/swaps': UNSAFE['/proc/swaps'] }, {}, true],
    ['cgroup v2 allows swap and a disk partition is on', UNSAFE, {}, false],
    ['cgroup v1 memsw equals the limit', { '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824\n', '/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes': '1073741824\n',
      '/proc/swaps': UNSAFE['/proc/swaps'] }, {}, true],
    ['cgroup v1 without a limit (both at the unlimited sentinel)', { '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
      '/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes': '9223372036854771712\n', '/proc/swaps': UNSAFE['/proc/swaps'] }, {}, false],
    ['cgroup v1 memsw above the limit', { '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824\n', '/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes': '2147483648\n',
      '/proc/swaps': UNSAFE['/proc/swaps'] }, {}, false],
    ['no swap device', { '/sys/fs/cgroup/memory.swap.max': 'max\n', '/proc/swaps': HEADER }, {}, true],
    ['zram only', { '/sys/fs/cgroup/memory.swap.max': 'max\n', '/proc/swaps': `${HEADER}/dev/zram0  partition\t8388604\t0\t100\n` }, {}, true],
    ['zram and a swap file', { '/proc/swaps': `${HEADER}/dev/zram0  partition\t1\t0\t100\n/swapfile  file\t1\t0\t-2\n` }, {}, false],
    ['nothing readable (fail closed)', {}, {}, false],
    ['acknowledged encrypted swap', UNSAFE, { FLUX_SWAP_ACKNOWLEDGED: 'encrypted-swap' }, true],
    ['any other acknowledgement', UNSAFE, { FLUX_SWAP_ACKNOWLEDGED: 'yes' }, false],
  ];
  for (const [name, files, env, expected] of cases) {
    test(`${name}: core and keyring agree (${expected ? 'safe' : 'unsafe'})`, () => {
      assert.equal(swapSafety(env, reader(files)).safe, expected);
      assert.equal(swapSafe(env, reader(files)), expected);
    });
  }

  test('the keyring refuses to start where swap is possible, and starts once it is acknowledged', async () => {
    const root = await swapRoot(UNSAFE);
    const run = (extra: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ['apps/keyring/dist/main.js'], { env: { PATH: process.env.PATH, FLUX_TEST_SWAP_ROOT: root, FLUX_KEYRING_TOKEN: token,
        FLUX_KEYRING_PORT: '0', FLUX_FIXTURE_TOKEN: 'fixture', FLUX_TEST_FAILURE_INJECTION: 'true', ...extra } });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('ready')) child.kill('SIGTERM'); });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('exit', (code) => resolve({ code, out }));
    });
    try {
      const refused = await run({});
      assert.equal(refused.code, 78, refused.out);
      assert.match(refused.out, /refuses to start: this server can write memory to disk/);
      const notTest = await run({ FLUX_TEST_FAILURE_INJECTION: 'false' });
      // Outside a test deployment the fake files are ignored: the keyring follows this container's real files.
      assert.equal(/Flux keyring ready/.test(notTest.out), swapSafety({}, swapFiles('')).safe, notTest.out);
      const acknowledged = await run({ FLUX_SWAP_ACKNOWLEDGED: 'encrypted-swap' });
      assert.match(acknowledged.out, /Flux keyring ready/);
      assert.equal(acknowledged.out.includes(token), false);
      assert.equal(acknowledged.out.includes('FLUX_KEYRING_REVEAL_BOOT_KEY'), false, 'no warning without the reveal');
      // S1 review P3: the test-only boot-key reveal is announced loudly at start, and only in a test deployment exists at all.
      const revealing = await run({ FLUX_SWAP_ACKNOWLEDGED: 'encrypted-swap', FLUX_KEYRING_REVEAL_BOOT_KEY: 'true' });
      assert.match(revealing.out, /WARNING: TEST ONLY\. Flux keyring started with FLUX_KEYRING_REVEAL_BOOT_KEY=true/);
      const installReveal = await run({ FLUX_SWAP_ACKNOWLEDGED: 'encrypted-swap', FLUX_KEYRING_REVEAL_BOOT_KEY: 'true', FLUX_TEST_FAILURE_INJECTION: 'false' });
      assert.equal(installReveal.out.includes('WARNING: TEST ONLY'), false, 'outside a test deployment the reveal is off, so nothing to announce');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

const SAFE = { '/sys/fs/cgroup/memory.swap.max': '0\n', '/proc/swaps': UNSAFE['/proc/swaps'] };

describe('F-030 the keyring asks the swap rule again (#1559)', () => {
  const listen = async (options: Parameters<typeof createKeyring>[0]) => {
    const running = createKeyring(options);
    await new Promise<void>((resolve) => running.server.listen(0, '127.0.0.1', resolve));
    return { running, url: `http://127.0.0.1:${(running.server.address() as AddressInfo).port}` };
  };
  const ask = (url: string, path: string, init: RequestInit = {}, bearer = token) =>
    fetch(`${url}${path}`, { ...init, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } });
  const waitFor = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };

  test('swap becoming possible while it runs: it wipes its key within the interval, logs one line with the fix, then answers 503 until restarted', async () => {
    let safe = true;
    const warned: string[] = [];
    const { running, url } = await listen({ token, log: () => undefined, swapSafe: () => safe, swapCheckMs: 20, warn: (line) => warned.push(line) });
    try {
      const workspaceId = randomUUID();
      const sealed = await (await ask(url, '/v1/seal', { method: 'POST', body: JSON.stringify({ workspaceId, keyVersion: 1, dek: randomBytes(32).toString('base64url') }) })).json() as { sealed: string };
      assert.equal((await ask(url, '/v1/boot')).status, 200);
      assert.equal(running.locked, false);

      safe = false; // what `systemctl daemon-reload` does to a running container: its swap limit goes back to `max`
      await waitFor(() => running.locked);
      assert.equal(running.locked, true, 'the timer found it without any request');
      assert.deepEqual(warned, [LOCKED_LINE], 'one line');
      assert.match(LOCKED_LINE, /wiped its boot key/);
      assert.match(LOCKED_LINE, /restart the keyring/);
      assert.match(LOCKED_LINE, /FLUX_SWAP_ACKNOWLEDGED=encrypted-swap/);
      for (const [path, init] of [['/v1/boot', {}], ['/v1/seal', { method: 'POST', body: '{}' }],
        ['/v1/open', { method: 'POST', body: JSON.stringify({ workspaceId, keyVersion: 1, bootId: running.bootId, sealed: sealed.sealed }) }]] as const) {
        const answer = await ask(url, path, init);
        assert.equal(answer.status, 503, path);
        assert.deepEqual(await answer.json(), { error: 'swap_unsafe', code: 'SWAP_UNSAFE' });
      }
      assert.equal((await ask(url, '/v1/boot', {}, `${token}x`)).status, 401, 'a wrong token still learns nothing');
      safe = true;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal((await ask(url, '/v1/boot')).status, 503, 'the key is gone: only a restart serves again');
      assert.equal(warned.length, 1, 'logged once, not every interval');
    } finally { await running.close(); }
  });

  test('a request finds it before the timer does: it never unwraps a key once swap is possible', async () => {
    let safe = true;
    const warned: string[] = [];
    const { running, url } = await listen({ token, log: () => undefined, swapSafe: () => safe, swapCheckMs: 60_000, warn: (line) => warned.push(line) });
    try {
      assert.equal((await ask(url, '/v1/boot')).status, 200);
      safe = false;
      assert.equal((await ask(url, '/v1/seal', { method: 'POST', body: JSON.stringify({ workspaceId: randomUUID(), keyVersion: 1, dek: randomBytes(32).toString('base64url') }) })).status, 503);
      assert.equal(running.locked, true);
      assert.equal(warned.length, 1);
    } finally { await running.close(); }
  });

  test('API and worker take its refusal as swap unsafe: every key is dropped, the spaces lock here, and a restarted keyring unlocks them again', async () => {
    let safe = true;
    const { running, url } = await listen({ token, log: () => undefined, swapSafe: () => safe, swapCheckMs: 60_000, warn: () => undefined });
    const keys = new ProcessKeys(httpKeyring({ url, token }), () => ({ safe: true, via: 'cgroup' }));
    const forgotten: (string | null)[] = [];
    keys.onForget((id) => forgotten.push(id));
    try {
      await keys.refresh({ force: true });
      assert.equal(keys.availability, 'ok');
      safe = false;
      await assert.rejects(httpKeyring({ url, token }).boot(), SwapUnsafeError);
      forgotten.length = 0;
      await keys.refresh({ force: true });
      assert.equal(keys.availability, 'swap_unsafe', 'this process\'s own rule still passes; the keyring\'s refusal is what locks it');
      assert.deepEqual(forgotten, [null]);
      assert.throws(() => keys.requireAvailable(), { code: 'SWAP_UNSAFE' });
    } finally { await running.close(); }
    // The restart: a new process, a new boot key and boot id, the limit back.
    const restarted = await listen({ token, log: () => undefined, swapSafe: () => true, swapCheckMs: 60_000, warn: () => undefined });
    try {
      const again = new ProcessKeys(httpKeyring({ url: restarted.url, token }), () => ({ safe: true, via: 'cgroup' }));
      await again.refresh({ force: true });
      assert.equal(again.availability, 'ok');
      assert.equal(again.bootId, restarted.running.bootId);
    } finally { await restarted.running.close(); }
  });

  test('the keyring process (a test deployment, fake cgroup files): cgroup memory.swap.max goes from 0 to max, it locks and its health answer turns red; restarted with 0 again it serves', async () => {
    const root = await swapRoot(SAFE);
    const probe = await new Promise<number>((resolve) => { const server = createNetServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as AddressInfo; server.close(() => resolve(port)); }); });
    const start = () => {
      const child = spawn(process.execPath, ['apps/keyring/dist/main.js'], { env: { PATH: process.env.PATH, FLUX_TEST_SWAP_ROOT: root, FLUX_TEST_SWAP_CHECK_MS: '100', FLUX_KEYRING_TOKEN: token,
        FLUX_KEYRING_PORT: String(probe), FLUX_FIXTURE_TOKEN: 'fixture', FLUX_TEST_FAILURE_INJECTION: 'true' } });
      const output = { out: '', err: '' };
      child.stdout.on('data', (chunk) => { output.out += chunk; });
      child.stderr.on('data', (chunk) => { output.err += chunk; });
      return { child, output, exited: new Promise<void>((resolve) => child.on('exit', () => resolve())) };
    };
    const boot = async () => {
      for (let i = 0; i < 100; i += 1) {
        try { return await fetch(`http://127.0.0.1:${probe}/v1/boot`, { headers: { authorization: `Bearer ${token}` } }); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      throw new Error('the keyring did not answer');
    };
    const first = start();
    try {
      const healthy = await boot();
      assert.equal(healthy.status, 200, first.output.err);
      const bootId = (await healthy.json() as { bootId: string }).bootId;
      await writeFile(join(root, '/sys/fs/cgroup/memory.swap.max'), 'max\n');
      for (let i = 0; i < 100 && !first.output.err.includes('locked itself'); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(first.output.err, /^Flux keyring locked itself: .*restart the keyring.*FLUX_SWAP_ACKNOWLEDGED=encrypted-swap/m, first.output.err);
      assert.equal(first.output.err.includes(token), false);
      const red = await boot();
      assert.equal(red.status, 503, 'the health check greps for 200 on this route');
      first.child.kill('SIGTERM');
      await first.exited;

      await writeFile(join(root, '/sys/fs/cgroup/memory.swap.max'), '0\n');
      const second = start();
      try {
        const answer = await boot();
        assert.equal(answer.status, 200, second.output.err);
        assert.notEqual((await answer.json() as { bootId: string }).bootId, bootId, 'a restart is a new boot: spaces are unlocked again by their people');
      } finally { second.child.kill('SIGTERM'); await second.exited; }
    } finally {
      first.child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('F-030 creation is a production route (S3)', () => {
  test('an install without a fixture token or failure injection (a ./flux up install) has the creation route, with no bearer', async () => {
    const ada = await person('Ada');
    const app = await buildApp(loadServerConfig({ ...process.env, FLUX_FIXTURE_TOKEN: '', FLUX_TEST_FAILURE_INJECTION: 'false' },
      '/nonexistent/flux_background_key'));
    try {
      const response = await app.inject({ method: 'POST', url: ENCRYPTED_WORKSPACES_PATH, payload: { name: 'Garden club', creationId: randomUUID(),
        password: 'quartz lantern hollow meadow ripple kestrel 4821' }, headers: { cookie: ada.browser.cookieHeader(), origin: process.env.FLUX_PUBLIC_ORIGIN ?? '' } });
      // The route answers (201, or 503 when this in-process app has no keyring); it is neither missing nor asking for a bearer.
      assert.ok(response.statusCode !== 404 && response.statusCode !== 401, `${response.statusCode} ${response.body}`);
    } finally { await app.close(); }
  });
});

describe('F-030 API swap enforcement', () => {
  const containerKeyring = process.env.FLUX_KEYRING_TOKEN;
  test('an API that fails swapSafety() answers 503 SWAP_UNSAFE for creation and unlock and reports it in health; acknowledged it passes',
    { skip: !containerKeyring && 'the test container has no keyring token (compose.test.yaml sets it)' }, async () => {
      const unsafe = await swapRoot(UNSAFE);
      const fixtureToken = process.env.FLUX_FIXTURE_TOKEN || 'fixture-encryption-keyring';
      const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
        ...process.env, FLUX_FIXTURE_TOKEN: fixtureToken, FLUX_TEST_FAILURE_INJECTION: 'true',
        FLUX_KEYRING_URL: 'http://keyring:8090', FLUX_TEST_SWAP_ROOT: unsafe, ...extra,
      });
      const ada = await person('Ada');
      const headers = { cookie: ada.browser.cookieHeader(), origin: process.env.FLUX_PUBLIC_ORIGIN ?? '', 'content-type': 'application/json',
        authorization: `Bearer ${fixtureToken}` };
      const password = 'quartz lantern hollow meadow ripple kestrel';
      const unsafeApp = await buildApp(loadServerConfig(env({}), '/nonexistent/flux_background_key'));
      const safeApp = await buildApp(loadServerConfig(env({ FLUX_SWAP_ACKNOWLEDGED: 'encrypted-swap' }), '/nonexistent/flux_background_key'));
      try {
        const health = await unsafeApp.inject({ method: 'GET', url: '/api/v1/health' });
        assert.equal(health.json().encryption, undefined, 'the unauthenticated health endpoint does not tell (the log does)');
        const refused = await unsafeApp.inject({ method: 'POST', url: ENCRYPTED_WORKSPACES_PATH, headers,
          payload: { name: 'Garden club', creationId: randomUUID(), password } });
        assert.equal(refused.statusCode, 503, refused.body);
        assert.equal(refused.json().code, 'SWAP_UNSAFE');
        const created = await safeApp.inject({ method: 'POST', url: ENCRYPTED_WORKSPACES_PATH, headers,
          payload: { name: 'Garden club', creationId: randomUUID(), password } });
        assert.equal(created.statusCode, 201, created.body);
        const workspaceId = created.json().workspace.id as string;
        const unlock = await unsafeApp.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/unlock`, headers, payload: { password } });
        assert.equal(unlock.statusCode, 503, unlock.body);
        assert.equal(unlock.json().code, 'SWAP_UNSAFE');
        // An unsafe process opens no key: the workspace is locked for it even while it is unlocked elsewhere.
        const read = await unsafeApp.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}`, headers });
        assert.equal(read.json().encryption.state, 'locked');
        const projects = await unsafeApp.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/projects`, headers });
        assert.equal(projects.statusCode, 423, projects.body);
        assert.equal((await safeApp.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/projects`, headers })).statusCode, 200);
      } finally {
        await unsafeApp.close();
        await safeApp.close();
        await rm(unsafe, { recursive: true, force: true });
      }
    });
});
