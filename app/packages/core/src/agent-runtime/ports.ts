import type { AgentRuntimeBindingState, AgentRuntimeReleaseReason } from '@flux/contracts';

// Ports of the `runtime` transport's use cases (F-022 AIM-3). The manager port is implemented over the
// manager's HTTP API (@flux/runtime-protocol); the store over PostgreSQL (@flux/db). Every call to the
// manager happens outside a database transaction.

/** One slot as runtime-manager reports it. */
export type RuntimeSlotSighting =
  | { slot: string; reachable: true; bootId: string; bindings: string[]; other: number }
  | { slot: string; reachable: false; error: string };

export type RuntimeCall<T> = { ok: true; value: T } | { ok: false; code: string };

export interface RuntimeManagerPort {
  slots(): Promise<RuntimeCall<RuntimeSlotSighting[]>>;
  bind(slot: string, bindingId: string): Promise<RuntimeCall<void>>;
  /** Signs out each CLI, deletes the directory, confirms /data is empty; the supervisor then exits. */
  release(slot: string, bindingId: string): Promise<RuntimeCall<{ dataEmpty: boolean; logoutFailed: boolean }>>;
}

export type RuntimeSlotState = 'unknown' | 'ready' | 'held' | 'wiping' | 'out_of_pool';
export type RuntimeOutOfPoolReason = 'data_not_empty' | 'release_failed' | 'missing';

export interface RuntimeSlotRow {
  slot: string;
  state: RuntimeSlotState;
  bootId: string | null;
  wipeBootId: string | null;
  outOfPoolReason: RuntimeOutOfPoolReason | null;
}

export interface RuntimeBindingRow {
  id: string;
  ownerUserId: string;
  slot: string;
  state: AgentRuntimeBindingState;
  createdAt: Date;
  lastUsedAt: Date | null;
  releaseReason: AgentRuntimeReleaseReason | null;
}

export type ReserveOutcome =
  | { kind: 'reserved'; binding: RuntimeBindingRow }
  | { kind: 'existing'; binding: RuntimeBindingRow }
  | { kind: 'full' }
  | { kind: 'starting' };

export interface RuntimeOwnerView {
  binding: RuntimeBindingRow | null;
  lastRelease: { reason: AgentRuntimeReleaseReason; at: Date; signOutFailed: boolean } | null;
  slots: { ready: number; held: number; total: number };
  commercialTerms: { agreedOn: string; recordedAt: Date } | null;
}

export interface AgentRuntimeStore {
  ownerView(ownerUserId: string): Promise<RuntimeOwnerView>;
  /** Atomically gives the owner their live binding, or a new one on a `ready` slot (that slot becomes `held`). */
  reserve(ownerUserId: string, bindingId: string): Promise<ReserveOutcome>;
  /** `binding` or `sign_in_again` → `active` once the supervisor created the directory. */
  activate(bindingId: string): Promise<void>;
  /** A reservation the supervisor refused: the binding is dropped and the slot set aside. */
  abandon(bindingId: string, slot: { state: 'unknown' } | { state: 'out_of_pool'; reason: RuntimeOutOfPoolReason }): Promise<void>;
  /** Marks the owner's (or a slot's) live binding `releasing` and signs its connections out in Flux. */
  requestRelease(target: { ownerUserId: string } | { slot: string }, reason: AgentRuntimeReleaseReason): Promise<RuntimeBindingRow | null>;
  recordCommercialTerms(agreedOn: string): Promise<void>;
  // The worker's reconciliation.
  slotsWithBindings(): Promise<{ slot: RuntimeSlotRow; binding: RuntimeBindingRow | null }[]>;
  /** With `expected` (the state and wipe boot id the caller read) the row is only replaced while it still has them. */
  saveSlot(slot: RuntimeSlotRow, expected?: Pick<RuntimeSlotRow, 'state' | 'wipeBootId'>): Promise<void>;
  markSignInAgain(bindingId: string): Promise<void>;
  /** The binding is released (its connections stay revoked); the slot becomes `wiping` or `out_of_pool`. */
  completeRelease(bindingId: string, slot: RuntimeSlotRow, logoutFailed: boolean): Promise<void>;
  /** Drops a `binding` reservation older than `olderThan` (an interrupted bind). */
  dropStaleReservation(bindingId: string, olderThan: Date): Promise<boolean>;
  idleBindings(before: Date): Promise<RuntimeBindingRow[]>;
}
