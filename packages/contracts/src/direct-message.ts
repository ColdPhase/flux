// Direct messages (issue #107): private conversations between people of one workspace,
// independent of projects. The audience is exactly the current participants. Workspace
// owners and admins who are not participants cannot see a DM, its existence or its count.
// Messages reuse the #36 message shape, ordering and `clientMessageId` retry rule.
import type { ConversationMessage } from './conversation.js';

export const DMS_PATH = '/api/v1/dms';
export const workspaceDmsPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/dms`;
export const dmPath = (dmId: string) => `${DMS_PATH}/${dmId}`;
export const dmMessagesPath = (dmId: string) => `${dmPath(dmId)}/messages`;
export const dmLeavePath = (dmId: string) => `${dmPath(dmId)}/leave`;

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
  audience: { kind: 'dm'; participantIds: string[] };
  createdBy: string;
  /** Changes with the title and the participant set. `ETag` on single-DM responses. */
  version: number;
  createdAt: string;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
}

/** A DM with its newest message window, in ascending display order (as #36 conversations). */
export interface Dm extends DmSummary {
  messages: ConversationMessage[];
  /** Names for participants and for former participants who wrote messages in this window. */
  people: DmPerson[];
  messagePage: { hasMoreBefore: boolean; nextBeforeSequence: number | null; limit: number };
}

/**
 * `POST /api/v1/workspaces/:workspaceId/dms`. `participantIds` names the other people (the
 * caller is always included). One other person opens the existing 1:1 DM of the pair, or
 * creates it (201; an existing one answers 200). Two or more create a new group DM; send an
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
