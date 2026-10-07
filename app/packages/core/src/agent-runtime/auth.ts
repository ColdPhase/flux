import type { AgentRuntimeClient } from '@flux/contracts';

// Internal server authority. The browser never supplies an operation/boot/binding.
// Session record ID is transient; persistence keeps only its fixed digest.
export type RuntimeAuthKind = 'check' | 'logout' | 'console';
export interface RuntimeAuthActor { ownerUserId: string; sessionId: string }
export interface RuntimeAuthOperation extends RuntimeAuthActor {
  bindingId: string; client: AgentRuntimeClient; operationId: string; revision: number;
  bootId: string; kind: RuntimeAuthKind; leaseEndsAt: Date; hardEndsAt: Date;
}
export interface RuntimeAuthClaim extends RuntimeAuthActor {
  bindingId: string; client: AgentRuntimeClient; kind: RuntimeAuthKind; leaseMs: number; lifetimeMs: number;
  nonce?: { digest: string; expiresAt: Date };
}
export type RuntimeAuthAdmission =
  | { kind: 'claimed'; operation: RuntimeAuthOperation }
  | { kind: 'busy' | 'recovery' | 'superseded' | 'ticket_replayed' };

export const RUNTIME_AUTH_LEASE_MS = 60_000;
export const RUNTIME_AUTH_COMMAND_LIFETIME_MS = 120_000;
export const RUNTIME_AUTH_CONSOLE_LIFETIME_MS = 15 * 60_000;
