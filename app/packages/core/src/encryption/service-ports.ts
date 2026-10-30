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
  secretCheck: string;
  /** The key versions this holder has a confirmation for, covered by `holder_mac` (0130). */
  confirmedVersions: number[];
  /** The key pin under the deployment secret (0130, `pin.ts`); null on a row no server path wrote. */
  pin: string | null;
}
export interface DekWrapRecord { holderId: string; workspaceId: string; keyVersion: number; ephemeralPublic: string; sealedDek: string; confirm: string | null }
export interface KeyVersionRecord { keyVersion: number; commitment: string | null; checkValue: string; pin: string | null }
export interface KeysRecord {
  workspaceId: string;
  name: string;
  currentVersion: number;
  liveVersions: number[];
  rotation: 'none' | 'pending' | 'reencrypting';
  tamperedAt: Date | null;
  /** The pin of the last removal record (0130); null: none. */
  removalHead: string | null;
}
export interface RemovalRecord { seq: number; holderId: string; userId: string | null; publicKey: string; removedVersion: number; pin: string }

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
  insertKeyVersion(row: { workspaceId: string; keyVersion: number; commitment: string | null; checkValue: string; pin: string }): Promise<void>;
  insertHolder(row: HolderRecord): Promise<void>;
  updateHolder(id: string, row: Pick<HolderRecord, 'kdf' | 'publicKey' | 'wrappedPrivate' | 'holderMac' | 'holderMacVersion' | 'secretCheck' | 'confirmedVersions' | 'pin'>): Promise<void>;
  /** A new MAC (and confirmed set) for an unchanged holder: after a confirmation, and at a rotation's start. */
  updateHolderMac(id: string, row: Pick<HolderRecord, 'holderMac' | 'holderMacVersion' | 'confirmedVersions'>): Promise<void>;
  insertDekWrap(row: DekWrapRecord): Promise<void>;
  /** The pinned removal records, by seq (0130). */
  removals(workspaceId: string): Promise<RemovalRecord[]>;
  /** Pins the tombstones without a record (the caller holds the key row FOR UPDATE); 'broken' when the chain does not verify. */
  recordRemovals(workspaceId: string): Promise<number | 'broken'>;
  /** Holders removed since the last finished rotation (S2c): never sealed to. */
  tombstones(workspaceId: string): Promise<{ holderId: string; publicKey: string }[]>;
  /**
   * One stored envelope of a version with its place (a registry field and the row identity), or null when there is
   * none: the second check of a version accepted without a confirmation and without the previous DEK (S2c).
   */
  envelopeSample(workspaceId: string, version: number): Promise<{ field: string; identity: string[]; envelope: string } | null>;
  replaceDekWraps(holderId: string, rows: Omit<DekWrapRecord, 'holderId'>[]): Promise<void>;
  setConfirm(holderId: string, keyVersion: number, confirm: string): Promise<void>;
  upsertUnlock(workspaceId: string, row: Omit<UnlockRow, 'unlockedAt'>): Promise<void>;
  deleteUnlocks(workspaceId: string): Promise<number>;
  dropStaleUnlocks(currentBoot: string, observedAt: Date): Promise<{ workspaceId: string; unlockedBy: string | null }[]>;
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
  /** Sends `workspace-encryption.resume.v1` in the unit of work's transaction (the worker also resumes a rotation). */
  resume(workspaceId: string): Promise<void>;
  /** The rotation's rows (S2c); only the worker's unit of work has them. */
  rotation?: KeyRotationRepository;
}

/** One sealed column value the re-encryption pass found below the current version. */
export interface StaleRow { identity: string[]; values: Record<string, unknown> }
export interface RotationProgressRecord {
  targetVersion: number; step: string; cursor: string[] | null; rowsDone: number; rowsEstimate: number; passes: number; passChanges: number;
}
/** A sealed column as the pass needs it: its registry field and kind. */
export interface RotationColumn { column: string; field: string; kind: 'text' | 'json' | 'digest' }

/**
 * The rows of a key rotation (S2c, `@flux/db` `keyRotationRows`). Tables come from the S2a registry (`SEALED_COLUMNS`),
 * so a table a later slice registers is re-encrypted without a change here.
 */
export interface KeyRotationRepository {
  /** Workspaces whose rotation is pending or running. */
  active(): Promise<string[]>;
  /** The registry's sealed tables in their fixed order, each with its columns. */
  tables(): { table: string; columns: RotationColumn[] }[];
  progress(workspaceId: string, options?: { lock?: boolean }): Promise<RotationProgressRecord | null>;
  /** Starts (or restarts, for n+2) the pass at the first table with an empty cursor. */
  resetProgress(workspaceId: string, targetVersion: number, firstStep: string): Promise<void>;
  saveProgress(workspaceId: string, row: Omit<RotationProgressRecord, 'targetVersion' | 'rowsEstimate'>): Promise<void>;
  /** Rows of the workspace with a sealed value below `current`, after `cursor`, by primary key. */
  /** `skipLocked` (default): a row a writer holds is left to the next pass; false: wait for it (the drain). */
  stalePage(table: string, workspaceId: string, current: number, cursor: string[] | null, limit: number, options?: { skipLocked?: boolean }): Promise<StaleRow[]>;
  lockTimeout(ms: number): Promise<void>;
  /** Writes `next` only where the column still holds `previous` (compare-and-set); false when it changed meanwhile. */
  compareAndSet(table: string, identity: string[], column: string, previous: unknown, next: unknown): Promise<boolean>;
  /** Whether any sealed value or file of the workspace is still below `current` (the finish's last check). */
  anyStale(workspaceId: string, current: number): Promise<boolean>;
  staleFiles(workspaceId: string, current: number, cursor: string | null, limit: number): Promise<{ id: string; keyVersion: number }[]>;
  setFileVersion(fileId: string, from: number, to: number): Promise<boolean>;
  /**
   * The finish, in the caller's transaction that holds `workspace_keys` FOR UPDATE: the wraps, unlock rows and key
   * version rows below `current` go, `live_versions = {current}`, `rotation = 'none'`, the tombstones and the progress.
   */
  finish(workspaceId: string, current: number): Promise<void>;
  /**
   * The first `table.column` anywhere (catalog-driven, not only the registry) where a row of the workspace still holds
   * an envelope of one of `oldVersions`, or null.
   */
  leftover(workspaceId: string, oldVersions: number[]): Promise<string | null>;
  /** Records that the pass cannot finish (`table.column`, no content); true the first time. */
  stall(workspaceId: string, on: string): Promise<boolean>;
  /** Starts version `next`: `current_version`, `live_versions`, `rotation = 'reencrypting'`. */
  advance(workspaceId: string, next: number): Promise<void>;
}

/** One transaction per call; nested in an open one. */
export interface EncryptionUnitOfWork {
  run<T>(work: (ports: EncryptionPorts) => Promise<T>): Promise<T>;
}

/** The workspace as the caller reads it after a command (`getWorkspace` with this process's boot id). */
export type WorkspaceReader = (principal: Principal, workspaceId: string) => Promise<Workspace>;
