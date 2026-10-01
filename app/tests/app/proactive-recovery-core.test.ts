import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPARISON_RECOVERY_BATCH, COMPARISON_RESERVATION_STALE_MS, recoverComparisonReservations,
  type ComparisonRecoveryPorts, type ComparisonRecoveryUnitOfWork, type RecoverableComparisonReservation } from '@flux/core';

const now = new Date('2030-01-01T01:00:00Z');
const old = new Date(now.getTime() - COMPARISON_RESERVATION_STALE_MS);
function fixture(rows: RecoverableComparisonReservation[]) {
  const changed: string[] = [];
  const ports: ComparisonRecoveryPorts = {
    async lockStale(cutoff, limit) {
      assert.equal(cutoff.getTime(), old.getTime()); assert.equal(limit, COMPARISON_RECOVERY_BATCH); return rows;
    },
    async notRun(id, cutoff, at) { assert.deepEqual([cutoff, at], [old, now]); changed.push(`free:${id}`); return true; },
    async unknown(id, cutoff, at) { assert.deepEqual([cutoff, at], [old, now]); changed.push(`possible:${id}`); return true; },
  };
  const unit: ComparisonRecoveryUnitOfWork = { run: (action) => action(ports) };
  return { ports, unit, changed };
}

test('recovery distinguishes no dispatch intent from possible spending at the accepted inactivity bound', async () => {
  const f = fixture([{ id: 'before', status: 'reserved', updatedAt: old, dispatchStartedAt: null },
    { id: 'intent', status: 'reserved', updatedAt: old, dispatchStartedAt: old }]);
  assert.deepEqual(await recoverComparisonReservations(f.unit, now), { considered: 2, notRun: 1, unknown: 1 });
  assert.deepEqual(f.changed, ['free:before', 'possible:intent']);
});

test('a fresh or terminal row cannot be released through a misconfigured recovery port', async () => {
  for (const row of [{ status: 'reserved', updatedAt: now }, { status: 'unknown', updatedAt: old }]) {
    const f = fixture([{ ...row, id: 'protected', dispatchStartedAt: null }]);
    await assert.rejects(recoverComparisonReservations(f.unit, now), /locked stale reservation/);
    assert.deepEqual(f.changed, []);
  }
});

test('failed terminal persistence rejects the unit rather than reporting successful recovery', async () => {
  const f = fixture([{ id: 'intent', status: 'reserved', updatedAt: old, dispatchStartedAt: old }]);
  f.ports.unknown = async () => false;
  await assert.rejects(recoverComparisonReservations(f.unit, now), /reservation changed/);
});

test('invalid recovery time never reaches metadata storage', () => {
  const f = fixture([]);
  assert.throws(() => recoverComparisonReservations(f.unit, new Date('invalid')), /valid recovery time/);
});
