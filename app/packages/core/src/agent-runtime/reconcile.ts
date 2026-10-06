import { randomUUID } from 'node:crypto';
import type { AgentRuntimeConfig } from './config.js';
import type { AgentRuntimeStore, RuntimeManagerPort, RuntimeSlotRow } from './ports.js';

// The worker's reconciliation of the database's bindings with what each slot holds (F-022 "Backup,
// restore and cleanup", "Stop, sign-out and removal"). It runs at the worker's start, which is what
// makes a restore safe, and then every few seconds:
//
// - a binding marked `releasing` is released in its slot (sign out, delete, confirm /data is empty,
//   supervisor exits); the slot becomes `wiping` and is `ready` again only once a NEW boot id reports
//   an empty /data, so the next owner gets a fresh process with an empty /tmp;
// - a directory without a binding (after a restore, or an owner deleted) is signed out and deleted the
//   same way; a binding whose directory is missing shows *Sign in again*;
// - a slot that cannot confirm an empty /data leaves the pool, and the operator is told;
// - with the operator's idle policy, a binding unused for that many days is released.

export interface ReconcileReport {
  error?: string;
  released: string[];
  /** Released bindings whose CLI sign-out failed or timed out (files deleted anyway; the owner is told). */
  logoutFailed: string[];
  orphans: number;
  signInAgain: string[];
  ready: string[];
  outOfPool: string[];
  idle: number;
}

const STALE_RESERVATION_MS = 2 * 60_000;

export async function reconcileAgentRuntime({ config, store, manager, now = () => new Date(), log = () => undefined }: {
  config: AgentRuntimeConfig; store: AgentRuntimeStore; manager: RuntimeManagerPort; now?: () => Date; log?: (event: Record<string, unknown>) => void;
}): Promise<ReconcileReport> {
  const report: ReconcileReport = { released: [], logoutFailed: [], orphans: 0, signInAgain: [], ready: [], outOfPool: [], idle: 0 };
  if (config.idleDays) {
    for (const binding of await store.idleBindings(new Date(now().getTime() - config.idleDays * 86_400_000))) {
      if (await store.requestRelease({ slot: binding.slot }, 'idle')) report.idle += 1;
    }
  }
  const sightings = await manager.slots();
  if (!sightings.ok) {
    report.error = sightings.code;
    return report;
  }
  const known = new Map((await store.slotsWithBindings()).map((entry) => [entry.slot.slot, entry]));
  const save = async (row: RuntimeSlotRow) => {
    await store.saveSlot(row);
    if (row.state === 'ready') report.ready.push(row.slot);
    if (row.state === 'out_of_pool') { report.outOfPool.push(row.slot); log({ event: 'slot_out_of_pool', slot: row.slot, reason: row.outOfPoolReason }); }
  };
  for (const sighting of sightings.value) {
    const entry = known.get(sighting.slot);
    known.delete(sighting.slot);
    const row: RuntimeSlotRow = entry?.slot ?? { slot: sighting.slot, state: 'unknown', bootId: null, wipeBootId: null, outOfPoolReason: null };
    const binding = entry?.binding ?? null;
    if (!sighting.reachable) {
      if (!entry || row.state === 'ready') await store.saveSlot({ ...row, state: row.state === 'ready' ? 'unknown' : row.state });
      continue;
    }
    const seen: RuntimeSlotRow = { ...row, bootId: sighting.bootId };
    const wiping = (bootId: string): RuntimeSlotRow => ({ ...seen, state: 'wiping', wipeBootId: bootId, outOfPoolReason: null });
    const outOfPool = (reason: RuntimeSlotRow['outOfPoolReason']): RuntimeSlotRow => ({ ...seen, state: 'out_of_pool', wipeBootId: null, outOfPoolReason: reason });

    if (binding?.state === 'releasing') {
      const released = await manager.release(sighting.slot, binding.id);
      if (!released.ok) { log({ event: 'release_pending', slot: sighting.slot, code: released.code }); await store.saveSlot(seen); continue; }
      const slot = released.value.dataEmpty ? wiping(sighting.bootId) : outOfPool('data_not_empty');
      await store.completeRelease(binding.id, slot, released.value.logoutFailed);
      report.released.push(binding.id);
      if (released.value.logoutFailed) report.logoutFailed.push(binding.id);
      if (slot.state === 'out_of_pool') report.outOfPool.push(slot.slot);
      continue;
    }

    const orphans = sighting.bindings.filter((id) => id !== binding?.id);
    if (orphans.length) {
      let dataEmpty = false;
      let failed = false;
      for (const id of orphans) {
        const released = await manager.release(sighting.slot, id);
        if (!released.ok) { failed = true; break; }
        report.orphans += 1;
        dataEmpty = released.value.dataEmpty;
      }
      if (binding && !sighting.bindings.includes(binding.id) && binding.state === 'active') {
        await store.markSignInAgain(binding.id);
        report.signInAgain.push(binding.id);
      }
      if (failed) { await store.saveSlot(seen); continue; }
      if (binding) await save({ ...seen, state: 'held', wipeBootId: null, outOfPoolReason: null });
      else await save(dataEmpty ? wiping(sighting.bootId) : outOfPool('data_not_empty'));
      continue;
    }

    if (binding) {
      if (!sighting.bindings.includes(binding.id)) {
        if (binding.state === 'active') {
          await store.markSignInAgain(binding.id);
          report.signInAgain.push(binding.id);
        } else if (binding.state === 'binding' && await store.dropStaleReservation(binding.id, new Date(now().getTime() - STALE_RESERVATION_MS))) {
          continue;
        }
      }
      await save({ ...seen, state: 'held', wipeBootId: null, outOfPoolReason: null });
      continue;
    }

    if (sighting.other > 0) { await save(outOfPool('data_not_empty')); continue; }
    if (row.state === 'wiping') {
      await save(sighting.bootId !== row.wipeBootId ? { ...seen, state: 'ready', wipeBootId: null } : seen);
    } else if (row.state === 'held') {
      // Its binding is gone (the owner was deleted) and no directory is left: recycle the process
      // before anyone else binds it.
      const recycled = await manager.release(sighting.slot, randomUUID());
      await save(recycled.ok && recycled.value.dataEmpty ? wiping(sighting.bootId) : seen);
    } else if (row.state === 'out_of_pool') {
      // Ready again only after the operator fixed it and the supervisor restarted.
      await save(row.bootId !== sighting.bootId ? { ...seen, state: 'ready', outOfPoolReason: null } : seen);
    } else {
      await save({ ...seen, state: 'ready', wipeBootId: null, outOfPoolReason: null });
    }
  }
  for (const { slot } of known.values()) {
    if (slot.state !== 'out_of_pool') await save({ ...slot, state: 'out_of_pool', wipeBootId: null, outOfPoolReason: 'missing' });
  }
  return report;
}
