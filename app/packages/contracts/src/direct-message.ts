// Direct messages (issue #107): private conversations between people of one workspace,
// independent of projects. The audience is exactly the current participants. Workspace
// owners and admins who are not participants cannot see a DM, its existence or its count.
// Messages reuse the #36 message shape, ordering and `clientMessageId` retry rule.
import type { HumanConversationMessage } from './conversation.js';
import type { PromotionPerson } from './sketch.js';
import type { WorkItem } from './work.js';

export const DMS_PATH = '/api/v1/dms';
export const workspaceDmsPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/dms`;
export const dmPath = (dmId: string) => `${DMS_PATH}/${dmId}`;
export const dmMessagesPath = (dmId: string) => `${dmPath(dmId)}/messages`;
export const dmLeavePath = (dmId: string) => `${dmPath(dmId)}/leave`;
export const dmThreadPath = (dmId: string, rootId: string) => `${dmPath(dmId)}/threads/${rootId}`;
export const dmRepliesPath = (dmId: string, rootId: string) => `${dmThreadPath(dmId, rootId)}/replies`;
export const dmObservationsPath = (dmId: string) => `${dmPath(dmId)}/observations`;
export const dmReceiptsPath = (dmId: string) => `${dmPath(dmId)}/receipts`;
export const dmTaskCopyPreviewPath = (dmId: string) => `${dmPath(dmId)}/task-copy/preview`;
export const dmTaskCopiesPath = (dmId: string) => `${dmPath(dmId)}/task-copies`;

/** One person in a DM (or a former participant who wrote a message in the returned window). */
export interface DmPerson {
  id: string;
  name: string;
}

export const DM_LIMITS = {
  /** People besides the creator in a new DM: one makes a 1:1, two or more a small group. */
  others: 7,
  title: 80,
} as const;

/** `pair` is the single 1:1 DM of two people in a workspace; `group` is a small group DM. */
export type DmKind = 'pair' | 'group';

export interface DmSummary {
  id: string;
  workspaceId: string;
  kind: DmKind;
  /** Optional name of a group DM; null for 1:1 DMs and unnamed groups. */
  title: string | null;
  /** Current participants, the caller included. They are the whole audience. */
  participants: DmPerson[];
  /**
   * 1:1 DMs: the other person of the pair, even after they left or were removed; null for groups.
   * When they are not among `participants`, nobody receives new messages and sending answers
   * 409 DM_RECIPIENT_LEFT (or DM_RECIPIENT_UNAVAILABLE after a workspace removal).
   */
  counterpart: DmPerson | null;
  audience: { kind: 'dm'; participantIds: string[] };
  createdBy: string;
  /** Changes with the title and the participant set. `ETag` on single-DM responses. */
  version: number;
  createdAt: string;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
}

/**
 * A DM message (#536). A root has `threadRootId: null` and counts its private replies; a reply names its
 * root and has no replies of its own. A reply is read only by the DM's current participants.
 */
export type DmMessage = HumanConversationMessage & { threadRootId: string | null; replyCount: number };

/** A DM with its newest window of ROOT messages, in ascending display order (as #36 conversations). */
export interface Dm extends DmSummary {
  messages: DmMessage[];
  /** Names for participants and for former participants who wrote messages in this window. */
  people: DmPerson[];
  messagePage: { hasMoreBefore: boolean; nextBeforeSequence: number | null; limit: number };
}

/**
 * `POST /api/v1/workspaces/:workspaceId/dms`. `participantIds` names the other people (the
 * caller is always included). One other person opens the existing 1:1 DM of the pair, or
 * creates it (201; an existing one answers 200). If that person left the pair's DM, or is no
 * longer in the workspace, the answer is 409 DM_RECIPIENT_LEFT / DM_RECIPIENT_UNAVAILABLE and
 * nobody is re-added: only they can reopen it, by messaging the caller. Two or more create a new group DM; send an
 * `Idempotency-Key` to make a retry safe.
 */
export interface CreateDmCommand {
  participantIds: string[];
  /** Group DMs only. */
  title?: string;
}

/** `PATCH /api/v1/dms/:dmId`: rename a group DM. Needs `If-Match` or `expectedVersion`. */
export interface UpdateDmCommand {
  title: string | null;
  expectedVersion?: number;
}

/** `POST /api/v1/dms/:dmId/messages`: the #36 SendMessageCommand without a material citation. */
export interface SendDmMessageCommand {
  body: string;
  clientMessageId: string;
}

/** `GET /api/v1/dms/:dmId/threads/:rootId`: one root and the newest window of its private replies, ascending. */
export interface DmThread {
  root: DmMessage;
  replies: DmMessage[];
  people: DmPerson[];
  messagePage: { hasMoreBefore: boolean; nextBeforeSequence: number | null; limit: number };
}

/** `POST /api/v1/dms/:dmId/observations` (#534): the caller saw these messages of this DM. */
export interface ObserveMessagesCommand { messageIds: string[] }
/** `observed` counts only rows written now; a retry answers 0. */
export interface ObserveMessagesResult { observed: number }

/**
 * `POST /api/v1/dms/:dmId/receipts` (#534): each run lists consecutive messages of one author, at one level
 * (roots, or the replies of one thread). `seenBy` is the CURRENT participants, other than the author, who
 * observed EVERY message of the run.
 */
export interface MessageReceiptsQuery { runs: string[][] }
export interface MessageReceiptsResult { runs: { messageIds: string[]; seenBy: DmPerson[] }[] }

export const RECEIPT_LIMITS = { messagesPerCall: 50, runsPerCall: 20, messagesPerQuery: 200 } as const;

/**
 * `POST /api/v1/dms/:dmId/task-copy/preview` (#537). Changes nothing. `excerpt` is the part of the message the
 * person chose (default: the whole message); it must appear in the message exactly. Without `projectId` the
 * first project the caller can change is proposed.
 */
export interface DmTaskCopyPreviewCommand { messageId: string; excerpt?: string; projectId?: string }
export interface DmTaskCopyPreview {
  messageId: string;
  /** Exactly what would be copied. */
  excerpt: string;
  project: { id: string; name: string } | null;
  /** Projects the caller can change. */
  projects: { id: string; name: string }[];
  /** Everyone who could open the task: its project's people, as the access policy lists them now. */
  audience: PromotionPerson[];
  /** Opaque; names this exact message version, excerpt, project and audience. */
  token: string;
}
/** `POST /api/v1/dms/:dmId/task-copies`. A mismatching token answers 409 TASK_COPY_CHANGED with a fresh preview. */
export interface DmTaskCopyCommand { messageId: string; excerpt: string; projectId: string; token: string; clientCommandId: string }
/** The task made from the excerpt. It carries no reference into the DM. */
export interface DmTaskCopyResult { task: WorkItem; project: { id: string; name: string } }
