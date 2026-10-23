import type { Workspace, WorkspaceRole } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { UnlockRow } from './process-keys.js';
import type { SealStateReader } from './seal-for.js';

/**
 * Ports of the unlock lifecycle use cases (F-030, #655). Core states what it needs; the server implements them with
 * the access policy, `@flux/db` `workspaceEncryptionRows`, `recordEvent` and the queue, and passes them in.
 */
export interface HolderRecord {
  id: string;
  workspaceId: string;
  kind: 'password' | 'recovery';
  userId: string | null;
  kdf: unknown;
  publicKey: string;
  wrappedPrivate: string;
  holderMac: string;
  holderMacVersion: number;
}
export interface DekWrapRecord { holderId: string; workspaceId: string; keyVersion: number; ephemeralPublic: string; sealedDek: string; confirm: string | null }
export interface KeyVersionRecord { keyVersion: number; commitment: string | null; checkValue: string }
export interface KeysRecord {
  workspaceId: string;
  name: string;
  currentVersion: number;
  liveVersions: number[];
  rotation: 'none' | 'pending' | 'reencrypting';
  tamperedAt: Date | null;
}

/** Rows only; no access decision. */
export interface EncryptionRepository extends SealStateReader {
  sealed(workspaceId: string): Promise<boolean>;
  keys(workspaceId: string, options?: { lock?: 'update' | 'share' }): Promise<KeysRecord | null>;
  holders(workspaceId: string): Promise<HolderRecord[]>;
  dekWraps(workspaceId: string): Promise<DekWrapRecord[]>;
  keyVersions(workspaceId: string): Promise<KeyVersionRecord[]>;
  unlocks(workspaceId: string, options?: { lock?: 'update' | 'share' }): Promise<UnlockRow[]>;
  workspaceByCreation(createdBy: string, creationId: string): Promise<{ id: string; name: string } | null>;
  insertSealedWorkspace(row: { id: string; name: string; createdBy: string; creationId: string }): Promise<void>;
  insertKeyVersion(row: { workspaceId: string; keyVersion: number; commitment: string | null; checkValue: string }): Promise<void>;
  insertHolder(row: HolderRecord): Promise<void>;
  updateHolder(id: string, row: Pick<HolderRecord, 'kdf' | 'publicKey' | 'wrappedPrivate' | 'holderMac' | 'holderMacVersion'>): Promise<void>;
  replaceDekWraps(holderId: string, rows: Omit<DekWrapRecord, 'holderId'>[]): Promise<void>;
  setConfirm(holderId: string, keyVersion: number, confirm: string): Promise<void>;
  upsertUnlock(workspaceId: string, row: Omit<UnlockRow, 'unlockedAt'>): Promise<void>;
  deleteUnlocks(workspaceId: string): Promise<number>;
  dropStaleUnlocks(currentBoot: string): Promise<{ workspaceId: string; unlockedBy: string | null }[]>;
  markTampered(workspaceId: string): Promise<boolean>;
  clearTampered(workspaceId: string): Promise<void>;
  reserveAttempt(workspaceId: string, userId: string, limit: number, windowSeconds: number): Promise<{ id: string } | { retryAfterSeconds: number }>;
  releaseAttempt(id: string): Promise<void>;
  grant(workspaceId: string, userId: string, options?: { lock?: boolean }): Promise<{ grantedBy: string; expiresAt: Date } | null>;
  putGrant(workspaceId: string, userId: string, grantedBy: string, seconds: number): Promise<Date>;
  deleteGrant(workspaceId: string, userId: string): Promise<void>;
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  managers(workspaceId: string): Promise<string[]>;
  userName(userId: string): Promise<string | null>;
  insertSecurityNotice(row: { userId: string; workspaceId: string; title: string; eventId: string | null }): Promise<void>;
}

/** The access policy's answers (`workspace.manage_encryption`: a human owner or admin). */
export interface EncryptionAccess {
  /**
   * Throws the non-leaking 404 for a workspace the principal cannot see, and `403 WORKSPACE_ENCRYPTION_ADMIN_REQUIRED`
   * for one they may not manage. With `lock` the membership row is held `FOR SHARE` until the unit of work commits.
   */
  manager(principal: Principal, workspaceId: string, options?: { lock?: boolean }): Promise<{ role: 'owner' | 'admin' }>;
}

export interface EncryptionPorts {
  rows: EncryptionRepository;
  access: EncryptionAccess;
  /** Records one workspace event (ids only); returns its id. */
  event(principal: Principal, workspaceId: string, kind: string, data: Record<string, unknown>): Promise<string>;
  /** Sends `workspace-encryption.resume.v1` in the unit of work's transaction. */
  resume(workspaceId: string): Promise<void>;
}

/** One transaction per call; nested in an open one. */
export interface EncryptionUnitOfWork {
  run<T>(work: (ports: EncryptionPorts) => Promise<T>): Promise<T>;
}

/** The workspace as the caller reads it after a command (`getWorkspace` with this process's boot id). */
export type WorkspaceReader = (principal: Principal, workspaceId: string) => Promise<Workspace>;
