import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, stat, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { initialize, publicOrigin, readJson, readState, writeJson } from './state.mjs';
import { authorizeBoundary, startGateway } from './gateway.mjs';
import { sanitized } from './sanitize-worker.mjs';
import { Client, main } from './helper.mjs';

const candidate = 'a'.repeat(40);
async function temporary(operation) {
  const directory = await mkdtemp('/tmp/fixture-'); await chmod(directory, 0o700);
  try { return await operation(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('fresh credentials and valid VAPID keys stay in private state; fixture initializes closed', () => temporary(async directory => {
  const result = await initialize(directory, candidate);
  assert.equal(result.candidate, candidate); assert.equal('password' in result, false);
  for (const name of ['state.json', 'secrets.json', 'fixture.env', 'boundary.json']) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  const secret = await readJson(directory, 'secrets.json');
  assert.notEqual(secret.recipient.password, secret.producer.password);
  const key = createECDH('prime256v1'); key.setPrivateKey(Buffer.from(secret.vapid.privateKey, 'base64url'));
  assert.equal(key.getPublicKey().toString('base64url'), secret.vapid.publicKey);
  assert.equal((await readJson(directory, 'boundary.json')).enabled, false);
  const env = await readFile(join(directory, 'fixture.env'), 'utf8');
  assert.match(env, /^MOBILE_PROJECT=flux-mobile-/m); assert.doesNotMatch(env, /FLUX_TEST|ALLOW_PRIVATE|NODE_EXTRA_CA/);
  await assert.rejects(initialize(directory, candidate), /already exists/);
}));
test('private state refuses public permissions, symlinks and expired leases', () => temporary(async directory => {
  await initialize(directory, candidate);
  await chmod(join(directory, 'secrets.json'), 0o644);
  await assert.rejects(readJson(directory, 'secrets.json'), /Unsafe state/);
  const state = await readState(directory); state.expiresAt = Date.now() - 1; await writeJson(directory, 'state.json', state);
  await assert.rejects(readState(directory), /expired/);
  await rm(join(directory, 'secrets.json')); await symlink(join(directory, 'state.json'), join(directory, 'secrets.json'));
  await assert.rejects(readJson(directory, 'secrets.json'), /Unsafe state/);
}));
test('boundary requires live lease, exact host and denies public registration/fixture commands', () => {
  const boundary = { enabled: true, origin: 'https://fixture.trycloudflare.com', expiresAt: 1000 };
  assert.equal(authorizeBoundary({ ...boundary, enabled: false }, 'fixture.trycloudflare.com', '/', 500), 503);
  assert.equal(authorizeBoundary(boundary, 'fixture.trycloudflare.com', '/', 1000), 503);
  assert.equal(authorizeBoundary(boundary, 'foreign.invalid', '/', 500), 421);
  for (const invalid of [null, {}, { ...boundary, enabled: 'true' }, { ...boundary, origin: 'not a URL' }, { ...boundary, origin: 'https://user:password@fixture.trycloudflare.com' }, { ...boundary, expiresAt: '1000' }]) assert.equal(authorizeBoundary(invalid, 'fixture.trycloudflare.com', '/', 500), 503);
  for (const path of ['/api/auth/sign-up/email', '/api/auth/request-password-reset', '/api/v1/integrations/github', '/api/v1/integration/sample', '/api/v1/projects/a/files', '/mcp', '/media']) assert.equal(authorizeBoundary(boundary, 'fixture.trycloudflare.com', path, 500), 403);
  for (const path of ['/api/auth/%73ign-up/email', '/api//auth/sign-up/email', '//api/auth/sign-up/email']) assert.equal(authorizeBoundary(boundary, 'fixture.trycloudflare.com', path, 500), 400);
  for (const path of ['/sw.js', '/manifest.webmanifest', '/api/auth/sign-in/email', '/api/v1/push/subscriptions', '/api/v1/inbox']) assert.equal(authorizeBoundary(boundary, 'fixture.trycloudflare.com', path, 500), 200);
});
test('live gateway refuses a closed boundary and tears down an open response after closure', () => temporary(async directory => {
  await initialize(directory, candidate);
  let hits = 0;
  const upstream = http.createServer((_req, response) => {
    hits++;
    response.writeHead(200); response.write('synthetic');
    const interval = setInterval(() => response.write('synthetic'), 100);
    response.on('close', () => clearInterval(interval));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = startGateway(directory, 0, { hostname: '127.0.0.1', port: upstream.address().port }); await once(gateway, 'listening');
  const options = { hostname: '127.0.0.1', port: gateway.address().port, headers: { host: 'fixture.trycloudflare.com' } };
  try {
    const closed = await new Promise(resolve => http.get(options, r => { r.resume(); resolve(r.statusCode); }));
    assert.equal(closed, 503);
    assert.equal(hits, 0);
    await writeJson(directory, 'boundary.json', { enabled: true, origin: 'https://fixture.trycloudflare.com', expiresAt: Date.now() + 10_000 });
    for (const [extra, expected] of [
      [{ headers: { host: 'foreign.invalid' } }, 421],
      [{ path: '/api/auth/sign-up/email' }, 403],
      [{ headers: { host: 'fixture.trycloudflare.com', 'content-length': '1048577' } }, 413],
    ]) {
      const status = await new Promise(resolve => http.get({ ...options, ...extra }, r => { r.resume(); resolve(r.statusCode); }));
      assert.equal(status, expected); assert.equal(hits, 0);
    }
    const response = await new Promise(resolve => http.get(options, resolve));
    assert.equal(response.statusCode, 200);
    const stopped = new Promise((resolve, reject) => { response.on('close', resolve); setTimeout(() => reject(new Error('Boundary did not close active response')), 2500).unref(); });
    response.on('error', () => {}); response.resume();
    await writeJson(directory, 'boundary.json', { enabled: false }); await stopped;
  } finally {
    gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close();
  }
}));
test('lease expiry disconnects an existing upgraded socket and its upstream', () => temporary(async directory => {
  await initialize(directory, candidate);
  let upstreamSocket;
  const upstream = http.createServer();
  upstream.on('upgrade', (_req, socket) => {
    upstreamSocket = socket; socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    // HTTP upgrade sockets allow half-open transport. Behave like a receiving
    // WebSocket peer: consume FIN and finish our side before asserting both close.
    socket.on('end', () => socket.end()); socket.resume();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = startGateway(directory, 0, { hostname: '127.0.0.1', port: upstream.address().port }); await once(gateway, 'listening');
  await writeJson(directory, 'boundary.json', { enabled: true, origin: 'https://fixture.trycloudflare.com', expiresAt: Date.now() + 1200 });
  const socket = net.connect(gateway.address().port, '127.0.0.1');
  try {
    await once(socket, 'connect');
    socket.write('GET /api/v1/stream HTTP/1.1\r\nHost: fixture.trycloudflare.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    const [data] = await once(socket, 'data'); assert.match(data.toString(), /101 Switching Protocols/);
    const closed = once(socket, 'close');
    const upstreamClosed = once(upstreamSocket, 'close');
    await Promise.race([Promise.all([closed, upstreamClosed]), new Promise((_, reject) => setTimeout(() => reject(new Error('Expired upgrade remained connected')), 3000).unref())]);
    assert.equal(upstreamSocket.destroyed, true);
  } finally { socket.destroy(); upstreamSocket?.destroy(); gateway.closeAllConnections(); gateway.close(); upstream.close(); }
}));
test('opening HTTPS requires exact reviewed source and fresh fixture; close works after lease expiry', () => temporary(async directory => {
  await initialize(directory, candidate);
  const state = await readState(directory); state.seeded = true; state.image = `sha256:${'b'.repeat(64)}`; await writeJson(directory, 'state.json', state);
  await assert.rejects(main(['boundary', 'https', 'https://fixture.trycloudflare.com', 'c'.repeat(40)], directory), /review/);
  const result = await main(['boundary', 'https', 'https://fixture.trycloudflare.com', candidate], directory);
  assert.equal(result.prepared, true); assert.equal((await readJson(directory, 'boundary.json')).enabled, false);
  await main(['enable', result.origin], directory);
  assert.equal((await readJson(directory, 'boundary.json')).enabled, true);
  state.expiresAt = Date.now() - 1; await writeJson(directory, 'state.json', state);
  assert.deepEqual(await main(['close'], directory), { closed: true });
  assert.equal((await readJson(directory, 'boundary.json')).enabled, false);
}));
test('origin validation excludes credentials, subpaths, local HTTPS and normalized aliases', () => {
  for (const value of ['https://user:password@fixture.example.org', 'https://fixture.example.org/path', 'https://localhost', 'https://127.0.0.1', 'https://fixture.local', 'https://fixture.example.org:443']) assert.throws(() => publicOrigin(value));
  assert.equal(publicOrigin('https://fixture.trycloudflare.com'), 'https://fixture.trycloudflare.com');
  assert.equal(publicOrigin('http://127.0.0.1:8232', true), 'http://127.0.0.1:8232');
});
test('worker evidence allowlists only opaque aliases, outcome and provider status', () => {
  const raw = { job: 'push.send', id: 'job-private-id', subscriptionId: 'sub-private-id', outcome: 'sent', status: 201,
    endpoint: 'https://provider.invalid/private-token', auth: 'private-auth', reason: 'private URL', preview: 'full', body: 'text' };
  const result = sanitized(JSON.stringify(raw));
  assert.deepEqual(Object.keys(result), ['job', 'subscription', 'outcome', 'status']);
  assert.equal(result.status, 201);
  assert.doesNotMatch(JSON.stringify(result), /private|token|auth|endpoint|preview|body/);
  assert.equal(sanitized('not JSON'), null); assert.equal(sanitized(JSON.stringify({ ...raw, job: 'other.job' })), null);
  assert.equal(sanitized(JSON.stringify({ ...raw, outcome: 'rejected', status: 403 })).status, 403);
});
test('API failure cannot leak response bodies, session identifiers or cookie credentials', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => new Response('secret-body', { status: 403, headers: { 'set-cookie': 'session=secret-cookie; Path=/' } });
  try {
    const client = new Client('http://api:8080', 'https://fixture.trycloudflare.com');
    await assert.rejects(client.request('DELETE', '/api/v1/sessions/private-session'), error => {
      assert.doesNotMatch(error.message, /secret|private-session/); return /403/.test(error.message);
    });
  } finally { globalThis.fetch = old; }
});
