import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditingAdmission } from '../../apps/server/src/editing/admission.js';
import { AdmissionBudget } from '../../apps/server/src/editing/codec/admission-budget.mjs';
import { emptyRoom } from '../../apps/server/src/editing/codec/codec.mjs';
import { editingContextCharge } from '../../apps/server/src/editing/context-charge.js';

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
