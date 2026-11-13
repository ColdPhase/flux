import type { AgentColour, DmKind, DmPerson, MessageFile, MessageReference, PageQuery, DmTaskCopyPerson, WorkItem } from '@flux/contracts';
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
  /** The assistant whose answer the last message was posted with Show everyone, for the list's preview ("via Assistant: …"). */
  lastMessageVia?: string | null;
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
  /** Null for a root; a reply names a root of the same DM (#536). */
  threadRootId: string | null;
  /** Replies of a root; always 0 for a reply. */
  replyCount: number;
  /** When the author last changed the words (#1006); null when they never did. */
  editedAt: Date | null;
  /** When the author deleted the message (#1006): `body` is then the fixed marker; null otherwise. */
  removedAt: Date | null;
  /** The agent whose answer the author posted with Show everyone; null for a message they wrote. */
  via: string | null;
  /** That agent's colour (#1232); null when there is none. */
  viaColour?: AgentColour | null;
  /** `ai_used` is the line "used AI here" (#842), whose body names the company that receives the conversation. */
  kind: 'text' | 'ai_used';
  /** The files the message carries, in order (#1438 point 10); absent when it has none. */
  files?: MessageFile[];
  /** How many files it carries; a message with files may have no words. */
  attachmentCount?: number;
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
  threadRootId?: string | null;
  via?: string | null;
  viaColour?: AgentColour | null;
  /** How many files the message carries (#1438 point 10); a message with files may have no words. */
  attachmentCount?: number;
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
  /** One message of this DM, root or reply; null for any other id (including another DM's). */
  message(dmId: string, messageId: string): Promise<DmMessageRecord | null>;
  /** The message `FOR UPDATE` for its author's Edit or Delete (#1006); null for any other id (including another DM's). */
  lockMessage(dmId: string, messageId: string): Promise<DmMessageRecord | null>;
  /** Overwrites the words (sealed in an encrypted workspace) and stamps `editedAt`. */
  editMessage(message: { id: string; workspaceId: string; authorId: string }, body: string): Promise<void>;
  /** Replaces the words with the marker and removes everything that carried them: its citations, its notices and search row. */
  removeMessage(message: { id: string; workspaceId: string; dmId: string; authorId: string }): Promise<void>;
  /** The newest `limit` replies of one root below `beforeSequence` (all when null), ascending. */
  threadWindow(dmId: string, rootId: string, window: { limit: number; beforeSequence: number | null }): Promise<{ messages: DmMessageRecord[]; hasMoreBefore: boolean }>;
  /** Author, sequence and level of the messages of this DM among `ids`; ids of other DMs are absent. */
  messageFacts(dmId: string, ids: string[]): Promise<{ id: string; authorId: string; sequence: number; threadRootId: string | null }[]>;
  /** Messages of one level (the roots when `rootId` is null, else that root's replies) with sequence in [from, to]. */
  levelRange(dmId: string, rootId: string | null, from: number, to: number): Promise<{ id: string; authorId: string }[]>;
  /** Idempotent per message and viewer; returns how many rows were written now. */
  observe(workspaceId: string, dmId: string, viewerId: string, ids: string[]): Promise<number>;
  /** Current participants other than `excludeId` who observed every one of `ids`, with when they finished (the last of their observations). */
  viewersOfAll(dmId: string, ids: string[], excludeId: string): Promise<(DmPerson & { at: Date })[]>;
  /**
   * Where `viewerId` left off at one level (the roots when `rootId` is null, else that root's replies; #1246): the first message by
   * someone else, neither removed nor the "used AI here" line, after the newest message of that level they observed. When they observed none,
   * that is the first message of the level. Null when nothing is unread.
   */
  unreadFrom(dmId: string, viewerId: string, rootId: string | null): Promise<string | null>;
  /** Display names of these people. */
  names(userIds: string[]): Promise<DmPerson[]>;
}

export type DmEventKind = 'dm.created.v1' | 'dm.message_sent.v1' | 'dm.message_edited.v1' | 'dm.message_removed.v1' | 'dm.changed.v1' | 'dm.observed.v1';

/** Records a versioned event for the stream in the unit of work (identifiers only, never content). */
export interface DmEventLog {
  record(principal: Principal, workspaceId: string, kind: DmEventKind, dmId: string, data: Record<string, unknown>): Promise<void>;
}

/**
 * What copying a private message excerpt into a project task needs from the project side (#537). Implemented over
 * the project use cases and the access policy: no second authority.
 */
export interface DmTaskCopy {
  /** Projects the caller may change, sorted by name. */
  targets(principal: Principal, workspaceId: string): Promise<{ id: string; name: string }[]>;
  /** Who can open a task in this project now (the policy's list, per person). Throws like `project.write`. */
  audience(principal: Principal, workspaceId: string, projectId: string): Promise<{ people: DmTaskCopyPerson[]; projectName: string }>;
  /** Locks the rows every change of that audience locks (workspace, then the project), FOR SHARE, until commit. */
  lockDestination(workspaceId: string, projectId: string): Promise<void>;
  /** The project's own task creation, in this unit of work: its checks, retry identity, events and history. */
  createTask(principal: Principal, projectId: string, command: { title: string; outcome: string; clientCommandId: string }): Promise<WorkItem>;
}

/**
 * What a direct message cites (#469): the same rules as a project message's references, decided by the one access policy.
 * The cards a reader sees are made at read time by the server; this port only admits and stores what is cited.
 */
export interface DmReferences {
  /** The sender can read every cited target now, in this workspace; any other is 404 REFERENCE_UNAVAILABLE. */
  assertReadable(principal: Principal, workspaceId: string, references: readonly MessageReference[]): Promise<void>;
  /** Stores the references of the message just appended, in the same transaction. */
  save(messageId: string, workspaceId: string, references: readonly MessageReference[]): Promise<void>;
}

/**
 * A person's reply in a direct message answers what they were asked or mentioned in it (#1249, as #1170 does in a space thread): their
 * unread mention and question notifications of that conversation are read and done. Returns the Inbox keys it took out.
 */
export interface DmInbox {
  answerIn(userId: string, dmId: string): Promise<string[]>;
}

/**
 * The files a direct message carries (#1438 point 10): the same stored files as a space's, staged by their sender in this conversation. Absent
 * where no file is served (an entry point that cannot send them).
 */
export interface DmFiles {
  /**
   * The sender's own ready, unsent files of this conversation, locked, with every check of the rows (the files stay unattached until
   * {@link DmFiles.publish}); anything else is the same unknown file.
   */
  lock(dmId: string, authorId: string, ids: readonly string[]): Promise<MessageFile[]>;
  /** Attaches the locked files to the message just stored, in order, with their videos' posters; returns them as the message carries them. */
  publish(dmId: string, messageId: string, files: readonly MessageFile[], at: Date): Promise<MessageFile[]>;
}

export interface DmPorts {
  inbox?: DmInbox;
  files?: DmFiles;
  access: DmAccess;
  references: DmReferences;
  taskCopy: DmTaskCopy;
  dms: DmRepository;
  events: DmEventLog;
}

/** Runs `work` in one transaction; on an open transaction (an idempotency scope) it nests in it. */
export interface DmUnitOfWork {
  run<T>(work: (ports: DmPorts) => Promise<T>): Promise<T>;
  /** Checks the bytes of the files a new message will carry, before its transaction opens (#154, #1411): no connection is held while they are read. */
  verifyFiles?(authorId: string, ids: readonly string[]): Promise<void>;
}
