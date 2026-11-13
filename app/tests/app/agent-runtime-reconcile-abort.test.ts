import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileAgentRuntime, type AgentRuntimeConfig, type AgentRuntimeStore, type RuntimeManagerPort, type RuntimeSlotRow } from '@flux/core';

// The reconciler runs under a session lock (#916). When that lock is lost its signal aborts, and the step in flight finishes, but no
// further write or release is made (#961): each case aborts during one step and checks that the next write does not happen.

const slotRow = (slot: string, state: RuntimeSlotRow['state'] = 'ready'): RuntimeSlotRow => ({ slot, state, bootId: 'boot', outOfPoolReason: null, capacity: 2 });
const sighting = (slot: string, bindings: string[] = []) => ({ slot, reachable: true as const, bootId: 'boot', bindings, other: 0, capacity: 2, running: [] as string[] });

function scene(options: { sightings: ReturnType<typeof sighting>[]; known?: RuntimeSlotRow[]; duringRelease?: () => void; duringSave?: (slot: RuntimeSlotRow) => void }) {
  const writes: string[] = [];
  const store = {
    async recoverAbandonedAuth() { return 0; },
    async modelsDue() { return []; },
    async slotsWithBindings() { return (options.known ?? []).map((slot) => ({ slot, bindings: [] })); },
    async saveSlot(slot: RuntimeSlotRow) { writes.push(`save:${slot.slot}:${slot.state}`); options.duringSave?.(slot); },
  } as unknown as AgentRuntimeStore;
  const manager = {
    async slots() { return { ok: true as const, value: options.sightings }; },
    async release(slot: string, id: string) { writes.push(`release:${slot}:${id}`); options.duringRelease?.(); return { ok: true as const, value: { deleted: true, logoutFailed: false, notInstalled: [] } }; },
  } as unknown as RuntimeManagerPort;
  const controller = new AbortController();
  const lost = new Error('The lock was lost');
  let lostRuns = 0;
  const run = () => reconcileAgentRuntime({ config: {} as AgentRuntimeConfig, store, manager, signal: controller.signal, endLostRuns: async () => { lostRuns += 1; return 0; } });
  return { writes, controller, lost, run, lostRuns: () => lostRuns };
}

test('the lock is lost while an orphaned directory is released: nothing is written after it', async () => {
  const s = scene({ sightings: [sighting('s1', ['orphan'])], duringRelease: () => s.controller.abort(s.lost) });
  await assert.rejects(s.run(), (error) => error === s.lost);
  assert.deepEqual(s.writes, ['release:s1:orphan'], 'the release in flight finished; the slot is not saved after it');
});

test('the lock is lost while a missing slot is taken out of the pool: the next one is not', async () => {
  const s = scene({ sightings: [sighting('s1')], known: [slotRow('s1'), slotRow('m1'), slotRow('m2')],
    duringSave: (slot) => { if (slot.slot === 'm1') s.controller.abort(s.lost); } });
  await assert.rejects(s.run(), (error) => error === s.lost);
  assert.deepEqual(s.writes, ['save:s1:ready', 'save:m1:out_of_pool'], 'm2 stays as it was');
  assert.equal(s.lostRuns(), 0);
});

test('the lock is lost during the last write: the runs of the runtime are not ended', async () => {
  const s = scene({ sightings: [sighting('s1')], known: [slotRow('s1')], duringSave: () => s.controller.abort(s.lost) });
  await assert.rejects(s.run(), (error) => error === s.lost);
  assert.equal(s.lostRuns(), 0, 'ending runs is a step the lock protects, and it was not taken');
});

test('with the lock held the same reconciliation goes through to the end (control)', async () => {
  const s = scene({ sightings: [sighting('s1', ['orphan'])], known: [slotRow('s1'), slotRow('m1')] });
  const report = await s.run();
  assert.deepEqual([report.orphans, report.ready, report.outOfPool, s.lostRuns()], [1, ['s1'], ['m1'], 1]);
});
