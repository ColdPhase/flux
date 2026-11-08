import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import type { EditingContext } from '../../apps/server/src/editing/gate.js';
import type { MapAuthority } from '../../apps/server/src/editing/map-authority.js';
import { mapController } from '../../apps/server/src/editing/map-controller.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { ACTIVE_FOR_MS, IDLE_EVERY_MS, TICK_MS, newCadence, readDue, touch } from '../../apps/server/src/editing/cadence.js';

// An open but untouched editor must not read its room four times a second (#850, #862: an open Map was +10,400 statements a minute).
const ticks = (cadence: ReturnType<typeof newCadence>, from: number, seconds: number, busy = () => false) => {
  let reads = 0;
  for (let at = from; at < from + seconds * 1000; at += TICK_MS) if (readDue(cadence, busy(), at)) reads += 1;
  return reads;
};

test('a connection that was just touched is read on every tick', () => {
  const cadence = newCadence(0);
  assert.equal(ticks(cadence, 0, 4), 4 * (1000 / TICK_MS));
});

test('a quiet connection is read once every IDLE_EVERY_MS after it has been quiet for ACTIVE_FOR_MS', () => {
  const cadence = newCadence(0);
  const quiet = ticks(cadence, ACTIVE_FOR_MS, 60);
  assert.ok(quiet <= 60 * 1000 / IDLE_EVERY_MS + 1, `${quiet} reads in a quiet minute`);
  assert.ok(quiet >= 60 * 1000 / IDLE_EVERY_MS - 1, `${quiet} reads in a quiet minute: still read, so a revoked person hears of it`);
});

test('any event wakes it for ACTIVE_FOR_MS, and work in flight keeps it awake', () => {
  const cadence = newCadence(0);
  ticks(cadence, ACTIVE_FOR_MS, 30);
  touch(cadence, 40_000);
  assert.equal(ticks(cadence, 40_000, ACTIVE_FOR_MS / 1000), ACTIVE_FOR_MS / TICK_MS, 'every tick for the active window');
  const later = newCadence(0);
  assert.equal(ticks(later, ACTIVE_FOR_MS + 10_000, 3, () => true), 3 * (1000 / TICK_MS), 'busy is never idle');
});

// The same thing through a real controller and socket: after the first seconds an open Map nobody touches reads its room every
// IDLE_EVERY_MS. Before #850 it read it every 250 ms for as long as the tab was open (each read is a full access check under row locks).
test('an open Map nobody touches reads its room a few times in six seconds, not twenty-four', { timeout: 30_000 }, async () => {
  const generation = randomUUID(), room = randomUUID(), workspace = randomUUID(), person = { id: randomUUID(), connectionId: randomUUID() };
  let reads = 0;
  const authority = {
    async deliver(_session: unknown, _sketch: string, _generation: string, _after: number, handoff: (result: unknown, preparation: unknown) => void) {
      reads += 1;
      handoff({ generation, sequence: 0, hash: 'h0', workspaceId: workspace, resourceId: room, canWrite: true,
        actor: { kind: 'human', id: person.id, name: 'Ada' }, delta: null, transient: [] }, { encode: () => '' });
    },
    async authorize(_session: unknown, _sketch: string, handoff: () => void) { handoff(); },
    async move() {}, async cancel() {}, async presence() {}, async disconnect() {}, async close() {},
  } as unknown as MapAuthority;
  const controller = mapController(authority, new EditingOutputBudget());
  const server = createServer(); const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let peer: WebSocket | null = null;
  try {
    const context: EditingContext = { target: { kind: 'map', id: room }, connectionId: person.connectionId,
      session: { principal: { kind: 'human', id: person.id }, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 120_000),
        user: { id: person.id, name: 'Ada', email: 'ada@example.test' } } };
    const connected = once(sockets, 'connection');
    peer = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
    peer.on('error', () => {}); await once(peer, 'open');
    const [socket] = await connected as [WebSocket]; controller.accept(socket, context);
    peer.send(JSON.stringify({ type: 'subscribe', generation, afterSequence: 0 }));
    await delay(ACTIVE_FOR_MS + 1500);
    const before = reads;
    await delay(6000);
    const quiet = reads - before;
    assert.ok(quiet <= 4, `${quiet} reads in six quiet seconds (24 before #850)`);
    assert.ok(quiet >= 2, `${quiet} reads in six quiet seconds: still read, so a person who lost access hears of it`);
  } finally {
    await controller.close();
    peer?.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
