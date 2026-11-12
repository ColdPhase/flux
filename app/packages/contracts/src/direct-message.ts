// Direct messages (issue #107): private conversations between people of one workspace,
// independent of projects. The audience is exactly the current participants. Workspace
// owners and admins who are not participants cannot see a DM, its existence or its count.
// Messages reuse the #36 message shape, ordering and `clientMessageId` retry rule.
import type { HumanConversationMessage, MessageReference, UnreadFrom } from './conversation.js';
import type { WorkItem } from './work.js';

export const DMS_PATH = '/api/v1/dms';
export const workspaceDmsPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/dms`;
export const dmPath = (dmId: string) => `${DMS_PATH}/${dmId}`;
export const dmMessagesPath = (dmId: string) => `${dmPath(dmId)}/messages`;
/** `PATCH` edits and `DELETE` removes a message its author wrote (#1006); a root and a reply alike. */
export const dmMessagePath = (dmId: string, messageId: string) => `${dmMessagesPath(dmId)}/${messageId}`;
export const dmLeavePath = (dmId: string) => `${dmPath(dmId)}/leave`;
export const dmThreadPath = (dmId: string, rootId: string) => `${dmPath(dmId)}/threads/${rootId}`;
export const dmRepliesPath = (dmId: string, rootId: string) => `${dmThreadPath(dmId, rootId)}/replies`;
export const dmObservationsPath = (dmId: string) => `${dmPath(dmId)}/observations`;
export const dmReceiptsPath = (dmId: string) => `${dmPath(dmId)}/receipts`;
export const dmReadersPath = (dmId: string) => `${dmReceiptsPath(dmId)}/readers`;
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
  /** Present only when the last message was an answer posted with Show everyone (#842): the list names it ("via Assistant: …"). */
  lastMessageVia?: string;
}

/**
 * A DM message (#536). A root has `threadRootId: null` and counts its private replies; a reply names its
 * root and has no replies of its own. A reply is read only by the DM's current participants.
 */
export type DmMessage = HumanConversationMessage & { threadRootId: string | null; replyCount: number;
  /**
   * `ai_used` is the line "Ada used AI here (Claude)" both people of a DM see when `/ai` is used in it (#842, F-036 AG-4): its
   * `body` is the name of the company that receives the conversation. Absent on a message.
   */
  notice?: 'ai_used' };

/**
 * `POST /api/v1/dms/:dmId/messages` (and a thread reply): the stored message. `answered` (#1249) names the Inbox items this reply answered
 * (`note:<id>`: what its author was asked or mentioned in this conversation), as for a reply in a space thread (#1170, `SentConversationMessage`);
 * `DELETE /api/v1/needs-you/:key` (Undo) brings each back. Absent when the reply answered nothing, and on a retried send.
 */
export type SentDmMessage = DmMessage & { answered?: string[] };

/** A DM with its newest window of ROOT messages, in ascending display order (as #36 conversations). */
export interface Dm extends DmSummary {
  messages: DmMessage[];
  /** Names for participants and for former participants who wrote messages in this window. */
  people: DmPerson[];
  messagePage: { hasMoreBefore: boolean; nextBeforeSequence: number | null; limit: number };
  /** Where the caller left off among the roots (#1246). It may name a message older than this window. */
  unreadFrom?: UnreadFrom;
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
  /** Map thoughts and messages this message cites (#469); the same rules as a project message's references. */
  references?: MessageReference[];
}

/** `GET /api/v1/dms/:dmId/threads/:rootId`: one root and the newest window of its private replies, ascending. */
export interface DmThread {
  root: DmMessage;
  replies: DmMessage[];
  people: DmPerson[];
  messagePage: { hasMoreBefore: boolean; nextBeforeSequence: number | null; limit: number };
  /** Where the caller left off among the replies (#1246). It may name a reply older than this window. */
  unreadFrom?: UnreadFrom;
}

/** `POST /api/v1/dms/:dmId/observations` (#534): the caller saw these messages of this DM. */
export interface ObserveMessagesCommand { messageIds: string[] }
/** `observed` counts only rows written now; a retry answers 0. */
export interface ObserveMessagesResult { observed: number }

/**
 * `POST /api/v1/dms/:dmId/receipts` (#534, #1231): each run lists consecutive messages of one author, at one level
 * (roots, or the replies of one thread), oldest run first. A reader is a CURRENT participant, other than the author, who
 * observed EVERY message of the run. Each reader is placed once, in the NEWEST run they observed whole; `count` is how many
 * readers the run has and `readers` only the `RECEIPT_LIMITS.faces` newest of them (#1231), so an answer never grows with the audience.
 */
export interface MessageReceiptsQuery { runs: string[][] }
/** One reader of a run and when they finished reading it (an ISO time: the last of the run's observations). */
export interface MessageReader extends DmPerson { at: string }
export interface MessageReceiptRun { messageIds: string[]; count: number; readers: MessageReader[] }
export interface MessageReceiptsResult { runs: MessageReceiptRun[] }

/**
 * `POST .../receipts/readers` (#1231): the readers of one run, newest first, a page of `RECEIPT_LIMITS.listPage`. The same `runs` as the
 * receipts request, because a reader belongs to the newest run they read; `run` is the index of the one asked about. `after` is the
 * `next` of the previous page. It is made only when a person opens the list.
 */
export interface MessageReadersQuery { runs: string[][]; run: number; after?: string }
export interface MessageReadersResult { count: number; readers: MessageReader[]; next: string | null }

/** The same receipts for the project's conversation (#534): its roots and the replies of one thread. */
export const projectObservationsPath = (projectId: string) => `/api/v1/projects/${projectId}/observations`;
export const projectReceiptsPath = (projectId: string) => `/api/v1/projects/${projectId}/receipts`;
export const projectReadersPath = (projectId: string) => `${projectReceiptsPath(projectId)}/readers`;

export const RECEIPT_LIMITS = { messagesPerCall: 50, runsPerCall: 20, messagesPerQuery: 200, faces: 3, listPage: 20 } as const;

/** One person who could open the task, and why: they are in its project. Agents are not listed; an agent reads with exactly its owner's rights. */
export interface DmTaskCopyPerson { id: string; name: string; reason: 'project' }

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
  /** Every person who could open the task: its project's people, as the access policy lists them now. */
  audience: DmTaskCopyPerson[];
  /** Opaque; names this exact message version, excerpt, project and audience. */
  token: string;
}
/** `POST /api/v1/dms/:dmId/task-copies`. A mismatching token answers 409 TASK_COPY_CHANGED with a fresh preview. */
export interface DmTaskCopyCommand { messageId: string; excerpt: string; projectId: string; token: string; clientCommandId: string }
/** The task made from the excerpt. It carries no reference into the DM. */
export interface DmTaskCopyResult { task: WorkItem; project: { id: string; name: string } }
