import type { AgentRuntimeConfig } from './config.js';
import type { AgentRuntimeStore, RuntimeManagerPort, RuntimeSlotRow } from './ports.js';

// The worker's reconciliation of the database's bindings with what each runtime holds (F-022 "Backup,
// restore and cleanup", "Stop, sign-out and removal"; #860: a runtime holds everyone's directories). It runs at the
// worker's start, which is what makes a restore safe, and then every few seconds:
//
// - a binding marked `releasing` is released (sign out, end the person's processes, delete their directory);
// - a directory without a binding (after a restore, or an owner deleted) is signed out and deleted the
//   same way; a binding whose directory is missing shows *Sign in again*;
// - a runtime that holds something it should not leaves use, and the operator is told;
// - with the operator's idle policy, a binding unused for that many days is released;
// - each runtime's capacity is recorded: the number of agents that may run at once;
// - a working run the runtime no longer has is ended, so a lost run does not hold a place on the server.

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

export async function reconcileAgentRuntime({ config, store, manager, endLostRuns, now = () => new Date(), log = () => undefined }: {
  config: AgentRuntimeConfig; store: AgentRuntimeStore; manager: RuntimeManagerPort;
  /** Ends the working runs of the runtime that are not among `running`. */
  endLostRuns?: (running: string[]) => Promise<number>;
  now?: () => Date; log?: (event: Record<string, unknown>) => void;
}): Promise<ReconcileReport> {
  const report: ReconcileReport = { released: [], logoutFailed: [], orphans: 0, signInAgain: [], ready: [], outOfPool: [], idle: 0 };
  // Expired/crashed auth commands retain their binding until a full release proves quiescence
  // (no process and no file of that person is left); never steal their lease in place.
  await store.recoverAbandonedAuth();
  if (config.idleDays) {
    for (const binding of await store.idleBindings(new Date(now().getTime() - config.idleDays * 86_400_000))) {
      if (await store.requestRelease({ bindingId: binding.id }, 'idle')) report.idle += 1;
    }
  }
  const sightings = await manager.slots();
  if (!sightings.ok) {
    report.error = sightings.code;
    return report;
  }
  const known = new Map((await store.slotsWithBindings()).map((entry) => [entry.slot.slot, entry]));
  // The sightings were taken before the database was read, so a bind that activated in between is not in
  // them. Before telling an owner to sign in again, look at the runtime once more.
  const stillMissing = async (slot: string, bindingId: string) => {
    const again = await manager.slots();
    const sighted = again.ok ? again.value.find((entry) => entry.slot === slot) : undefined;
    return Boolean(sighted?.reachable && !sighted.bindings.includes(bindingId));
  };
  for (const sighting of sightings.value) {
    const entry = known.get(sighting.slot);
    known.delete(sighting.slot);
    const row: RuntimeSlotRow = entry?.slot ?? { slot: sighting.slot, state: 'unknown', bootId: null, outOfPoolReason: null, capacity: null };
    const bindings = entry?.bindings ?? [];
    if (!sighting.reachable) {
      if (!entry || row.state === 'ready') await store.saveSlot({ ...row, state: row.state === 'ready' ? 'unknown' : row.state });
      continue;
    }
    for (const binding of bindings) {
      if (binding.state !== 'releasing') continue;
      const released = await manager.release(sighting.slot, binding.id);
      if (!released.ok || !released.value.deleted) { log({ event: 'release_pending', slot: sighting.slot, code: released.ok ? 'not_deleted' : released.code }); continue; }
      // A client the runtime found no CLI and no files for counts as "never had a login" only when the durable
      // history agrees (#480); a missing directory or tools volume must not turn a possible login into a confirmation.
      const loginPossible = released.value.notInstalled.length ? await store.loginPossible(binding.id) : [];
      const logoutFailed = released.value.logoutFailed || released.value.notInstalled.some((client) => loginPossible.includes(client));
      await store.completeRelease(binding.id, logoutFailed);
      report.released.push(binding.id);
      if (logoutFailed) report.logoutFailed.push(binding.id);
    }
    for (const id of sighting.bindings.filter((dir) => !bindings.some((binding) => binding.id === dir))) {
      const released = await manager.release(sighting.slot, id);
      if (released.ok && released.value.deleted) report.orphans += 1;
      else log({ event: 'release_pending', slot: sighting.slot, code: released.ok ? 'not_deleted' : released.code });
    }
    for (const binding of bindings) {
      if (sighting.bindings.includes(binding.id)) continue;
      if (binding.state === 'active' && await stillMissing(sighting.slot, binding.id)) {
        await store.markSignInAgain(binding.id);
        report.signInAgain.push(binding.id);
      } else if (binding.state === 'binding') {
        await store.dropStaleReservation(binding.id, new Date(now().getTime() - STALE_RESERVATION_MS));
      }
    }
    const held = sighting.other > 0;
    const seen: RuntimeSlotRow = { ...row, bootId: sighting.bootId, capacity: sighting.capacity,
      state: held ? 'out_of_pool' : 'ready', outOfPoolReason: held ? 'data_not_empty' : null };
    await store.saveSlot(seen);
    if (held) { report.outOfPool.push(seen.slot); log({ event: 'slot_out_of_pool', slot: seen.slot, reason: seen.outOfPoolReason }); } else report.ready.push(seen.slot);
  }
  for (const { slot } of known.values()) {
    if (slot.state === 'out_of_pool') continue;
    await store.saveSlot({ ...slot, state: 'out_of_pool', outOfPoolReason: 'missing' });
    report.outOfPool.push(slot.slot);
    log({ event: 'slot_out_of_pool', slot: slot.slot, reason: 'missing' });
  }
  // Only with every runtime's answer: a runtime that did not answer may still have its runs.
  if (endLostRuns && sightings.value.length && sightings.value.every((entry) => entry.reachable)) {
    const lost = await endLostRuns(sightings.value.flatMap((entry) => (entry.reachable ? entry.running : [])));
    if (lost) log({ event: 'lost_runs_ended', lost });
  }
  return report;
}
