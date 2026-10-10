import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { Server } from 'node:http';
import { connect as tcpConnect, type AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket, { WebSocketServer } from 'ws';
import { editingGate, EDITING_FRAME_BYTES, EDITING_PATH, type EditingContext } from '../../apps/server/src/editing/gate.js';
import { registerUpgradeDispatcher } from '../../apps/server/src/http/upgrades.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { liveSignalGate } from '../../apps/server/src/live/signal-gate.js';
import { createLiveMedia } from '../../apps/server/src/live/media.js';

const origin = 'http://editing.test';
const targetId = randomUUID();
const session: SessionContext = { principal: { kind: 'human', id: 'current-human' }, sessionId: 'current-session',
  expiresAt: new Date(Date.now() + 60_000), user: { id: 'current-human', name: 'Current Person', email: 'person@example.test' } };
const path = `${EDITING_PATH}?kind=wiki&id=${targetId}`;

/** Actual Fastify/plugin/ws transports and the application's dispatcher, with controlled authority ports.
 * This exercises transport ownership, not the still-pending PostgreSQL policy/delivery fence. */
async function fixture(t: TestContext, options: {
  media?: boolean; authorize?: (context: EditingContext) => Promise<void>;
  resolveSession?: () => Promise<SessionContext | null>;
} = {}) {
  const app = Fastify();
  const fallback = new EventEmitter();
  await app.register(websocket, { options: { maxPayload: 1024, server: fallback as unknown as Server } });
  app.get('/api/v1/stream', { websocket: true }, (socket) => {
    socket.on('message', (bytes) => socket.send(bytes));
  });
  // Conversation typing uses this same fallback/plugin as #170, not an additional upgrader.
  app.get('/api/v1/typing', { websocket: true }, (socket) => {
    socket.on('message', (bytes) => socket.send(bytes));
  });
  const received: Buffer[] = [];
  const contexts: EditingContext[] = [];
  const gate = editingGate({ publicOrigin: origin,
    sessions: { resolveSession: options.resolveSession ?? (async () => session) },
    authorize: options.authorize ?? (async () => undefined),
    accept(socket, context) {
      contexts.push(context);
      socket.on('message', (bytes) => {
        const copied = Buffer.from(bytes as Buffer); received.push(copied);
        socket.send(copied, { binary: true });
      });
    },
  });
  // The production media gate/token verifier/proxy participates in dispatch. Its upstream
  // is a bounded synthetic signaling echo, so this does not certify SFU quality or SQL access.
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024, perMessageDeflate: false });
  await once(upstream, 'listening');
  upstream.on('connection', (socket) => {
    socket.on('error', () => socket.terminate()); socket.on('message', (bytes, binary) => socket.send(bytes, { binary }));
  });
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const config = { apiUrl: `http://127.0.0.1:${upstreamPort}`, signalUrl: `ws://127.0.0.1:${upstreamPort}`,
    apiKey: 'editingtransportkey', apiSecret: 'editingtransportsecretwithatleast32characters', mediaUrl: `${origin}/media` };
  const admissionId = randomBytes(16).toString('base64url'); const roomId = `room_${randomUUID()}`;
  const media = options.media ? liveSignalGate({ publicOrigin: origin, config,
    sessions: { resolveSession: async () => session },
    admissions: { find: async (id) => id === admissionId ? { id, userId: session.principal.id,
      authSessionId: session.sessionId, liveSessionId: 'controlled-live-session', revokedAt: null } : null },
    signalRoom: async () => roomId, onLateRevocation: () => undefined, log: app.log }) : null;
  const grant = await createLiveMedia(config).grant(roomId, session.principal.id, admissionId);
  const mediaPath = `/media/rtc?access_token=${encodeURIComponent(grant.token)}`;
  const remove = registerUpgradeDispatcher(app.server, fallback, [media, gate]);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const sockets = new Set<WebSocket>();
  const open = async (endpoint = path, headers: Record<string, string> = { origin }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, { headers, perMessageDeflate: false });
    sockets.add(socket); socket.on('error', () => undefined); socket.once('close', () => sockets.delete(socket));
    await once(socket, 'open'); return socket;
  };
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await gate.close();
    media?.close();
    for (const client of upstream.clients) client.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await app.close(); remove();
  });
  return { app, port, gate, received, contexts, open, mediaPath };
}

async function refused(port: number, endpoint: string, headers: Record<string, string>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, { headers });
  socket.on('error', () => undefined);
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Refusal timeout')); }, 2_000);
    socket.once('open', () => { clearTimeout(timeout); socket.terminate(); resolve(101); });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout); response.resume(); socket.terminate(); resolve(response.statusCode ?? 0);
    });
  });
}

for (const media of [false, true]) test(`one dispatcher keeps stream/typing 1024 and editing 65536 with media ${media}`, async (t) => {
  const f = await fixture(t, { media });
  assert.equal(f.app.server.listenerCount('upgrade'), 1);
  const editing = await f.open();
  const bytes = randomBytes(EDITING_FRAME_BYTES);
  const echoed = once(editing, 'message'); editing.send(bytes); assert.deepEqual((await echoed)[0], bytes);
  assert.equal(editing.extensions, '');
  assert.equal(f.contexts[0]!.session.user.name, 'Current Person');
  assert.ok(f.contexts[0]!.connectionId);
  assert.equal(f.contexts[0]!.target.id, targetId);
  const exceeded = once(editing, 'close'); editing.send(randomBytes(EDITING_FRAME_BYTES + 1));
  assert.equal((await exceeded)[0], 1009);
  for (const endpoint of ['/api/v1/stream', '/api/v1/typing']) {
    const socket = await f.open(endpoint);
    const reply = once(socket, 'message'); socket.send(Buffer.alloc(1024)); assert.equal(((await reply)[0] as Buffer).length, 1024);
    const closed = once(socket, 'close'); socket.send(Buffer.alloc(1025)); assert.equal((await closed)[0], 1009);
  }
  if (media) {
    const socket = await f.open(f.mediaPath); const reply = once(socket, 'message');
    socket.send(Buffer.alloc(70_000)); assert.equal(((await reply)[0] as Buffer).length, 70_000);
  } else {
    assert.equal(await refused(f.port, f.mediaPath, { origin }), 404);
  }
});

test('editing refusal happens before handshake and a client cannot supply another actor', async (t) => {
  let authorizations = 0;
  const f = await fixture(t, { authorize: async () => { authorizations++; } });
  assert.equal(await refused(f.port, path, {}), 403);
  assert.equal(await refused(f.port, path, { origin: 'http://other.test' }), 403);
  assert.equal(await refused(f.port, `${path}&actor=other`, { origin }), 400);
  assert.equal(await refused(f.port, `${path}&id=${targetId}`, { origin }), 400);
  assert.equal(authorizations, 0); assert.equal(f.contexts.length, 0);
  const anonymous = await fixture(t, { resolveSession: async () => null });
  assert.equal(await refused(anonymous.port, path, { origin }), 401);
  const hidden = await fixture(t, { authorize: async () => { throw new Error('Hidden or absent'); } });
  assert.equal(await refused(hidden.port, path, { origin }), 404);
  assert.equal(hidden.received.length, 0);
});

test('a session expiring during asynchronous admission sends no accepted frame', async (t) => {
  const expiring = { ...session, expiresAt: new Date(Date.now() + 30) };
  const f = await fixture(t, { resolveSession: async () => expiring,
    authorize: async () => { await delay(50); } });
  assert.equal(await refused(f.port, path, { origin }), 401);
  assert.equal(f.contexts.length, 0); assert.equal(f.received.length, 0);
});

test('a frame sent in the HTTP upgrade head survives asynchronous admission and synchronous handlers', async (t) => {
  const f = await fixture(t, { authorize: async () => { await delay(20); } });
  const socket = tcpConnect(f.port, '127.0.0.1'); socket.on('error', () => undefined);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const bytes = Buffer.from('initial binary frame'); const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + bytes.length); frame[0] = 0x82; frame[1] = 0x80 | bytes.length; mask.copy(frame, 2);
  for (let i = 0; i < bytes.length; i++) frame[6 + i] = bytes[i]! ^ mask[i % 4]!;
  const request = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${origin}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`;
  socket.write(Buffer.concat([Buffer.from(request), frame]));
  const until = Date.now() + 1_000;
  while (!f.received.length && Date.now() < until) await delay(5);
  assert.deepEqual(f.received, [bytes]); assert.equal(f.contexts.length, 1);
});

test('pending identity work consumes the connection bound and late resolution cannot reopen after shutdown', async (t) => {
  let release: (value: SessionContext) => void = () => undefined;
  const blocked = new Promise<SessionContext>((resolve) => { release = resolve; });
  const f = await fixture(t, { resolveSession: () => blocked });
  const sockets = Array.from({ length: 32 }, () => {
    const socket = new WebSocket(`ws://127.0.0.1:${f.port}${path}`, { headers: { origin } });
    socket.on('error', () => undefined); return socket;
  });
  t.after(() => sockets.forEach((socket) => socket.terminate()));
  const until = Date.now() + 1_000;
  while (f.gate.pending < 32 && Date.now() < until) await delay(5);
  assert.equal(f.gate.pending, 32);
  assert.equal(await refused(f.port, path, { origin }), 503);
  const closing=f.gate.close();await delay(10);assert.equal(f.gate.pending,32,'Closing retains actual pending identity work until its finite settlement');
  release(session);await closing; await delay(10);
  assert.equal(f.contexts.length, 0); assert.equal(f.gate.connected, 0); assert.equal(f.gate.pending, 0);
});
