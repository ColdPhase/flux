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
export type AgentRuntimeReleaseReason = 'owner' | 'operator' | 'idle' | 'purge' | 'bind_failed' | 'auth_recovery';

export interface AgentRuntimeBinding {
  state: AgentRuntimeBindingState;
  /** Uncertain auth needs full cleanup/fresh boot; both clients may need to sign in again. */
  recovery?: true;
  boundAt: string;
  lastUsedAt: string | null;
  /** When the operator's idle policy will release this binding without a run; null without a policy. */
  idleReleaseAt: string | null;
}

/** Every method of `claude auth login`, as the sign-in console offers them (F-022 "Sign-in as in a terminal"). */
export const CLAUDE_CODE_SIGN_IN_METHODS = ['claude_account', 'console', 'sso'] as const;
export type ClaudeCodeSignInMethod = (typeof CLAUDE_CODE_SIGN_IN_METHODS)[number];
export type AgentRuntimeSignInMethod = ClaudeCodeSignInMethod | 'device_code' | 'api_key' | 'access_token';

/**
 * Who pays for a runtime connection's use, from its sign-in status (F-022 "Payer and data"): the
 * owner's Claude plan, their Anthropic Console organization, or not reported. Never shown as zero.
 */
export type AgentRuntimePayer = 'claude_plan' | 'anthropic_console' | 'unknown';

export type AgentRuntimeConnectionState = 'signed_out' | 'signed_in' | 'sign_in_again';

/** The owner's own sign-in to a CLI in their slot: display facts only, never a credential. */
export interface AgentRuntimeConnection {
  state: AgentRuntimeConnectionState;
  /** The console method last used. */
  signInMethod: AgentRuntimeSignInMethod | null;
  /** As the CLI's status reported it (`claude.ai`, `api_key`, … or `unknown`). */
  authMethod: string | null;
  plan: string | null;
  /** Masked, e.g. `a***@example.org`. */
  accountLabel: string | null;
  signedInAt: string | null;
  payer: AgentRuntimePayer | null;
  /** A sign-in to a different account than the previous one, until the owner dismisses it. */
  accountChange: { previousLabel: string | null; at: string } | null;
  /** The last sign-out; `failed`: the CLI's own logout failed, the files were deleted anyway. */
  signOut: { at: string; failed: boolean } | null;
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
  /** The owner's sign-in to each CLI in their slot, or null when there is none. */
  connections: Record<AgentRuntimeClient, AgentRuntimeConnection | null>;
  /** Current durable auth work; display only, never an operation token. */
  auth?: Partial<Record<AgentRuntimeClient, 'checking' | 'signing_in' | 'signing_out'>>;
  /** This command's own settlement, separate from the newer owner view. */
  authCompletion?: { kind: 'check' | 'logout'; disposition: 'accepted' | 'superseded' };
}

// --- The sign-in console (F-022 T4 #279). `POST` the method to get a single-use ticket bound to this
// session, then open the WebSocket at the same path and attach with the ticket. The CLI's own output
// arrives as binary messages; nothing the owner types is stored. There is no field for a token, a
// key, a session or a credential file anywhere in these messages.

export const AGENT_RUNTIME_CONSOLE_PATH = '/api/v1/agent-runtime/console';
/** `POST {client}`: the CLI's own logout, then its files are deleted. */
export const AGENT_RUNTIME_SIGN_OUT_PATH = '/api/v1/agent-runtime/sign-out';
/** `POST {client}`: asks the CLI's own status again (after a closed console or a vendor-side change). */
export const AGENT_RUNTIME_CHECK_PATH = '/api/v1/agent-runtime/check';
/** `POST {client}`: dismisses the account-change notice. */
export const AGENT_RUNTIME_NOTICE_PATH = '/api/v1/agent-runtime/notice';

export const AGENT_RUNTIME_CONSOLE_SIZE = { cols: { min: 20, max: 300 }, rows: { min: 5, max: 120 } } as const;
/** The console ends after this long whatever happens (the supervisor's PTY limit). */
export const AGENT_RUNTIME_CONSOLE_LIFETIME_MS = 15 * 60_000;
/** The most characters one input message may carry (the WebSocket takes messages of at most 1 KiB). */
export const AGENT_RUNTIME_CONSOLE_INPUT_CHARS = 256;

export interface AgentRuntimeConsoleRequest { client: 'claude_code'; method: ClaudeCodeSignInMethod }
export interface AgentRuntimeConsoleTicket { ticket: string; expiresAt: string }
export interface AgentRuntimeClientRequest { client: AgentRuntimeClient }

export type AgentRuntimeConsoleClientMessage =
  | { t: 'attach'; ticket: string; cols: number; rows: number }
  | { t: 'in'; d: string }
  | { t: 'size'; cols: number; rows: number };

/**
 * `starting`: attached, the slot is preparing the command; `running`: the CLI runs in the terminal;
 * `checking`: it ended and its status is being read; `done`: the result, from that status only.
 */
export type AgentRuntimeConsoleServerMessage =
  | { t: 'state'; state: 'starting' | 'running' | 'checking' }
  | { t: 'done'; ended: 'exited' | 'timed_out'; disposition: 'accepted' | 'superseded'; signedIn: boolean; status: AgentRuntimeStatus }
  | { t: 'error'; code: AgentRuntimeConsoleError };

/** `busy`: another sign-in, status or sign-out is using the runtime; `unavailable`: the runtime could not be reached. */
export type AgentRuntimeConsoleError = 'busy' | 'unavailable' | 'refused' | 'ended';

export const AGENT_RUNTIME_ERRORS = {
  off: 'AGENT_RUNTIME_OFF',
  poolFull: 'AGENT_RUNTIME_POOL_FULL',
  unavailable: 'AGENT_RUNTIME_UNAVAILABLE',
  releasing: 'AGENT_RUNTIME_RELEASING',
  clientUnavailable: 'AGENT_RUNTIME_CLIENT_UNAVAILABLE',
  invalidInput: 'AGENT_RUNTIME_INVALID_INPUT',
  authBusy: 'AGENT_RUNTIME_AUTH_BUSY',
  authRecovery: 'AGENT_RUNTIME_AUTH_RECOVERY',
  authSuperseded: 'AGENT_RUNTIME_AUTH_SUPERSEDED',
} as const;
