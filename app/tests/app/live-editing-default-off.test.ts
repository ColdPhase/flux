import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { EDITING_CAPABILITIES_PATH, EDITING_SOCKET_PATH, liveDocPath, liveMapPath } from '@flux/contracts';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { developmentQueueTelemetry } from '../../apps/server/src/editing/telemetry.js';

// #228/#239: live map/wiki is required in v0.1 and stays behind the default-off development switch
// until all four F-021 gates pass. Only FLUX_DEVELOPMENT_LIVE_EDITING=true selects it; without it
// the built API reports the capability unavailable, refuses the live routes, accepts no editing
// socket and emits no live telemetry, even when the telemetry variables are set.
const base: NodeJS.ProcessEnv = {
  ...process.env,
  FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `live-default-off-${'x'.repeat(40)}`,
  FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080',
};
delete base.FLUX_DEVELOPMENT_LIVE_EDITING;
const load = (env: NodeJS.ProcessEnv) => loadServerConfig(env, '/nonexistent/flux_background_key');

test('only FLUX_DEVELOPMENT_LIVE_EDITING=true selects live editing; it is off by default', () => {
  assert.equal(load(base).developmentLiveEditing, false);
  for (const value of ['', '1', 'TRUE', 'True', 'yes', 'on', ' true', 'true ']) {
    assert.equal(load({ ...base, FLUX_DEVELOPMENT_LIVE_EDITING: value }).developmentLiveEditing, false, JSON.stringify(value));
  }
  assert.equal(load({ ...base, FLUX_DEVELOPMENT_LIVE_EDITING: 'true' }).developmentLiveEditing, true);
  // Telemetry needs the switch too: the variables alone produce no recorder.
  const telemetryEnv = { FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY: '1', FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE: 'api-one' };
  assert.equal(developmentQueueTelemetry(telemetryEnv, false, () => { throw new Error('not read when off'); }), null);
});

test('the default API reports live editing unavailable, refuses its routes and opens no editing socket', { timeout: 30_000 }, async () => {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // Records stdout while this API runs, to prove no live telemetry is emitted when off.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const config = load({ ...base, FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY: '1', FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE: 'api-one' });
    assert.equal(config.developmentLiveEditing, false);
    const server = await buildApp(config);
    app = server;
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    assert.deepEqual((await server.inject({ method: 'GET', url: EDITING_CAPABILITIES_PATH })).json(), { status: 'unavailable' });
    for (const url of [liveDocPath(randomUUID()), liveMapPath(randomUUID())]) {
      const refused = await server.inject({ method: 'GET', url, headers: { origin: config.identity.publicOrigin } });
      assert.equal(refused.statusCode, 503, url);
      assert.equal(refused.json().code, 'LIVE_EDITING_DISABLED', url);
    }
    // An explicit disabled gate owns this path before the generic WebSocket fallback.
    for (const kind of ['map', 'wiki']) {
      const socket = new WebSocket(`${address.replace('http', 'ws')}${EDITING_SOCKET_PATH}?kind=${kind}&id=${randomUUID()}`,
        { headers: { origin: config.identity.publicOrigin }, perMessageDeflate: false });
      let status: number | null = null;
      const outcome = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('no answer'), 5000);
        const settle = (value: string) => { clearTimeout(timer); resolve(value); };
        socket.once('open', () => settle('open'));
        socket.once('unexpected-response', (_request, response) => {
          status = response.statusCode ?? null; response.resume(); settle('refused');
        });
        socket.once('error', () => settle('refused'));
        socket.once('close', () => settle('refused'));
      });
      socket.terminate();
      assert.equal(outcome, 'refused', kind);
      assert.equal(status, 503, 'an actual disabled response, not an open socket or reset');
    }
    assert.equal(await server.closeGracefully(), true, 'nothing live to drain');
    app = undefined;
    assert.deepEqual(writes.filter((line) => line.includes('FLUX_LIVE_QUEUE')), [], 'no live queue telemetry when off');
  } finally {
    process.stdout.write = write;
    await app?.close();
  }
});
