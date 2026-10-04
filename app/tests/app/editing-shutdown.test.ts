import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket, { WebSocketServer } from 'ws';
import { editingGate } from '../../apps/server/src/editing/gate.js';
import { EditingOutput, EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { registerUpgradeDispatcher } from '../../apps/server/src/http/upgrades.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { liveSignalGate } from '../../apps/server/src/live/signal-gate.js';
import { createLiveMedia } from '../../apps/server/src/live/media.js';

const origin = 'http://editing-shutdown.test';
const finite = 3000;
const closedByServer = (socket: WebSocket) => new Promise<void>(resolve => socket.once('close', () => resolve()));
async function observed(condition: () => boolean, label: string) {
  const deadline = performance.now() + finite;
  while (!condition() && performance.now() < deadline) await delay(2);
  assert.ok(condition(), label);
}
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), finite);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Real supported dispatcher/gates/Fastify/ws shutdown. Controlled identity/media authority
 * ports do not prove SQL policy, SFU quality, or a process signal/exit. In particular clients
 * remain OPEN until the actual server shutdown closes them; cleanup is not the assertion. */
for (const enabled of [false, true]) test(`shutdown itself closes active editing/stream/typing/media=${enabled} and settles retained work`, { timeout: 12_000 }, async () => {
  const session: SessionContext = { principal: { kind: 'human', id: randomUUID() }, sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000), user: { id: randomUUID(), name: 'Shutdown Person', email: 'shutdown@example.test' } };
  session.user.id = session.principal.id;
  const app = Fastify(); const fallback = new EventEmitter();
  await app.register(websocket, { options: { maxPayload: 1024, server: fallback as unknown as Server } });
  let sends = 0;
  for (const path of ['/api/v1/stream', '/api/v1/typing']) app.get(path, { websocket: true }, socket => {
    socket.on('message', bytes => {
      sends++;
      socket.send(bytes, () => { sends--; });
    });
  });
  const budget = new EditingOutputBudget(); const outputs: EditingOutput[] = [];
  let accepts = 0, blocked = false, release: () => void = () => {};
  const identity = new Promise<void>(resolve => { release = resolve; });
  const gate = editingGate({ publicOrigin: origin,
    sessions: { async resolveSession() { if (blocked) await identity; return session; } },
    authorize: async () => {},
    accept(socket) {
      accepts++;
      const output = new EditingOutput(socket, budget); outputs.push(output);
      socket.once('close', () => output.close());
      socket.on('message', () => {
        output.send({ type: 'preview', generation: randomUUID(), sequence: 0, hash: 'controlled-shutdown' },
          Buffer.allocUnsafeSlow(2 * 1024 * 1024), () => assert.fail('An unacknowledged delivery cannot complete during shutdown'));
      });
    },
  });
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(upstream, 'listening');
  upstream.on('connection', socket => {
    socket.on('error', () => {}); socket.on('message', (bytes, binary) => socket.send(bytes, { binary }));
  });
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const config = { apiUrl: `http://127.0.0.1:${upstreamPort}`, signalUrl: `ws://127.0.0.1:${upstreamPort}`,
    apiKey: 'shutdownfixturekey', apiSecret: 'shutdownfixturesecretwithatleast32characters', mediaUrl: `${origin}/media` };
  const admissionId = randomBytes(16).toString('base64url'), roomId = `room_${randomUUID()}`;
  const media = enabled ? liveSignalGate({ publicOrigin: origin, config,
    sessions: { resolveSession: async () => session },
    admissions: { find: async id => id === admissionId ? { id, userId: session.principal.id,
      authSessionId: session.sessionId, liveSessionId: randomUUID(), revokedAt: null } : null },
    signalRoom: async () => roomId, onLateRevocation: () => {}, log: app.log }) : null;
  // Match the production composition: editing.close before Fastify.close; media closes
  // in Fastify's onClose hook and stream/typing use the real plugin's shutdown hook.
  app.addHook('onClose', async () => { media?.close(); });
  const remove = registerUpgradeDispatcher(app.server, fallback, [media, gate]);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const path = `/api/v1/editing?kind=wiki&id=${randomUUID()}`;
  const clients: WebSocket[] = [];
  const make = (endpoint: string) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, { headers: { origin }, perMessageDeflate: false });
    clients.push(client); client.on('error', () => {}); return client;
  };
  const open = async (endpoint: string) => { const client = make(endpoint); await bounded(once(client, 'open'), 'Handshake deadline'); return client; };
  let shutdown: Promise<void> | undefined;
  try {
    assert.equal(app.server.listenerCount('upgrade'), 1);
    const editing = await open(path), stream = await open('/api/v1/stream'), typing = await open('/api/v1/typing');
    const grant = await createLiveMedia(config).grant(roomId, session.principal.id, admissionId);
    const mediaPath = `/media/rtc?access_token=${encodeURIComponent(grant.token)}`;
    let mediaClient: WebSocket | undefined;
    if (enabled) {
      mediaClient = await open(mediaPath);
      const echo = once(mediaClient, 'message'); mediaClient.send(Buffer.alloc(70_000));
      assert.equal(((await bounded(echo, 'Media echo deadline'))[0] as Buffer).byteLength, 70_000);
      assert.deepEqual(media?.openAdmissions(), [admissionId]);
      assert.equal(upstream.clients.size, 1);
    } else {
      const refused = make(mediaPath);
      const response = once(refused, 'unexpected-response');
      const [, incoming] = await bounded(response, 'Media-off refusal deadline') as [unknown, { statusCode: number; resume(): void }];
      assert.equal(incoming.statusCode, 404); incoming.resume(); refused.terminate();
      assert.equal(upstream.clients.size, 0);
    }
    for (const client of [stream, typing]) {
      const echo = once(client, 'message'); client.send(Buffer.alloc(1024));
      assert.equal(((await bounded(echo, 'Stream echo deadline'))[0] as Buffer).byteLength, 1024);
    }
    await observed(() => sends === 0, 'Actual fallback send callbacks settle');
    const binary = once(editing, 'message'); editing.send('begin retained output');
    const [frame] = await bounded(binary, 'Editing first-frame deadline') as [Buffer];
    assert.ok(frame.byteLength <= 65_536); assert.equal(outputs[0]?.busy, true);
    assert.ok(budget.bytes >= 2 * 1024 * 1024, 'Unacknowledged application output remains charged');
    assert.equal(gate.connected, 1);
    const active = [editing, stream, typing, ...(mediaClient ? [mediaClient] : [])];
    for (const client of active) assert.equal(client.readyState, WebSocket.OPEN);
    const closed = active.map(closedByServer);
    // A pending real upgrade remains owned until its identity operation settles. Attach
    // close/error listeners before shutdown; no accepted first frame may appear later.
    blocked = true; const pending = make(path); let lateOpen = false, lateFrame = false;
    pending.on('open', () => { lateOpen = true; }); pending.on('message', () => { lateFrame = true; });
    const pendingClosed = closedByServer(pending);
    await observed(() => gate.pending === 1, 'Real asynchronous identity admission entered');
    const closingGate = gate.close();
    await bounded(Promise.all([closed[0]!, pendingClosed]), 'Editing shutdown must close active/pending sockets');
    assert.equal(gate.pending, 1, 'Shutdown retains unresolved identity work, rather than inventing a drained count');
    assert.equal(accepts, 1); assert.equal(lateOpen, false); assert.equal(lateFrame, false);
    release();
    shutdown = (async () => { await closingGate; await app.close(); })();
    await bounded(Promise.all([shutdown, ...closed]), 'Application shutdown must close every still-open channel');
    await observed(() => budget.bytes === 0 && sends === 0 && upstream.clients.size === 0,
      'Actual send callbacks and media upstream closures must settle after shutdown');
    assert.equal(gate.pending, 0); assert.equal(gate.connected, 0);
    assert.equal(outputs.every(output => !output.busy), true); assert.deepEqual(media?.openAdmissions() ?? [], []);
    assert.equal(accepts, 1); assert.equal(lateOpen, false); assert.equal(lateFrame, false);
    assert.equal(app.server.listening, false);
    const late = make(path); let reopened = false; late.on('open', () => { reopened = true; });
    await bounded(closedByServer(late), 'Stopped application refuses a later socket'); assert.equal(reopened, false);
  } finally {
    // Emergency cleanup runs only AFTER outcome assertions, including on a failed assertion.
    // It cannot provide the successful shutdown evidence above.
    release(); for (const client of clients) client.terminate();
    await bounded(gate.close(), 'Cleanup identity/gate settlement'); media?.close();
    for (const client of upstream.clients) client.terminate();
    await bounded(new Promise<void>(resolve => upstream.close(() => resolve())), 'Cleanup upstream close');
    await bounded(shutdown ?? app.close(), 'Cleanup application close'); remove();
  }
});
