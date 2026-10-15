import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WikiTextChunk } from '@flux/contracts';
import { AdmissionBudget } from '../../apps/server/src/editing/codec/admission-budget.mjs';
import { Assemblies, packet } from '../../apps/server/src/editing/codec/assembly.mjs';
import { emptyRoom, stateCharge } from '../../apps/server/src/editing/codec/codec.mjs';

const MiB = 1024 * 1024;
const scope = { workspace: 'w', kind: 'wiki' as const, room: 'r', generation: 'g', actor: 'a', operation: 'text' as const,
  uuid: 'u', replica: 1, parameters: null };
const frame = (index = 0): WikiTextChunk => ({ ...scope, index, count: 1 });

test('unknown SQL state reserves its full charge before asynchronous work; oversized backing never enters it', async () => {
  const budget = new AdmissionBudget(); let sql = 0; let hash = 0;
  const boundary = async (bytes: Uint8Array) => {
    const lease = budget.reservePending(bytes);
    try { sql++; await Promise.resolve(); hash++; } finally { budget.release(lease); }
  };
  await assert.rejects(boundary(new Uint8Array(new ArrayBuffer(64 * MiB), 0, 16)), { code: 'EXTERNAL_BUFFER_LIMIT' });
  assert.deepEqual([sql, hash, budget.bytes, budget.leases.size], [0, 0, 0, 0]);
  const input = new Uint8Array(16); const cold = budget.reservePending(input);
  assert.equal(cold.amount, 16 * MiB + 32);
  assert.throws(() => budget.reservePending(input), { code: 'EXTERNAL_BUFFER_LIMIT' }, 'two unknown full states exceed the unchanged 32MiB cap');
  const current = emptyRoom('r', 'g', 'w'); budget.bind(cold, current);
  assert.equal(cold.amount, 8 * MiB + stateCharge(current) + 32);
  const next = budget.reservePending(input); budget.release(next); budget.release(cold);
  assert.deepEqual([budget.bytes, budget.leases.size], [0, 0]);
});

test('pre-reserved initialization input can bind only within its original capacity and cannot rebind a loaded state', () => {
  const budget = new AdmissionBudget(); const lease = budget.reservePending(new Uint8Array(), 8 * MiB);
  assert.equal(lease.amount, 32 * MiB);
  assert.throws(() => budget.replaceInput(lease, new Uint8Array(new ArrayBuffer(8 * MiB + 1), 0, 1)), { code: 'EXTERNAL_BUFFER_LIMIT' });
  const bytes = new Uint8Array(100); budget.replaceInput(lease, bytes);
  const current = emptyRoom('r', 'g', 'w'); budget.bind(lease, current);
  assert.equal(lease.input, bytes); assert.equal(lease.amount, 8 * MiB + stateCharge(current) + 200);
  assert.throws(() => budget.bind(lease, current), { code: 'INVALID_ADMISSION_LEASE' });
  budget.release(lease); assert.equal(budget.bytes, 0);
});

test('completed input remains charged to its assembly while job capacity is unavailable and exact retry does not allocate another copy', () => {
  const assemblies = new Assemblies(); const input = new Uint8Array(100); const now = 10;
  const encoded = packet(frame(), input); const completed = assemblies.receive('c', encoded, scope, now)!;
  assert.equal(assemblies.bytes, 200, 'retained parts plus contiguous completed copy');
  assert.equal(completed.buffer.byteLength, completed.byteLength, 'completed input pins no larger pool slab');
  const retained = assemblies.pending.get('c') as { parts: ReadonlyMap<number, Uint8Array> };
  for (const bytes of retained.parts.values()) assert.equal(bytes.buffer.byteLength, bytes.byteLength, 'each retained part has exact owned backing');
  const budget = new AdmissionBudget(); const busy = budget.reservePending(new Uint8Array(), 8 * MiB);
  assert.throws(() => budget.reservePending(completed), { code: 'EXTERNAL_BUFFER_LIMIT' });
  const duplicate = assemblies.receive('c', encoded, scope, now + 1);
  assert.equal(duplicate, completed); assert.equal(assemblies.bytes, 200);
  budget.release(busy); const job = budget.reservePending(completed); assemblies.remove('c');
  assert.equal(assemblies.bytes, 0); assert.equal(assemblies.pending.size, 0); assert.equal(job.input, completed);
  budget.release(job); assert.equal(budget.bytes, 0);
  assemblies.receive('expired', encoded, scope, now); assemblies.expire(now + 10_000);
  assert.deepEqual([assemblies.bytes, assemblies.pending.size], [0, 0]);
});
