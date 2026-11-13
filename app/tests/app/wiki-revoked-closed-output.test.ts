import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import type { EditingContext } from '../../apps/server/src/editing/gate.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { editingRuntime } from '../../apps/server/src/editing/runtime.js';
import { background } from '../../apps/server/src/editing/background.js';
import { wikiController } from '../../apps/server/src/editing/wiki-controller.js';
import { UnauthenticatedError } from '../../apps/server/src/identity/session.js';

type Authority = Parameters<typeof wikiController>[0];

// P1 (v0.2.1): signing out while a wiki editor is open ended the whole API process. The access check refuses the editor's read or cursor
// with UNAUTHENTICATED while its socket is already closing; the "revoked" notice could not be sent (EDITING_OUTPUT_CLOSED), the error left
// the failure path, and nobody awaits a read or a cursor, so Node's default for an unhandled rejection stopped the process, every other
// session with it. The failure path never throws now, and what nobody awaits is reported instead of rejecting.

const room = randomUUID(), workspace = randomUUID(), generation = randomUUID();
const current = { workspaceId: workspace, resourceId: room, generation, sequence: 0, hash: 'h0', savedVersion: 1, savedSequence: 0 };

function deferred<T = void>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A room served by a controlled authority; `refuse` is what the access check does with the named operation. */
async function serve(operation: 'read' | 'cursor', report?: (error: unknown, what: string) => void) {
  const runtime = editingRuntime(); const budget = new EditingOutputBudget();
  const started = deferred(); const refused = deferred();
  const authority: Authority = {
    runtime, queueInput: runtime.queueInput, async submit() { throw new Error('no text is sent'); }, async deliverReceipt() {},
    async deliver(session, _id, _generation, _afterSequence, handoff) {
      if (operation === 'read') { started.resolve(); await refused.promise; return; }
      handoff({ current, canWrite: true, actor: { kind: 'human' as const, id: session.principal.id, name: 'Reader' }, presence: [], updates: [],
        preview: null } as unknown as Parameters<typeof handoff>[0]);
    },
    async handoff(_session, _id, handoff) { handoff(); },
    async cursor() { started.resolve(); await refused.promise; },
    close: runtime.close,
  };
  const controller = wikiController(authority, budget, undefined, report);
  const server = createServer(); const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const id = randomUUID();
  const context: EditingContext = { target: { kind: 'wiki', id: room }, connectionId: randomUUID(),
    session: { principal: { kind: 'human', id }, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 60_000), user: { id, name: 'Ada', email: 'ada@example.test' } } };
  const connected = once(sockets, 'connection');
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
  peer.on('error', () => {}); await once(peer, 'open');
  const [socket] = await connected as [WebSocket];
  controller.accept(socket, context);
  const frames: Record<string, unknown>[] = []; peer.on('message', (data, binary) => { if (!binary) frames.push(JSON.parse(String(data))); });
  const closed = once(peer, 'close') as Promise<[number]>;
  peer.send(JSON.stringify({ type: 'subscribe', generation, afterSequence: 0 }));
  if (operation === 'cursor') {
    while (!frames.some((frame) => frame.type === 'head')) await delay(5);
    peer.send(JSON.stringify({ type: 'cursor', generation, cursor: null }));
  }
  await started.promise;
  return { controller, socket, peer, frames, closed, refuse: () => refused.reject(new UnauthenticatedError()),
    async stop() {
      refused.resolve(); await controller.close(); peer.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
}

/** Everything the process would have died of while `run` and its follow-up work happened. */
async function untilQuiet(run: () => Promise<void>) {
  const unhandled: unknown[] = []; const uncaught: unknown[] = [];
  const onRejection = (reason: unknown) => { unhandled.push(reason); }; const onException = (error: unknown) => { uncaught.push(error); };
  process.on('unhandledRejection', onRejection); process.on('uncaughtException', onException);
  try { await run(); await delay(100); } finally { process.off('unhandledRejection', onRejection); process.off('uncaughtException', onException); }
  return { unhandled, uncaught };
}

for (const operation of ['read', 'cursor'] as const) {
  test(`signing out while the ${operation} is in flight and the editor's socket is already closing does not end the API process`, { timeout: 10_000 }, async () => {
    const reports: unknown[] = [];
    const room = await serve(operation, (error) => reports.push(error));
    try {
      const outcome = await untilQuiet(async () => {
        // The server side of the socket is closing (the page left, or the sign-out closed it) but its close event has not run yet, so
        // the connection is still registered and its output refuses every frame (EDITING_OUTPUT_CLOSED); then the access check refuses.
        room.socket.close(); assert.equal(room.socket.readyState, WebSocket.CLOSING);
        room.refuse();
        await room.closed;
      });
      assert.deepEqual(outcome.unhandled, [], 'No rejection is left unhandled');
      assert.deepEqual(outcome.uncaught, [], 'No exception escapes to the process');
      assert.deepEqual(reports, [], 'A client that left first is expected, not a failure to report');
      assert.equal(room.controller.resources.wikiConnections, 0, 'The connection ended');
      assert.equal(room.controller.resources.wikiReading + room.controller.resources.wikiCursorActive, 0, 'Nothing is left in flight');
      assert.equal(room.controller.externalOutputBytes, 0, 'Its output budget is returned');
    } finally { await room.stop(); }
  });

  test(`signing out while the ${operation} is in flight tells an open editor that access ended and closes it`, { timeout: 10_000 }, async () => {
    const room = await serve(operation);
    try {
      const outcome = await untilQuiet(async () => { room.refuse(); const [code] = await room.closed; assert.equal(code, 1008); });
      assert.deepEqual(outcome, { unhandled: [], uncaught: [] });
      assert.ok(room.frames.some((frame) => frame.type === 'revoked'), 'The editor hears that access ended');
      assert.equal(room.controller.resources.wikiConnections, 0);
    } finally { await room.stop(); }
  });
}

test('background work nobody awaits is reported once and never rejects', async () => {
  const reports: [unknown, string][] = []; const boom = new Error('boom');
  const outcome = await untilQuiet(async () => {
    background(Promise.reject(boom), 'a read', (error, what) => reports.push([error, what]));
    // A reporter that fails itself must not end the process either.
    background(Promise.reject(boom), 'a cursor', () => { throw new Error('the log is down'); });
    background(Promise.resolve(), 'a commit', (error, what) => reports.push([error, what]));
  });
  assert.deepEqual(outcome, { unhandled: [], uncaught: [] });
  assert.deepEqual(reports, [[boom, 'a read']]);
});
