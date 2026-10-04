import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { DomainError } from '@flux/core';
import type { LiveCursor, LiveReceipt, WikiTextEnvelope } from '@flux/contracts';
import type { EditingContext } from '../../apps/server/src/editing/gate.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { editingRuntime } from '../../apps/server/src/editing/runtime.js';
import { packet } from '../../apps/server/src/editing/codec/assembly.mjs';
import { wikiController } from '../../apps/server/src/editing/wiki-controller.js';

type Authority = Parameters<typeof wikiController>[0];
type Message = { type: string; code?: string; commandId?: string; retryable?: boolean };
const MiB = 1024 * 1024;
function barrier() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function observed(condition: () => boolean, label: string, milliseconds = 1500) {
  const deadline = performance.now() + milliseconds;
  while (!condition() && performance.now() < deadline) await delay(2);
  assert.ok(condition(), label);
}

/** Actual ws/controller/input and shared output budgets, with controlled authority ports.
 * These finite barriers prove error identity, coalescing and ownership settlement; they do
 * not claim SQL authorization, codec convergence or complete application acceptance. */
async function fixture() {
  const server = createServer();
  const sockets = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 65_536 });
  const runtime = editingRuntime(), budget = new EditingOutputBudget();
  const generation = randomUUID(), workspace = randomUUID(), room = randomUUID(), actor = randomUUID();
  const context: EditingContext = { target: { kind: 'wiki', id: room }, connectionId: randomUUID(),
    session: { principal: { kind: 'human', id: actor }, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
      user: { id: actor, name: 'Controlled Cursor', email: 'controlled-cursor@example.test' } } };
  const cursors: (LiveCursor | null)[] = [], submissions: { envelope: WikiTextEnvelope; bytes: Buffer }[] = [];
  const receipts = new Map<string, LiveReceipt>();
  const gate = barrier(); let permitted = true, refuseText = false, firstAlreadyAuthorized = false;
  const authority: Authority = {
    runtime,
    reserve: runtime.reserve,
    async submit(_session, _id, envelope, bytes, admission) {
      try {
        if (refuseText) throw new DomainError(409, 'CONTROLLED_TEXT_REFUSAL', 'Controlled text refusal');
        submissions.push({ envelope, bytes: Buffer.from(bytes) });
        const receipt: LiveReceipt = { workspaceId: workspace, resourceId: room, generation, sequence: submissions.length,
          hash: 'controlled-confirmed-hash', commandId: envelope.uuid, operation: 'text', fingerprint: 'controlled-fingerprint', changed: true };
        receipts.set(envelope.uuid, receipt); return receipt;
      } finally { runtime.release(admission); }
    },
    async deliverReceipt(_session, _id, commandId, handoff) { handoff(receipts.get(commandId) ?? null); },
    async deliver() {},
    async handoff(_session, _id, handoff) { handoff(); },
    async cursor(_session, _id, _generation, _connection, value) {
      const first = cursors.length === 0; cursors.push(value); await gate.promise;
      if (!permitted && !(first && firstAlreadyAuthorized)) throw new DomainError(403, 'CONTROLLED_CURSOR_ACCESS_ENDED', 'Controlled current access ended');
    },
    close: runtime.close,
  };
  const controller = wikiController(authority, budget), messages: Message[] = [];
  const peaks = { active: 0, pending: 0 };
  sockets.on('connection', socket => controller.accept(socket, context));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
  peer.on('error', () => {});
  peer.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw.toString()) as Message); });
  await once(peer, 'open');
  peer.send(JSON.stringify({ type: 'subscribe', generation, afterSequence: 0 }));
  const cursor = (value: LiveCursor | null) => peer.send(JSON.stringify({ type: 'cursor', generation, cursor: value }));
  const resources = () => {
    const value = controller.resources;
    peaks.active = Math.max(peaks.active, value.wikiCursorActive);
    peaks.pending = Math.max(peaks.pending, value.wikiCursorPending);
    return value;
  };
  const text = (commandId = randomUUID()) => {
    const doc = new Y.Doc(); doc.getText('body').insert(0, 'Actual public Yjs input');
    const bytes = Y.encodeStateAsUpdate(doc);
    const envelope: WikiTextEnvelope = { workspace, kind: 'wiki', room, generation, actor, operation: 'text',
      uuid: commandId, replica: doc.clientID, parameters: null };
    const frame = packet({ ...envelope, count: 1, index: 0 }, bytes); doc.destroy();
    peer.send(frame); return { envelope, bytes };
  };
  return { peer, runtime, budget, controller, messages, cursors, submissions, peaks, resources, cursor, text,
    release: () => gate.release(),
    revokeAfterHeldAuthorized: () => { firstAlreadyAuthorized = true; permitted = false; }, refuseText: () => { refuseText = true; },
    async close() {
      gate.release(); await controller.close(); peer.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(runtime.externalInputBytes, 0); assert.equal(budget.bytes, 0);
    },
  };
}

test('one active and one charged latest cursor never borrow a waiting text intent identity', { timeout: 10_000 }, async () => {
  const f = await fixture(); const held = [f.runtime.reserve(new Uint8Array()), f.runtime.reserve(new Uint8Array())];
  try {
    assert.equal(f.runtime.externalInputBytes, 32 * MiB);
    const input = f.text(); await observed(() => f.resources().assemblyCount === 1, 'Actual completed input waits in charged assembly');
    const assemblyBytes = f.resources().assemblyBytes; assert.equal(assemblyBytes, 2 * input.bytes.byteLength);
    f.cursor({ anchor: 'first', head: 'first' });
    await observed(() => f.resources().wikiCursorActive === 1, 'First cursor reaches actual controlled authority');
    const activeBytes = f.budget.bytes;
    f.cursor({ anchor: 'superseded', head: 'superseded' });
    await observed(() => f.resources().wikiCursorPending === 1, 'Second cursor owns one waiting slot');
    f.cursor({ anchor: 'latest', head: 'latest' });
    // A subsequent invalid cursor is an ordered round-trip fence for processing latest.
    f.peer.send(JSON.stringify({ type: 'cursor', generation: input.envelope.generation, cursor: { anchor: 'invalid' } }));
    await observed(() => f.messages.some(message => message.code === 'INVALID_CURSOR'), 'Actual invalid cursor refusal arrives');
    const refusal = f.messages.find(message => message.code === 'INVALID_CURSOR')!;
    assert.equal(refusal.commandId, undefined); assert.equal(f.resources().wikiCursorPending, 1);
    assert.equal(f.resources().assemblyBytes, assemblyBytes); assert.ok(f.budget.bytes > activeBytes);
    assert.deepEqual(f.cursors, [{ anchor: 'first', head: 'first' }]);
    assert.equal(f.messages.some(message => message.code === 'EDITING_PRESENCE_CAPACITY'), false);
    const pressure = f.budget.reserve(32 * MiB - f.budget.bytes - 1024);
    try {
      f.cursor({ anchor: 'cannot-admit', head: 'cannot-admit' });
      await observed(() => f.messages.some(message => message.code === 'EDITING_OUTPUT_CAPACITY'), 'Shared-budget cursor refusal is observed');
      assert.equal(f.messages.find(message => message.code === 'EDITING_OUTPUT_CAPACITY')!.commandId, undefined);
      assert.equal(f.resources().wikiCursorPending, 1); assert.equal(f.resources().assemblyBytes, assemblyBytes);
    } finally { pressure(); }
    f.release(); await observed(() => f.cursors.length === 2 && f.resources().wikiCursorActive === 0, 'Only latest cursor settles');
    assert.deepEqual(f.cursors[1], { anchor: 'latest', head: 'latest' }); assert.equal(f.resources().wikiCursorPending, 0);
    f.runtime.release(held[0]!); f.runtime.release(held[1]!);
    await observed(() => f.messages.some(message => message.type === 'ack' && message.commandId === input.envelope.uuid), 'Original immutable text receives its actual controller ACK');
    assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0]!.envelope.uuid, input.envelope.uuid);
    assert.deepEqual(f.submissions[0]!.bytes, Buffer.from(input.bytes)); assert.equal(f.resources().assemblyBytes, 0);
    const next = f.text(); await observed(() => f.messages.some(message => message.type === 'ack' && message.commandId === next.envelope.uuid), 'Next text intent succeeds without manufactured retry');
    f.refuseText(); const refused = f.text();
    await observed(() => f.messages.some(message => message.code === 'CONTROLLED_TEXT_REFUSAL'), 'An actual text refusal is observed');
    assert.equal(f.messages.find(message => message.code === 'CONTROLLED_TEXT_REFUSAL')!.commandId, refused.envelope.uuid);
    assert.deepEqual(f.peaks, { active: 1, pending: 1 });
  } finally { for (const lease of held) f.runtime.release(lease); await f.close(); }
});

test('pending cursor expires independently while the active cursor remains owned', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    f.cursor(null); await observed(() => f.resources().wikiCursorActive === 1, 'First cursor is held');
    const activeBytes = f.budget.bytes;
    f.cursor({ anchor: 'expires', head: 'expires' });
    await observed(() => f.resources().wikiCursorPending === 1, 'Waiting cursor is charged');
    assert.ok(f.budget.bytes > activeBytes);
    await observed(() => f.messages.some(message => message.code === 'EDITING_PRESENCE_CAPACITY'), 'Finite five-second pending expiry is observed', 6500);
    assert.equal(f.messages.find(message => message.code === 'EDITING_PRESENCE_CAPACITY')!.commandId, undefined);
    assert.equal(f.resources().wikiCursorPending, 0); assert.equal(f.resources().wikiCursorActive, 1);
    assert.equal(f.budget.bytes, activeBytes); assert.equal(f.cursors.length, 1);
    f.release(); await observed(() => f.resources().wikiCursorActive === 0, 'Active cursor settles before release');
    assert.equal(f.cursors.length, 1);
  } finally { await f.close(); }
});

test('close releases pending cursor but retains the active continuation until settlement', { timeout: 6000 }, async () => {
  const f = await fixture();
  try {
    f.cursor(null); await observed(() => f.resources().wikiCursorActive === 1, 'Active cursor is held');
    f.cursor({ anchor: 'pending', head: 'pending' }); await observed(() => f.resources().wikiCursorPending === 1, 'Pending cursor exists');
    let settled = false; const close = f.controller.close().then(() => { settled = true; });
    await observed(() => f.resources().wikiConnections === 0, 'Close removes the actual connection');
    assert.equal(f.resources().wikiCursorPending, 0); assert.equal(f.resources().wikiCursorActive, 1);
    assert.ok(f.budget.bytes > 0); assert.equal(settled, false);
    f.release(); await close; assert.equal(f.resources().wikiCursorActive, 0); assert.equal(f.budget.bytes, 0);
    assert.equal(f.cursors.length, 1);
  } finally { await f.close(); }
});

test('a coalesced cursor goes through fresh current authority after the held predecessor', { timeout: 6000 }, async () => {
  const f = await fixture();
  try {
    f.cursor(null); await observed(() => f.resources().wikiCursorActive === 1, 'Active cursor is held');
    f.cursor({ anchor: 'latest', head: 'latest' }); await observed(() => f.resources().wikiCursorPending === 1, 'Latest cursor waits');
    // The controlled first callback represents an already-authorized predecessor.
    // The queued successor must invoke authority anew, rather than inherit it.
    f.revokeAfterHeldAuthorized(); f.release();
    await observed(() => f.messages.some(message => message.type === 'revoked'), 'Current authority refusal closes the connection');
    await observed(() => f.resources().wikiCursorActive === 0 && f.resources().wikiConnections === 0, 'Revoked cursor settles without a later publish');
    assert.equal(f.resources().wikiCursorPending, 0); assert.equal(f.cursors.length, 2); assert.equal(f.budget.bytes, 0);
    assert.equal(f.messages.some(message => message.commandId !== undefined), false);
  } finally { await f.close(); }
});
