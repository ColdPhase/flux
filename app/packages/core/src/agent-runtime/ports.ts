import type { AgentRuntimeBindingState, AgentRuntimeClient, AgentRuntimeConnectionState, AgentRuntimeReleaseReason, AgentRuntimeSignInMethod } from '@flux/contracts';
import type { RuntimeAuthAdmission, RuntimeAuthClaim, RuntimeAuthOperation } from './auth.js';

// Ports of the `runtime` transport's use cases (F-022 AIM-3). The manager port is implemented over the
// manager's HTTP API (@flux/runtime-protocol); the store over PostgreSQL (@flux/db). Every call to the
// manager happens outside a database transaction.

/** One slot as runtime-manager reports it. */
export type RuntimeSlotSighting =
  | { slot: string; reachable: true; bootId: string; bindings: string[]; other: number }
  | { slot: string; reachable: false; error: string };

export type RuntimeCall<T> = { ok: true; value: T } | { ok: false; code: string };

/** What the slot reduced a CLI's own status to (F-022 step 5): display facts, never a credential. */
export interface RuntimeSignInFacts { authMethod: string; plan: string | null; accountLabel: string | null; accountDigest: string | null }
export interface RuntimeClientStatus { signedIn: boolean; facts: RuntimeSignInFacts | null }

export interface RuntimeManagerPort {
  slots(): Promise<RuntimeCall<RuntimeSlotSighting[]>>;
  bind(slot: string, bindingId: string): Promise<RuntimeCall<void>>;
  /** The CLI's own status (`claude auth status`) in the owner's binding directory. */
  status(slot: string, bindingId: string, client: AgentRuntimeClient, bootId: string): Promise<RuntimeCall<RuntimeClientStatus & { bootId: string }>>;
  /** The CLI's own logout; the supervisor deletes that CLI's files whatever its outcome. */
  logout(slot: string, bindingId: string, client: AgentRuntimeClient, bootId: string): Promise<RuntimeCall<{ logout: string; bootId: string }>>;
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

export interface RuntimeConnectionRow {
  client: AgentRuntimeClient;
  bindingId: string;
  state: AgentRuntimeConnectionState;
  signInMethod: AgentRuntimeSignInMethod | null;
  authMethod: string | null;
  plan: string | null;
  accountLabel: string | null;
  signedInAt: Date | null;
  accountChangedAt: Date | null;
  previousAccountLabel: string | null;
  signedOutAt: Date | null;
  signOutFailed: boolean | null;
}

/** A sign-in's outcome as the CLI's status reported it, with the keyed fingerprint of its account. */
export interface RuntimeSignInRecord {
  operation: RuntimeAuthOperation;
  ownerUserId: string;
  bindingId: string;
  client: AgentRuntimeClient;
  /** The console method, or null when only the status was read again. */
  method: AgentRuntimeSignInMethod | null;
  signedIn: boolean;
  facts: { authMethod: string; plan: string | null; accountLabel: string | null } | null;
  fingerprint: string | null;
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
    auth?: { client: AgentRuntimeClient; kind: 'check' | 'logout' | 'console' }[];
}

export interface AgentRuntimeStore {
  claimAuth(input: RuntimeAuthClaim): Promise<RuntimeAuthAdmission>;
  renewAuth(operation: RuntimeAuthOperation, leaseMs: number): Promise<boolean>;
  recoverAuth(operation: RuntimeAuthOperation): Promise<boolean>;
  recoverAbandonedAuth(): Promise<number>;
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
  // The sign-in console (T4).
  /** The owner's live (not revoked) connections. */
  connections(ownerUserId: string): Promise<RuntimeConnectionRow[]>;
  /**
   * Records what the CLI's status reported after a sign-in or a check, on the owner's live binding only.
   * Signed in: the display facts, and the account-change notice when the account differs from the
   * owner's previous one for this CLI. Not signed in: never signed in. False when the binding is no
   * longer the owner's live, active binding (nothing is recorded).
   */
  recordSignIn(record: RuntimeSignInRecord): Promise<boolean>;
  /** Signed out in Flux after the CLI's logout ran; `failed`: the logout itself failed. */
  recordSignOut(operation: RuntimeAuthOperation, failed: boolean): Promise<boolean>;
  dismissAccountNotice(ownerUserId: string, client: AgentRuntimeClient): Promise<void>;
  // The worker's reconciliation.
  slotsWithBindings(): Promise<{ slot: RuntimeSlotRow; binding: RuntimeBindingRow | null }[]>;
  saveSlot(slot: RuntimeSlotRow): Promise<void>;
  markSignInAgain(bindingId: string): Promise<void>;
  /** The binding is released (its connections stay revoked); the slot becomes `wiping` or `out_of_pool`. */
  completeRelease(bindingId: string, slot: RuntimeSlotRow, logoutFailed: boolean): Promise<void>;
  /** Drops a `binding` reservation older than `olderThan` (an interrupted bind). */
  dropStaleReservation(bindingId: string, olderThan: Date): Promise<boolean>;
  idleBindings(before: Date): Promise<RuntimeBindingRow[]>;
}
