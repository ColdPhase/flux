// The `runtime` transport as the owner sees it (F-022 AIM-3, T3 #278). The operator switches it on with
// FLUX_AGENT_RUNTIME; each owner binds one slot of a fixed pool. Nothing here names a slot, a binding
// directory or a login: requests carry no body fields, and the session is the owner.

export const AGENT_RUNTIME_CLIENTS = ['claude_code', 'codex'] as const;
export type AgentRuntimeClient = (typeof AGENT_RUNTIME_CLIENTS)[number];

export const AGENT_RUNTIME_PATH = '/api/v1/agent-runtime';
/** `POST` binds a free slot to the caller (idempotent); `DELETE` removes the caller's runtime. */
export const AGENT_RUNTIME_BINDING_PATH = '/api/v1/agent-runtime/binding';

/**
 * `available`: the operator enabled it and this Flux version supports it. `pending`: enabled, but not
 * usable in this version yet (Codex until its hosts and checks land, F-022 T6). `off`: not enabled.
 */
export type AgentRuntimeClientAvailability = 'available' | 'pending' | 'off';

export type AgentRuntimeBindingState = 'binding' | 'active' | 'sign_in_again' | 'releasing';
export type AgentRuntimeReleaseReason = 'owner' | 'operator' | 'idle' | 'purge' | 'bind_failed';

export interface AgentRuntimeBinding {
  state: AgentRuntimeBindingState;
  boundAt: string;
  lastUsedAt: string | null;
  /** When the operator's idle policy will release this binding without a run; null without a policy. */
  idleReleaseAt: string | null;
}

export interface AgentRuntimeStatus {
  /** False when FLUX_AGENT_RUNTIME is empty: Settings says the instance has not enabled it. */
  enabled: boolean;
  clients: Record<AgentRuntimeClient, AgentRuntimeClientAvailability>;
  /** The operator's Anthropic Commercial Terms statement, recorded by Flux and not verified. */
  commercialTerms: { agreedOn: string; recordedAt: string } | null;
  idleReleaseDays: number | null;
  /** `full`: every slot is bound to someone; `server` connections and mode (b) still work. */
  pool: 'off' | 'available' | 'full' | 'starting';
  binding: AgentRuntimeBinding | null;
  /**
   * The caller's last released binding, so they are told when the operator or the idle policy released
   * it, and when a CLI's sign-out failed (the files were deleted; end the session at the vendor).
   */
  lastRelease: { reason: AgentRuntimeReleaseReason; at: string; signOutFailed: boolean } | null;
}

export const AGENT_RUNTIME_ERRORS = {
  off: 'AGENT_RUNTIME_OFF',
  poolFull: 'AGENT_RUNTIME_POOL_FULL',
  unavailable: 'AGENT_RUNTIME_UNAVAILABLE',
  releasing: 'AGENT_RUNTIME_RELEASING',
} as const;
