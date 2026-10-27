import { createHash } from 'node:crypto';
import type { Transform } from 'node:stream';

/**
 * The seal port of F-030 (Enforcement). `sealFor` returns the identity seal for a workspace that is not sealed and a
 * real seal for an unlocked sealed one; for a locked sealed workspace it throws `WorkspaceLockedError` (423). There is
 * no plaintext fallback. Repositories seal on write and open on read through it (S2a).
 */
export interface WorkspaceSeal {
  readonly sealed: boolean;
  readonly workspaceId: string;
  /** The version new seals use (`workspace_keys.current_version`); 0 for the identity seal. */
  readonly currentVersion: number;
  seal(field: string, identity: readonly string[], value: string): string;
  open(field: string, identity: readonly string[], envelope: string): string;
  /** A stored digest of content: the SHA-256 hex, sealed like any other field (a sealed digest). */
  digest(field: string, identity: readonly string[], bytes: Buffer | string): string;
  /** Whether a stored digest is the SHA-256 of `bytes` (opened and compared in RAM). */
  digestMatches(field: string, identity: readonly string[], stored: string, bytes: Buffer | string): boolean;
  /** The file cipher of one file (the reservation id); null for the identity seal. */
  fileCipher(fileId: string): FileCipher | null;
}

export interface FileCipher {
  /** Streams plaintext into the stored object. */
  encryptor(): Transform;
  /** The plaintext of a stored object, only after its tag verifies. */
  open(object: Buffer): Buffer;
}

export const sha256Hex = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The seal of a workspace that is not sealed: values pass unchanged. Never returned for a sealed workspace. */
export function identitySeal(workspaceId: string): WorkspaceSeal {
  return {
    sealed: false, workspaceId, currentVersion: 0,
    seal: (_field, _identity, value) => value,
    open: (_field, _identity, value) => value,
    digest: (_field, _identity, bytes) => sha256Hex(bytes),
    digestMatches: (_field, _identity, stored, bytes) => stored === sha256Hex(bytes),
    fileCipher: () => null,
  };
}

/** `sealedDigest(seal, field, identity, bytes)`: replaces `createHash('sha256')` at each storage site of content (S2a). */
export const sealedDigest = (seal: WorkspaceSeal, field: string, identity: readonly string[], bytes: Buffer | string) =>
  seal.digest(field, identity, bytes);

/** The password strength estimate (`@zxcvbn-ts/core` in the server); core states only what it needs. */
export interface PasswordEstimator {
  guessesLog10(password: string): number;
}
