import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import type { LiveReceipt, WikiTextEnvelope } from '@flux/contracts';
import type { EditingContext } from '../../apps/server/src/editing/gate.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { editingRuntime } from '../../apps/server/src/editing/runtime.js';
import { packet } from '../../apps/server/src/editing/codec/assembly.mjs';
import { wikiController } from '../../apps/server/src/editing/wiki-controller.js';

type Authority = Parameters<typeof wikiController>[0];

// #228 Gate 4: confirmed reads take turns API-wide. After a commit, the people who do not have the
// change yet are read first; the author's read only carries back its own update.
test('a commit is fanned out to the other people before the connection whose commit it is', { timeout: 10_000 }, async () => {
  const runtime = editingRuntime(); const budget = new EditingOutputBudget();
  const generation = randomUUID(), workspace = randomUUID(), room = randomUUID();
  const people = ['ada', 'kai'].map((name) => ({ name, id: randomUUID(), connectionId: randomUUID() }));
  const reads: string[] = []; let committing!: () => void;
  const held = new Promise<void>((resolve) => { committing = resolve; });
  const authority: Authority = {
    runtime, queueInput: runtime.queueInput,
    async submit(_session, _id, envelope, _bytes, admission) {
      try {
        await held; // The author's commit and receipt are still in flight.
        return { workspaceId: workspace, resourceId: room, generation, sequence: 1, hash: 'h1', commandId: envelope.uuid,
          operation: 'text', fingerprint: 'f', changed: true } satisfies LiveReceipt;
      } finally { runtime.release(admission); }
    },
    async deliverReceipt() {},
    async deliver(session, _id, _generation, _afterSequence, handoff) {
      reads.push(people.find((person) => person.id === session.principal.id)!.name);
      const principal = () => ({ kind: 'human' as const, id: session.principal.id, name: 'Reader' });
      handoff({ current: { workspaceId: workspace, resourceId: room, generation, sequence: 0, hash: 'h0', savedVersion: 1, savedSequence: 0 },
        canWrite: true, actor: principal(), presence: [], updates: [], preview: null } as unknown as Parameters<typeof handoff>[0]);
    },
    async handoff(_session, _id, handoff) { handoff(); },
    async cursor() {},
    close: runtime.close,
  };
  const controller = wikiController(authority, budget);
  const server = createServer(); const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const peers: WebSocket[] = [];
  try {
    for (const person of people) {
      const context: EditingContext = { target: { kind: 'wiki', id: room }, connectionId: person.connectionId,
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
    // Ada (the connection accepted first) sends text; her commit is in flight when the room is notified.
    const doc = new Y.Doc(); doc.getText('body').insert(0, 'Ada types.');
    const envelope: WikiTextEnvelope = { workspace, kind: 'wiki', room, generation, actor: people[0]!.id, operation: 'text',
      uuid: randomUUID(), replica: doc.clientID, parameters: null };
    peers[0]!.send(packet({ ...envelope, count: 1, index: 0 }, Y.encodeStateAsUpdate(doc))); doc.destroy();
    await delay(60);
    // Right after the periodic catch-up has read both connections, so it cannot interleave.
    const before = reads.length; while (reads.length < before + 2) await delay(1);
    reads.length = 0;
    controller.notify(room);
    while (reads.length < 2) await delay(5);
    assert.deepEqual(reads.slice(0, 2), ['kai', 'ada'], 'The other person is read before the author of the commit in flight');
    committing();
  } finally {
    committing(); await controller.close();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
