import type { DmKind, DmPerson, PageQuery } from '@flux/contracts';
import type { Principal } from '../principal.js';

/**
 * Ports of the direct-message use cases (issues #107, #46). Core states what it needs; the
 * server implements them with the access policy (`policyDmAccess`), the Drizzle repository in
 * `@flux/db` and `recordEvent`. Nothing in `packages/core/src/direct-messages` imports those.
 */

export type DmAction = 'dm.read' | 'dm.write';

export interface DmRecord {
  id: string;
  workspaceId: string;
  kind: DmKind;
  title: string | null;
  createdBy: string;
  version: number;
  createdAt: Date;
  lastMessageAt: Date | null;
  lastMessageBody: string | null;
  /** Current participants, ordered by when they joined, then by name. */
  participants: DmPerson[];
  /** For a 1:1 DM, both people of the pair (from its pair key), whether or not they still take part. */
  pair: DmPerson[] | null;
}

export interface DmMessageRecord {
  id: string;
  dmId: string;
  authorId: string;
  body: string;
  sequence: number;
  requestFingerprint: string;
  createdAt: Date;
}

/** Adapter over the core access policy (`evaluateDm`, `evaluateWorkspace`, `loadActor`). */
export interface DmAccess {
  /**
   * Throws NotFoundError unless the principal is a current participant who is active in the
   * workspace. `lock` (inside a change) locks the DM, the caller's membership and participant
   * rows until the unit of work commits, so a concurrent leave or removal waits or is seen.
   */
  requireDm(principal: Principal, action: DmAction, dmId: string, options?: { lock?: boolean }): Promise<void>;
  /** Throws NotFoundError unless the principal is active in the workspace. */
  requireWorkspace(principal: Principal, workspaceId: string): Promise<void>;
  /** Throws the policy's 404/403 for `dm.create`, locking the creator's membership. */
  requireCreate(principal: Principal, workspaceId: string): Promise<void>;
  /** Which of these people are active in the workspace now; their memberships are locked. */
  activePeople(workspaceId: string, userIds: string[]): Promise<Set<string>>;
}

export interface NewDm {
  id: string;
  workspaceId: string;
  kind: DmKind;
  pairKey: string | null;
  title: string | null;
  createdBy: string;
  participantIds: string[];
}

export interface NewDmMessage {
  id: string;
  workspaceId: string;
  dmId: string;
  authorId: string;
  clientMessageId: string;
  requestFingerprint: string;
  body: string;
}

/** Rows only; the repository makes no access decisions (the use cases ask {@link DmAccess}). */
export interface DmRepository {
  /** DMs of `workspaceId` that pass the policy's list filter for `principal`, latest activity first. */
  listVisible(principal: Principal, workspaceId: string, page: Required<PageQuery>): Promise<{ items: DmRecord[]; total: number }>;
  /** One DM by id; call only after the access port allowed it. */
  find(id: string): Promise<DmRecord | null>;
  /** Serializes creation of one pair's DM until the transaction ends. */
  lockPair(workspaceId: string, pairKey: string): Promise<void>;
  findPair(workspaceId: string, pairKey: string): Promise<DmRecord | null>;
  insert(dm: NewDm): Promise<DmRecord>;
  /** Adds a participant; false when they already take part. */
  addParticipant(workspaceId: string, dmId: string, userId: string): Promise<boolean>;
  /** Removes a participant; false when they did not take part. */
  removeParticipant(dmId: string, userId: string): Promise<boolean>;
  /** Sets the title (null clears it) and increments the version. */
  rename(dmId: string, title: string | null): Promise<void>;
  /** Increments the version after a participant change. */
  bumpVersion(dmId: string): Promise<void>;
  /** The newest `limit` messages below `beforeSequence` (all when null), in ascending order. */
  window(dmId: string, window: { limit: number; beforeSequence: number | null }): Promise<{ messages: DmMessageRecord[]; hasMoreBefore: boolean }>;
  /** Serializes sends that reuse one client message id before the uniqueness check. */
  lockClientMessage(dmId: string, authorId: string, clientMessageId: string): Promise<void>;
  findMessage(dmId: string, authorId: string, clientMessageId: string): Promise<DmMessageRecord | null>;
  /** Allocates the next sequence of the DM, stores the message and records the activity time. */
  appendMessage(message: NewDmMessage): Promise<DmMessageRecord>;
  /** Display names of these people. */
  names(userIds: string[]): Promise<DmPerson[]>;
}

export type DmEventKind = 'dm.created.v1' | 'dm.message_sent.v1' | 'dm.changed.v1';

/** Records a versioned event for the stream in the unit of work (identifiers only, never content). */
export interface DmEventLog {
  record(principal: Principal, workspaceId: string, kind: DmEventKind, dmId: string, data: Record<string, unknown>): Promise<void>;
}

export interface DmPorts {
  access: DmAccess;
  dms: DmRepository;
  events: DmEventLog;
}

/** Runs `work` in one transaction; on an open transaction (an idempotency scope) it nests in it. */
export interface DmUnitOfWork {
  run<T>(work: (ports: DmPorts) => Promise<T>): Promise<T>;
}
