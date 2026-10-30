import {
  ENCRYPTED_WORKSPACES_PATH, WORKSPACE_ENCRYPTION_EVENTS, WORKSPACE_LOCKED, workspaceLockPath, workspaceRecoveryCodePath, workspaceUnlockGrantsPath, workspaceUnlockPasswordPath, workspaceUnlockPath,
  type CreateEncryptedWorkspaceCommand, type CreateEncryptedWorkspaceResult, type EncryptionStateResult, type GrantUnlockPasswordCommand, type GrantUnlockPasswordResult,
  type LockedWorkspaceRef, type NewRecoveryCodeCommand, type NewRecoveryCodeResult, type SetUnlockPasswordCommand, type UnlockWorkspaceCommand, type Workspace,
  type WorkspaceEncryption,
} from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';

// F-030 encrypted workspaces (#655), slice S3: the interface of an encrypted workspace. The wire types, paths, codes and events are
// `@flux/contracts` `encryption.ts` (S1); every call the interface makes to the routes is in this one module. None of these routes uses
// the Idempotency-Key store (the contract forbids it: a stored request hash would be a fast hash of a password), so none sends the header.
// Nothing here keeps a password or a recovery code: each call takes it and forgets it.

export type { WorkspaceEncryption } from '@flux/contracts';
export { WORKSPACE_LOCKED };

/** A workspace with its encryption state; `encryption` is null for a plain workspace. */
export type EncryptedWorkspace = Workspace;

/** A key rotation as the server reports it (S2c): progress, `stalled`, who the new key opens for and why. */
export type KeyRotation = NonNullable<WorkspaceEncryption['rotation']>;
export type { LockedWorkspaceRef };

const ENCRYPTION_EVENTS: ReadonlySet<string> = new Set(WORKSPACE_ENCRYPTION_EVENTS);
/** Every event that changes what the interface shows of an encrypted workspace: the lock, the passwords and the key. */
export const isEncryptionEvent = (kind: string) => ENCRYPTION_EVENTS.has(kind);

/** The DOM event `request()` raises on `423 WORKSPACE_LOCKED`; the shell answers it by reading the workspaces again. */
export const WORKSPACE_LOCKED_DOM_EVENT = 'flux:workspace-locked';

/** True for the server's refusal of content in a locked encrypted workspace. */
export const isWorkspaceLocked = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 423 && error.code === WORKSPACE_LOCKED;

/** The workspace a `423 WORKSPACE_LOCKED` names, when the body says (`details.workspaceId`). */
export function lockedWorkspaceId(error: unknown): string | null {
  if (!isWorkspaceLocked(error)) return null;
  const details = (error.body as { details?: { workspaceId?: unknown } } | null)?.details;
  return typeof details?.workspaceId === 'string' ? details.workspaceId : null;
}

/**
 * A cross-workspace read names the encrypted workspaces it left out because they are locked here (`lockedWorkspaces`). One the shell
 * still shows as open locked since it was read: the same signal as a `423` tells the shell to read the workspaces again, so its
 * "Waiting to be unlocked" row appears in the sidebar, Home, the Inbox and search. The shell ignores ids it already shows as locked.
 */
export function noteLockedWorkspaces<T>(answer: T): T {
  const locked = (answer as { lockedWorkspaces?: LockedWorkspaceRef[] } | null)?.lockedWorkspaces;
  if (Array.isArray(locked) && typeof window !== 'undefined') {
    for (const space of locked) {
      if (typeof space?.id === 'string') window.dispatchEvent(new CustomEvent(WORKSPACE_LOCKED_DOM_EVENT, { detail: { workspaceId: space.id } }));
    }
  }
  return answer;
}

/** A read of one workspace's content that answers `423` because it locked meanwhile: nothing to list there until it is unlocked. */
export async function unlessLocked<T>(read: Promise<T>, fallback: T): Promise<T> {
  try { return await read; } catch (error) {
    if (isWorkspaceLocked(error)) return fallback;
    throw error;
  }
}

/** `POST /encrypted-workspaces`: one `creationId` per form, so a retry after a lost answer returns the space without a second one or the code. */
export const createEncryptedWorkspace = (name: string, creationId: string, password: string) =>
  request<CreateEncryptedWorkspaceResult>(ENCRYPTED_WORKSPACES_PATH, { method: 'POST', body: { name, creationId, password } satisfies CreateEncryptedWorkspaceCommand });

/** `POST …/unlock`: the person's unlock password, or the recovery code (exactly one). */
export const unlockWorkspace = (workspaceId: string, secret: { password: string } | { recoveryCode: string }) =>
  request<EncryptionStateResult>(workspaceUnlockPath(workspaceId), { method: 'POST', body: secret satisfies UnlockWorkspaceCommand });

/** `POST …/lock`: "Lock now". */
export const lockWorkspace = (workspaceId: string) => request<EncryptionStateResult>(workspaceLockPath(workspaceId), { method: 'POST' });

/** `POST …/unlock-password-grants`: a holder, with their own unlock password, lets another owner or admin set a first one (valid one hour). */
export const grantUnlockPassword = (workspaceId: string, userId: string, password: string) =>
  request<GrantUnlockPasswordResult>(workspaceUnlockGrantsPath(workspaceId), { method: 'POST', body: { userId, password } satisfies GrantUnlockPasswordCommand });

/** `PUT …/unlock-password`: changing needs `currentPassword` or `recoveryCode`; a first password needs a grant or `recoveryCode`. */
export const setUnlockPassword = (workspaceId: string, body: SetUnlockPasswordCommand) =>
  request<unknown>(workspaceUnlockPasswordPath(workspaceId), { method: 'PUT', body });

/** `POST …/recovery-code`: an owner, with their own unlock password, makes a new code; the old one stops working. */
export const newRecoveryCode = (workspaceId: string, password: string) =>
  request<NewRecoveryCodeResult>(workspaceRecoveryCodePath(workspaceId), { method: 'POST', body: { password } satisfies NewRecoveryCodeCommand });

/** A calm sentence for a refused encryption call; never the server's own message, and never an echo of what was typed. */
export function encryptionProblem(error: unknown, context: { workspace: string; who?: string }): string {
  if (error instanceof NetworkError) return 'Flux can’t be reached right now. Nothing changed; try again in a moment.';
  if (!(error instanceof ApiError)) return 'That didn’t work. Nothing changed; try again.';
  switch (error.code) {
    case 'UNLOCK_INCORRECT':
      return `That password doesn’t unlock ${context.workspace}.`;
    case 'UNLOCK_RATE_LIMITED':
      return 'Too many tries. Try again in 15 minutes.';
    case 'PASSWORD_TOO_WEAK':
      return 'Use at least 20 characters that are hard to guess, for example the six words suggested.';
    case 'ENCRYPTION_TAMPERED':
      return `${context.workspace}’s encryption keys were changed outside Flux. It stays locked.`;
    case 'NO_UNLOCK_PASSWORD':
      return `You don’t have an unlock password for ${context.workspace} yet. Another owner or admin can unlock it, or you can use the recovery code.`;
    case 'UNLOCK_PASSWORD_GRANT_REQUIRED':
      return 'Another owner or admin has to let you set your first unlock password, or you can use the recovery code.';
    case 'ALREADY_HAS_PASSWORD':
      return `${context.who ?? 'They'} already ${context.who ? 'has' : 'have'} an unlock password.`;
    case 'LAST_UNLOCK_PASSWORD':
      return `${context.workspace} needs at least one unlock password. Ask another owner or admin to set theirs first.`;
    case 'UNLOCK_GRANT_FORBIDDEN':
      return 'Only an owner or admin with an unlock password can let someone else set one.';
    case 'CURRENT_PASSWORD_REQUIRED':
      return 'Enter your current unlock password, or use the recovery code.';
    case 'ENCRYPTION_CHANGED':
      return `${context.workspace}’s keys changed just now. Try again.`;
    case 'OWNER_REQUIRED':
      return 'Only an owner can make a new recovery code.';
    case 'WORKSPACE_NOT_ENCRYPTED':
      return `${context.workspace} isn’t encrypted.`;
    case 'WORKSPACE_ENCRYPTION_ADMIN_REQUIRED':
      return `Only owners and admins of ${context.workspace} can do this.`;
    case 'KEYRING_UNAVAILABLE':
      return 'Encrypted spaces aren’t available on this server right now: its key service isn’t running. Its operator needs to start it.';
    case 'SWAP_UNSAFE':
      return 'This server can write memory to disk. Its operator needs to turn off swap or confirm it is encrypted.';
    case 'UNLOCK_BUSY':
      return 'Many people are unlocking at once. Try again in a moment.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'This form was already used for another name. Close it and start a new space.';
    case WORKSPACE_LOCKED:
      return `${context.workspace} is waiting to be unlocked.`;
    default:
      if (error.status === 403) return `Only owners and admins of ${context.workspace} can do this.`;
      if (error.status === 429) return 'Too many tries. Try again in 15 minutes.';
      if (error.status === 503) return 'This server can’t do that right now. Try again in a moment.';
      return 'That didn’t work. Nothing changed; try again.';
  }
}

/** True when this holder's error means the typed password was refused (the field is cleared and focused again). */
export const isWrongPassword = (error: unknown) => error instanceof ApiError && error.code === 'UNLOCK_INCORRECT';
