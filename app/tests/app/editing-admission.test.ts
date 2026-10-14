import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditingAdmission } from '../../apps/server/src/editing/admission.js';
import { AdmissionBudget } from '../../apps/server/src/editing/codec/admission-budget.mjs';
import { CAPS } from '../../apps/server/src/editing/codec/caps.mjs';
import { emptyRoom } from '../../apps/server/src/editing/codec/codec.mjs';
import { editingContextCharge } from '../../apps/server/src/editing/context-charge.js';
import { NATIVE_CHECKPOINT_BYTES } from '../../apps/server/src/editing/runtime.js';

const code = (wanted: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === wanted;
test('FIFO input/context charge precedes SQL/hash waits, cold promotion and release/close stay inside common cap', async () => {
  const budget = new AdmissionBudget(); const queue = new EditingAdmission(budget, 100);
  const metadata = editingContextCharge({ sessionId: 's', actorId: 'a', resourceId: 'r' });
  const first = await queue.reserve(new Uint8Array(16), metadata);
  let sql = 0; let hash = 0;
  const second = queue.reserve(new Uint8Array(16), metadata).then((lease) => { sql++; hash++; return lease; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sql, 0); assert.equal(hash, 0); assert.equal(queue.queued, 1);
  assert.equal(budget.bytes, first.amount + 32 + metadata); assert.ok(budget.bytes <= 32 * 1024 * 1024);
  budget.bind(first, emptyRoom('r','g','w'));
  const promoted = await second; assert.equal(sql, 1); assert.equal(hash, 1); assert.ok(!promoted.queued);
  budget.release(first); budget.release(promoted); assert.equal(budget.bytes, 0);
  const occupying = await queue.reserve(new Uint8Array(1), metadata);
  const waiting = queue.reserve(new Uint8Array(1), metadata);
  const rejection = assert.rejects(waiting, code('POOL_CLOSED')); queue.close(); await rejection;
  budget.release(occupying); assert.equal(queue.queued, 0); assert.equal(budget.bytes, 0); assert.equal(budget.leases.size, 0);
  assert.throws(() => queue.reserve(new Uint8Array(0), metadata), code('POOL_CLOSED'));
});
test('queued backing, complete context, finite expiry and overflow refuse before creating uncharged work', async () => {
  const budget = new AdmissionBudget(); const queue = new EditingAdmission(budget, 25);
  assert.throws(() => queue.reserve(new Uint8Array(new ArrayBuffer(64 * 1024 * 1024), 0, 16), 1), code('EXTERNAL_BUFFER_LIMIT'));
  assert.throws(() => editingContextCharge({ hidden: new Uint8Array(new ArrayBuffer(64 * 1024 * 1024), 0, 16) }), code('ADMISSION_METADATA_LIMIT'));
  assert.throws(() => editingContextCharge({ name: 'n'.repeat(65_536) }), code('ADMISSION_METADATA_LIMIT'));
  assert.equal(budget.bytes, 0);
  const active = await queue.reserve(new Uint8Array(16), 1024);
  // Keep the finite expiry test alive while the production deadline itself is unref'ed.
  const keeper = setTimeout(() => undefined, 100);
  try { await assert.rejects(queue.reserve(new Uint8Array(16), 1024), code('ADMISSION_TIMEOUT')); }
  finally { clearTimeout(keeper); queue.close(); budget.release(active); }
  assert.equal(budget.bytes, 0); assert.equal(budget.leases.size, 0);
});

test('future native input waits behind two full leases and is reserved before SQL or allocation resumes', async () => {
  const budget = new AdmissionBudget(); const queue = new EditingAdmission(budget, 100);
  const empty = new Uint8Array(); const first = budget.reservePending(empty); const second = budget.reservePending(empty);
  assert.equal(budget.bytes, 32 * 1024 * 1024);
  let reads = 0; let allocations = 0; let owned: ReturnType<AdmissionBudget['reserveQueued']> | null = null;
  const waiting = queue.reserve(empty, 0, NATIVE_CHECKPOINT_BYTES).then((lease) => {
    owned = lease;
    assert.equal(lease.queued, false);
    assert.equal(lease.amount, 16 * 1024 * 1024 + 2 * NATIVE_CHECKPOINT_BYTES);
    assert.equal(budget.bytes, lease.amount, 'future backing/copy and full state/result precede protected work');
    reads++; allocations++;
    const bytes = new Uint8Array(NATIVE_CHECKPOINT_BYTES); budget.replaceInput(lease, bytes);
    assert.equal(lease.input, bytes); return lease;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([reads, allocations, queue.queued, budget.bytes], [0, 0, 1, 32 * 1024 * 1024]);
    budget.release(first);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([reads, allocations, queue.queued], [0, 0, 1], 'future maximum cannot fit beside the remaining full state');
    budget.release(second);
    const admitted = await waiting; assert.deepEqual([reads, allocations, queue.queued], [1, 1, 0]);
    assert.equal(budget.leases.has(admitted), true); assert.equal(admitted.state, null);
    budget.release(admitted);
  } finally { budget.release(first); budget.release(second); queue.close(); await Promise.allSettled([waiting]); if (owned) budget.release(owned); }
  assert.equal(budget.bytes, 0); assert.equal(budget.leases.size, 0);
});

test('future ceiling is immutable; failed promotion, expiry, close and slot overflow retain exact ownership', async () => {
  const budget = new AdmissionBudget(); const empty = new Uint8Array();
  const first = budget.reservePending(empty); const second = budget.reservePending(empty);
  const lease = budget.reserveQueued(empty, 0, NATIVE_CHECKPOINT_BYTES);
  const before = { ...lease }; const bytes = budget.bytes;
  assert.equal(lease.amount, 0, 'no future encoded input exists in the waiting lease');
  assert.equal(Reflect.set(lease, 'inputCapacity', 1), false);
  assert.equal(Reflect.set(lease, 'inputReservedAmount', 1), false);
  assert.throws(() => budget.reserveQueued(empty, 0, 8 * 1024 * 1024 + 1), code('EXTERNAL_BUFFER_LIMIT'));
  assert.throws(() => budget.promote(lease), code('EXTERNAL_BUFFER_LIMIT'));
  assert.deepEqual({ ...lease }, before); assert.equal(budget.bytes, bytes); assert.ok(budget.leases.has(lease));
  assert.throws(() => budget.replaceInput(lease, new Uint8Array(1)), code('INVALID_ADMISSION_LEASE'));
  assert.throws(() => budget.bind(lease, emptyRoom('r','g','w')), code('INVALID_ADMISSION_LEASE'));
  budget.release(lease);
  const queue = new EditingAdmission(budget, 25); const keeper = setTimeout(() => undefined, 200);
  const rejections: Promise<void>[] = [];
  try {
    await assert.rejects(queue.reserve(empty, 0, NATIVE_CHECKPOINT_BYTES), code('ADMISSION_TIMEOUT'));
    assert.equal(budget.bytes, bytes); assert.equal(budget.leases.size, 2);
    const total = CAPS.workers + CAPS.waitingTasks; assert.equal(total, 10);
    const slots = total - budget.leases.size;
    // Observe each rejection immediately, including if a later reservation throws.
    for (let index = 0; index < slots; index++) {
      rejections.push(assert.rejects(queue.reserve(empty, 0, NATIVE_CHECKPOINT_BYTES), code('POOL_CLOSED')));
    }
    assert.equal(queue.queued, slots); assert.equal(budget.leases.size, total);
    assert.throws(() => queue.reserve(empty, 0, NATIVE_CHECKPOINT_BYTES), code('WORK_QUEUE_LIMIT'));
    queue.close(); await Promise.all(rejections);
    assert.equal(queue.queued, 0); assert.equal(budget.bytes, bytes); assert.equal(budget.leases.size, 2);
  } finally { clearTimeout(keeper); queue.close(); await Promise.allSettled(rejections); budget.release(first); budget.release(second); }
  assert.equal(budget.bytes, 0); assert.equal(budget.leases.size, 0);
});
