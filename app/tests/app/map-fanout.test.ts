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
import { DomainError } from '@flux/core';

// #228 Gate 4: every map operation locks the room's head row, so reads take turns. A movement's
// own NOTIFY starts the room's reads once (a second, local wakeup read every connection twice),
// and the people who do not have the movement read first, the mover's own echo last.
test('a movement wakes the room once, through its NOTIFY, and the other person reads first', { timeout: 10_000 }, async () => {
  const generation = randomUUID(), room = randomUUID(), workspace = randomUUID();
  const people = ['ada', 'kai'].map((name) => ({ name, id: randomUUID(), connectionId: randomUUID() }));
  const reads: string[] = []; let moved!: () => void;
  const committed = new Promise<void>((resolve) => { moved = resolve; });
  const authority = {
    async deliver(session: EditingContext['session'], _sketch: string, _generation: string, _after: number, handoff: (result: unknown, preparation: unknown) => void) {
      const person = people.find((entry) => entry.id === session.principal.id)!;
      reads.push(person.name);
      handoff({ generation, sequence: 0, hash: 'h0', workspaceId: workspace, resourceId: room, canWrite: true,
        actor: { kind: 'human', id: person.id, name: person.name }, delta: null, transient: [] }, { encode: () => '' });
    },
    async authorize(_session: unknown, _sketch: string, handoff: () => void) { handoff(); },
    async move() { moved(); },
    async cancel() {}, async presence() {}, async disconnect() {}, async close() {},
  } as unknown as MapAuthority;
  const controller = mapController(authority, new EditingOutputBudget());
  const server = createServer(); const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const peers: WebSocket[] = [];
  try {
    for (const person of people) {
      const context: EditingContext = { target: { kind: 'map', id: room }, connectionId: person.connectionId,
        session: { principal: { kind: 'human', id: person.id }, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
          user: { id: person.id, name: person.name, email: `${person.name}@example.test` } } };
      const connected = once(sockets, 'connection');
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false }); peers.push(peer);
      peer.on('error', () => {}); await once(peer, 'open');
      const [socket] = await connected as [WebSocket]; controller.accept(socket, context);
      peer.send(JSON.stringify({ type: 'subscribe', generation, afterSequence: 0 }));
    }
    const settled = async () => { const count = reads.length; await delay(60); return reads.length === count; };
    while (!await settled()) { /* the subscription reads finish */ }
    // Right after the periodic catch-up has read both connections, so it cannot interleave.
    const before = reads.length; while (reads.length < before + 2) await delay(1);
    reads.length = 0;
    peers[0]!.send(JSON.stringify({ type: 'map-move', generation, gestureId: randomUUID(), leaseId: randomUUID(), sequence: 1,
      positions: [{ id: randomUUID(), x: 40, y: 50 }] }));
    await committed; await delay(20);
    assert.deepEqual(reads, [], 'The movement itself starts no read; its NOTIFY does');
    controller.notify(room);
    while (reads.length < 2) await delay(2);
    assert.deepEqual(reads.slice(0, 2), ['kai', 'ada'], 'The other person reads before the mover');
  } finally {
    await controller.close();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// #228 AC-4: a grant removed while a map socket is open ends that socket at its next read or write.
// The other person's socket keeps reading. Negative control: without the revoked frame and the 1008
// close in map-controller's fail(), the first assertion fails.
test('a map grant removed from an open socket sends revoked and closes it with 1008; the other person keeps reading', { timeout: 10_000 }, async () => {
  const generation = randomUUID(), room = randomUUID(), workspace = randomUUID();
  const people = ['ada', 'kai'].map((name) => ({ name, id: randomUUID(), connectionId: randomUUID() }));
  const revoked = new Set<string>(); const reads: string[] = [];
  const denied = () => new DomainError(404, 'NOT_FOUND', 'Sketch not found');
  const authority = {
    async deliver(session: EditingContext['session'], _sketch: string, _generation: string, _after: number, handoff: (result: unknown, preparation: unknown) => void) {
      if (revoked.has(session.principal.id)) throw denied();
      const person = people.find((entry) => entry.id === session.principal.id)!;
      reads.push(person.name);
      handoff({ generation, sequence: 0, hash: 'h0', workspaceId: workspace, resourceId: room, canWrite: true,
        actor: { kind: 'human', id: person.id, name: person.name }, delta: null, transient: [] }, { encode: () => '' });
    },
    async authorize(session: EditingContext['session'], _sketch: string, handoff: () => void) {
      if (revoked.has(session.principal.id)) throw denied();
      handoff();
    },
    async move() {}, async cancel() {}, async presence() {}, async disconnect() {}, async close() {},
  } as unknown as MapAuthority;
  const controller = mapController(authority, new EditingOutputBudget());
  const server = createServer(); const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const peers: WebSocket[] = []; const frames: Record<string, unknown>[][] = [[], []];
  try {
    for (const [index, person] of people.entries()) {
      const context: EditingContext = { target: { kind: 'map', id: room }, connectionId: person.connectionId,
        session: { principal: { kind: 'human', id: person.id }, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
          user: { id: person.id, name: person.name, email: `${person.name}@example.test` } } };
      const connected = once(sockets, 'connection');
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false }); peers.push(peer);
      peer.on('error', () => {}); peer.on('message', (data) => frames[index]!.push(JSON.parse(String(data)) as Record<string, unknown>));
      await once(peer, 'open');
      const [socket] = await connected as [WebSocket]; controller.accept(socket, context);
      peer.send(JSON.stringify({ type: 'subscribe', generation, afterSequence: 0 }));
    }
    const settled = async () => { const count = reads.length; await delay(60); return reads.length === count; };
    while (!await settled()) { /* the subscription reads finish */ }
    const [ada, kai] = peers as [WebSocket, WebSocket];
    const kaiClosed = once(kai, 'close');
    revoked.add(people[1]!.id); reads.length = 0;
    controller.notify(room);
    const [code] = await kaiClosed as [number];
    assert.equal(code, 1008, 'The revoked socket closes with the policy code');
    assert.ok(frames[1]!.some((frame) => frame.type === 'revoked'), 'The revoked socket is told before it closes');
    assert.equal(frames[0]!.some((frame) => frame.type === 'revoked'), false, 'The other person is not revoked');
    controller.notify(room);
    while (!reads.includes('ada')) await delay(2);
    assert.deepEqual(reads.filter((name) => name === 'kai'), [], 'No read is delivered to the revoked person');
    assert.equal(ada.readyState, WebSocket.OPEN, 'The other person keeps the socket open');
  } finally {
    await controller.close();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
