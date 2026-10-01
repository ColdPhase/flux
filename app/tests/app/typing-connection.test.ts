import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { TypingActor, TypingNotificationPort, TypingPulse } from '@flux/core';
import type { TypingContext } from '@flux/contracts';
import { TypingConnection } from '../../apps/server/src/typing/connection.js';
import { TypingHub } from '../../apps/server/src/typing/hub.js';
import { Browser } from './support/http.js';
import { TypingClient } from './support/typing.js';

function gate() {
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { ready, wait, release, entered };
}
const context: TypingContext = { kind: 'conversation', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };

/** Real loopback sockets with controlled timing ports, not production identity/SQL evidence. */
async function fixture() {
  let humanDelay: { actorId: string; gate: ReturnType<typeof gate> } | null = null;
  let stopDelay: ReturnType<typeof gate> | null = null;
  let activeFailure: ReturnType<typeof gate> | null = null;
  let publications = 0; let maximum = 0; let released = 0;
  let clockFailure = false;
  const published: TypingPulse[] = [];
  const notifications: TypingNotificationPort = {
    now: async () => { if (clockFailure) { clockFailure = false; throw new Error('Fixture clock unavailable'); } return Date.now(); },
    async publish(input, minimumExpiry) {
      publications++; maximum = Math.max(maximum, publications);
      try {
        if (input.active && activeFailure) { const delay = activeFailure; activeFailure = null; delay.entered(); await delay.wait; throw new Error('Fixture publication rejected'); }
        if (!input.active && stopDelay) { const delay = stopDelay; stopDelay = null; delay.entered(); await delay.wait; }
        const pulse = { ...input, context: { ...input.context }, expiresAt: Math.max(Date.now() + 5000, minimumExpiry) };
        published.push(pulse); hub.notification(JSON.stringify(pulse)); return pulse;
      } finally { publications--; }
    },
  };
  const hub = new TypingHub({
    async currentHuman(actor) {
      if (humanDelay?.actorId === actor.actorId) { const delay = humanDelay.gate; humanDelay = null; delay.entered(); await delay.wait; }
      return { id: actor.actorId, name: actor.actorId };
    },
    canonicalContext: async (_principal, target) => ({ ...target }),
  }, notifications);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const connections: TypingConnection[] = [];
  const serverSockets: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    serverSockets.push(socket);
    const actorId = request.headers.cookie!.slice('fixture='.length);
    const actor: TypingActor = { actorId, sessionId: `${actorId}-fixture-session` };
    let once = false;
    connections.push(new TypingConnection(socket, actor, hub, () => { if (!once) { once = true; released++; } }));
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  hub.availability(true);
  const clients: TypingClient[] = [];
  async function connect(actorId: string) {
    const browser = new Browser(); browser.cookies.set('fixture', actorId);
    const client = await TypingClient.connect(browser, 'http://fixture', `http://127.0.0.1:${port}`); clients.push(client); return client;
  }
  return {
    hub, published, connections, serverSockets, connect,
    holdHuman(actorId: string) { const delay = gate(); humanDelay = { actorId, gate: delay }; return delay; },
    holdStop() { const delay = gate(); stopDelay = delay; return delay; },
    holdActiveFailure() { const delay = gate(); activeFailure = delay; return delay; },
    failClock() { clockFailure = true; hub.wake(); },
    get maximum() { return maximum; }, get released() { return released; },
    async close() { humanDelay?.gate.release(); stopDelay?.release(); activeFailure?.release(); await Promise.all(clients.map((client) => client.close())); await hub.close(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
const visible = (client: TypingClient, id: string) => client.messages.at(-1)?.people.some((person) => person.id === id) === true;

test('terminal publication bypasses unrelated blocked authorization on its sender socket', async () => {
  const f = await fixture(); let delayed: ReturnType<typeof gate> | null = null;
  try {
    const alice = await f.connect('alice'); const bob = await f.connect('bob');
    await Promise.all([alice.watch(context), bob.watch(context)]);
    alice.send({ type: 'active', active: true }); await bob.until(() => visible(bob, 'alice'), 'Alice active');
    delayed = f.holdHuman('alice');
    f.connections[0]!.heartbeat(); await delayed.ready;
    const at = performance.now(); alice.send({ type: 'active', active: false });
    await bob.until(() => !visible(bob, 'alice'), 'stop while own authorization is held', 750);
    assert.ok(performance.now() - at < 750);
    delayed.release(); delayed = null;
  } finally { delayed?.release(); await f.close(); }
});

test('held old stop and newer active remain serial; final stop cannot lose newer publication', async () => {
  const f = await fixture(); let held: ReturnType<typeof gate> | null = null;
  try {
    const alice = await f.connect('alice'); const bob = await f.connect('bob');
    await Promise.all([alice.watch(context), bob.watch(context)]);
    alice.send({ type: 'active', active: true }); await bob.until(() => visible(bob, 'alice'), 'first activity');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    held = f.holdStop(); alice.send({ type: 'active', active: false }); await held.ready;
    alice.send({ type: 'active', active: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.maximum, 1, 'a pending terminal SQL operation excludes a concurrent active publication');
    held.release(); held = null;
    await alice.until(() => f.published.filter((pulse) => pulse.actorId === 'alice' && pulse.active).length === 2, 'new activity after old stop');
    await bob.until(() => visible(bob, 'alice'), 'newer current activity');
    alice.send({ type: 'active', active: false }); await bob.until(() => !visible(bob, 'alice'), 'last stop', 750);
    assert.deepEqual(f.published.filter((pulse) => pulse.actorId === 'alice').map((pulse) => pulse.active), [true, false, true, false]);
    assert.equal(f.maximum, 1);
  } finally { held?.release(); await f.close(); }
});

test('unrelated broker activity and compatible refresh do not starve or falsely clear a slow delivery', async () => {
  const f = await fixture(); let delayed: ReturnType<typeof gate> | null = null; let timer: ReturnType<typeof setInterval> | null = null;
  try {
    const bob = await f.connect('bob'); await bob.watch(context);
    const connectionId = randomUUID(); let sequence = 1;
    const pulse = (): TypingPulse => ({ connectionId, actorId: 'alice', sessionId: 'alice-fixture-session', context, sequence: sequence++, active: true, expiresAt: Date.now() + 5000 });
    delayed = f.holdHuman('alice'); f.hub.notification(JSON.stringify(pulse())); await delayed.ready;
    let foreignSequence = 1; const foreignId = randomUUID();
    timer = setInterval(() => f.hub.notification(JSON.stringify({ ...pulse(), connectionId: foreignId, context: { ...context, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, sequence: foreignSequence++ })), 20);
    f.hub.notification(JSON.stringify(pulse()));
    await new Promise((resolve) => setTimeout(resolve, 180)); delayed.release(); delayed = null;
    await bob.until(() => visible(bob, 'alice'), 'slow delivery despite unrelated pulses', 1000);
    const prior = bob.messages.length;
    f.hub.notification(JSON.stringify(pulse())); await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(bob.messages.slice(prior).every((frame) => frame.people.some((human) => human.id === 'alice')), 'no false empty ready frame during same-author refresh');
  } finally { if (timer) clearInterval(timer); delayed?.release(); await f.close(); }
});

test('closed transport retains unfinished authorization permit and closing flood adds no listeners', async () => {
  const f = await fixture(); let delayed: ReturnType<typeof gate> | null = null;
  try {
    const alice = await f.connect('alice');
    delayed = f.holdHuman('alice'); f.connections[0]!.heartbeat(); await delayed.ready;
    alice.socket.close(1000); await alice.closed;
    assert.equal(f.released, 0, 'unfinished query still consumes admission');
    delayed.release(); delayed = null;
    await alice.until(() => f.released === 1, 'permit released after settlement');
    const flood = await f.connect('flood');
    const closeListeners = f.serverSockets[1]!.listenerCount('close');
    for (let i = 0; i < 100; i++) flood.send({ type: 'active', active: false });
    assert.equal(await flood.closed, 1008);
    await flood.until(() => f.released === 2, 'flood closure releases exactly once');
    assert.equal(f.serverSockets[1]!.listenerCount('close'), closeListeners, 'no per-buffered-frame termination listeners');
  } finally { delayed?.release(); await f.close(); }
});

test('rejected in-flight first active retires its terminal marker and releases the closed admission', async () => {
  const f = await fixture(); let held: ReturnType<typeof gate> | null = null;
  try {
    const alice = await f.connect('alice'); await alice.watch(context);
    held = f.holdActiveFailure(); alice.send({ type: 'active', active: true }); await held.ready;
    alice.send({ type: 'active', active: false }); alice.socket.close(1000); await alice.closed;
    assert.equal(f.released, 0);
    held.release(); held = null;
    await alice.until(() => f.released === 1, 'rejected publication settles its retained admission');
    assert.equal(f.published.length, 0);
    assert.equal(f.maximum, 1);
  } finally { held?.release(); await f.close(); }
});

test('database clock failure drains discarded stop fences before admitting delayed older activity', async () => {
  const f = await fixture();
  try {
    const bob = await f.connect('bob'); await bob.watch(context);
    const first: TypingPulse = { connectionId: randomUUID(), actorId: 'alice', sessionId: 'alice-fixture-session', context,
      sequence: 1, active: true, expiresAt: Date.now() + 5000 };
    f.hub.notification(JSON.stringify(first)); await bob.until(() => visible(bob, 'alice'), 'first activity');
    f.hub.notification(JSON.stringify({ ...first, active: false, sequence: 2, expiresAt: Date.now() + 5000 }));
    await bob.until(() => !visible(bob, 'alice'), 'stop fence');
    f.failClock(); await bob.until(() => bob.messages.at(-1)?.availability === 'unavailable', 'clock uncertainty');
    f.hub.notification(JSON.stringify(first));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(visible(bob, 'alice'), false, 'late older positive cannot resurrect after discarded stop fence');
    assert.equal(bob.messages.at(-1)?.availability, 'unavailable');
  } finally { await f.close(); }
});
