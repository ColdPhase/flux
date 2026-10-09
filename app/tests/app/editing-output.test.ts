import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { EDITING_LIMITS } from '@flux/contracts';
import { EDITING_OUTPUT_DELIVERIES, EditingOutput, EditingOutputBudget, EditingOutputError } from '../../apps/server/src/editing/output.js';
import { EditingHTTPAdmission } from '../../apps/server/src/editing/http-admission.js';
import { editingMapContextCharge } from '../../apps/server/src/editing/context-charge.js';

const header = { type: 'preview' as const, generation: 'generation', sequence: 1, hash: 'hash' };
function boundary() {
  const sent: (string | Uint8Array)[] = []; const callbacks: ((error?: Error) => void)[] = [];
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0,
    send(bytes: string | Uint8Array, _options: unknown, callback: (error?: Error) => void) { sent.push(bytes); callbacks.push(callback); }, terminate() {} };
  return { socket: socket as unknown as WebSocket, sent, callbacks };
}
function decode(frame: Buffer) {
  const length = frame.readUInt32BE(0); return JSON.parse(frame.subarray(4,4+length).toString('utf8')) as { deliveryId: string; index: number; count: number };
}

test('wire-owned binary and JSON copies stay charged through close until actual send callbacks', () => {
  const f = boundary(); const budget = new EditingOutputBudget(); const output = new EditingOutput(f.socket, budget);
  output.send(header, Buffer.allocUnsafeSlow(100), () => assert.fail('close must not certify ACK'));
  assert.equal(f.sent.length, 1); const frame = f.sent[0] as Uint8Array;
  output.sendJSON({ type: 'presence', name: '😀'.repeat(30) });
  const json = f.sent[1] as string; const wireBytes = frame.byteLength + 2*json.length + Buffer.byteLength(json);
  output.close(); assert.equal(budget.bytes, wireBytes, 'close retains both transport-owned allocations');
  f.callbacks.shift()!(); assert.equal(budget.bytes, 2*json.length + Buffer.byteLength(json));
  f.callbacks.shift()!(); assert.equal(budget.bytes, 0);
  assert.throws(() => output.sendJSON({ type: 'head' }), { code: 'EDITING_OUTPUT_CLOSED' });
});

test('each protected call emits at most one frame, ACK never pumps, and output pressure recovers without an uncharged queue', () => {
  const f = boundary(); const budget = new EditingOutputBudget(); const output = new EditingOutput(f.socket, budget);
  const occupying = budget.reserve(32*1024*1024 - 100);
  assert.throws(() => output.send(header, new Uint8Array(100), () => {}), { code: 'EDITING_OUTPUT_CAPACITY' });
  assert.equal(output.busy, false); assert.equal(f.sent.length, 0); occupying();
  let completed = 0; output.send(header, Buffer.allocUnsafeSlow(2*EDITING_LIMITS.chunkBytes), () => completed++);
  assert.equal(f.sent.length, 1); const first = decode(Buffer.from(f.sent[0] as Uint8Array));
  output.received(first.deliveryId, first.index); assert.equal(f.sent.length, 1, 'an ACK cannot bypass the next SQL authority fence');
  assert.equal(output.pump(), true); assert.equal(f.sent.length, 2); const second = decode(Buffer.from(f.sent[1] as Uint8Array));
  output.received(second.deliveryId, second.index); assert.equal(completed, 1);
  for (const callback of f.callbacks) callback(); output.close(); assert.equal(budget.bytes, 0);
});

test('actual public ws frames respect the finite window and resume only through another protected call', { timeout: 5_000 }, async () => {
  const server = createServer(); const sockets = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: EDITING_LIMITS.frameBytes });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  const connected = once(sockets, 'connection'); const peer = new WebSocket(`ws://127.0.0.1:${address.port}`); await once(peer, 'open');
  const [socket] = await connected as [WebSocket]; const budget = new EditingOutputBudget(); const output = new EditingOutput(socket, budget);
  const frames: Buffer[] = []; peer.on('message', (data) => { assert.ok(Buffer.isBuffer(data)); frames.push(data); });
  const waitCount = async (count: number) => { const until = Date.now()+1000; while (frames.length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 2)); assert.equal(frames.length,count); };
  try {
    output.send(header, Buffer.allocUnsafeSlow(2*1024*1024), () => {}); await waitCount(1);
    let calls = 1; while (output.pump()) calls++;
    await waitCount(calls); assert.ok(calls > 1 && calls < 35); assert.equal(output.canPump, false);
    const first = decode(frames[0]!); output.received(first.deliveryId, first.index);
    await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(frames.length,calls);
    assert.equal(output.pump(),true); await waitCount(calls+1);
  } finally {
    output.close(); const gone = once(socket,'close'); socket.terminate(); peer.terminate(); await gone;
    await new Promise<void>((resolve) => sockets.close(() => resolve())); await new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(budget.bytes,0);
  }
});

test('one shared output budget queues concurrent HTTP responses and charges a valid 200-position parsed input', async () => {
  const budget = new EditingOutputBudget(); const admission = new EditingHTTPAdmission(budget,100);
  const positions = Array.from({ length: 200 }, (_,i) => ({ id: `thought-${i}`, x: i, y: -i, width: 184, height: 72 }));
  const charge = editingMapContextCharge({ generation: 'g', gestureId: 'gesture', leaseId: 'lease', positions });
  assert.ok(charge > 65_536 && charge <= 262_144);
  const first = await admission.admit(1024); let resumed = false;
  const second = admission.admit(1024).then((release) => { resumed = true; return release; });
  assert.equal(admission.queued,1); assert.ok(budget.bytes <=32*1024*1024); await Promise.resolve(); assert.equal(resumed,false);
  first(); const release = await second; release(); admission.close(); assert.equal(budget.bytes,0);
  assert.throws(() => budget.reserve(32*1024*1024+1), EditingOutputError);
});


test('adjustable protected-result reservation transfers only after accounting actual source/text and preserves the cap', () => {
  const budget = new EditingOutputBudget(); const lease = budget.lease(24*1024*1024);
  const sourceAndText = 4096; lease.resize(sourceAndText);
  const wire = budget.reserve(8192); assert.equal(budget.bytes,sourceAndText+8192);
  assert.throws(() => lease.resize(32*1024*1024),{code:'EDITING_OUTPUT_CAPACITY'});
  assert.equal(lease.bytes,sourceAndText); wire(); lease.release(); assert.equal(budget.bytes,0);
  assert.throws(() => lease.resize(1),{code:'EDITING_OUTPUT_CLOSED'});
});


test('JSON payload bytes are reserved before allocation and transfer once to the bounded delivery', () => {
  const f = boundary(); const budget = new EditingOutputBudget(); const output = new EditingOutput(f.socket,budget);
  const occupying = budget.reserve(32*1024*1024-1);
  assert.throws(() => output.sendJSONPayload(header,'{}',()=>{}),{code:'EDITING_OUTPUT_CAPACITY'}); assert.equal(f.sent.length,0); occupying();
  output.sendJSONPayload(header,JSON.stringify({text:'😀'.repeat(100)}),()=>{});
  const frame = decode(Buffer.from(f.sent[0] as Uint8Array)); output.received(frame.deliveryId,frame.index);
  f.callbacks[0]!(); output.close(); assert.equal(budget.bytes,0);
});

test('responses of every admission sharing one budget take their turns in arrival order', async () => {
  const budget = new EditingOutputBudget();
  // The live wiki reads' admission is created (and notified) before the HTTP routes' one.
  const reads = new EditingHTTPAdmission(budget, 1000, 'wiki'); const http = new EditingHTTPAdmission(budget, 1000);
  const occupying = budget.reserve(16 * 1024 * 1024); const order: string[] = [];
  const renewal = http.admit(1024).then((release) => { order.push('enrollment renewal'); return release; });
  const later = [1, 2].map((index) => reads.admit(1024).then((release) => { order.push(`read ${index}`); return release; }));
  occupying();
  const first = await Promise.race([renewal, ...later]); first();
  for (const pending of [renewal, ...later]) (await pending)();
  assert.deepEqual(order, ['enrollment renewal', 'read 1', 'read 2']);
  reads.close(); http.close(); assert.equal(budget.bytes, 0);
});

test('a read batch is an ordered, bounded set of deliveries: frames leave in order and deliveries complete in order', () => {
  const f = boundary(); const budget = new EditingOutputBudget(); const output = new EditingOutput(f.socket, budget);
  const completed: number[] = [];
  output.send({ ...header, sequence: 1 }, Buffer.allocUnsafeSlow(10), () => completed.push(1));
  assert.throws(() => output.send({ ...header, sequence: 2 }, Buffer.allocUnsafeSlow(10), () => {}), { code: 'EDITING_OUTPUT_CAPACITY' },
    'Only the protected call that started a batch may extend it');
  for (let sequence = 2; sequence <= EDITING_OUTPUT_DELIVERIES; sequence++) output.send({ ...header, sequence }, Buffer.allocUnsafeSlow(10), () => completed.push(sequence), true);
  assert.throws(() => output.send({ ...header, sequence: 99 }, Buffer.allocUnsafeSlow(10), () => {}, true), { code: 'EDITING_OUTPUT_CAPACITY' }, 'A batch is bounded');
  assert.equal(f.sent.length, 1, 'Starting a batch sends its first frame; its caller pumps the rest');
  while (output.pump()) { /* the rest of the batch */ }
  const frames = f.sent.map((frame) => decode(Buffer.from(frame as Uint8Array)) as unknown as { deliveryId: string; index: number; sequence: number });
  assert.deepEqual(frames.map((frame) => frame.sequence), Array.from({ length: EDITING_OUTPUT_DELIVERIES }, (_, index) => index + 1));
  output.received(frames[2]!.deliveryId, 0); output.received(frames[1]!.deliveryId, 0);
  assert.deepEqual(completed, [], 'A later acknowledgment waits for the earlier delivery');
  output.received(frames[0]!.deliveryId, 0);
  assert.deepEqual(completed, [1, 2, 3]);
  for (const frame of frames.slice(3)) output.received(frame.deliveryId, 0);
  assert.equal(completed.length, EDITING_OUTPUT_DELIVERIES); assert.equal(output.busy, false);
  for (const callback of f.callbacks) callback(); output.close(); assert.equal(budget.bytes, 0);
});
