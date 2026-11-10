import type { SearchTarget } from './search.js';

/** Project conversations and materials are visible only through current project access. */
export const projectConversationsPath = (projectId: string) => `/api/v1/projects/${projectId}/conversations`;
export const conversationPath = (conversationId: string) => `/api/v1/conversations/${conversationId}`;
export const conversationMessagesPath = (conversationId: string) => `${conversationPath(conversationId)}/messages`;
/** `PATCH` edits and `DELETE` removes a message its author wrote (#1006). */
export const conversationMessagePath = (conversationId: string, messageId: string) => `${conversationMessagesPath(conversationId)}/${messageId}`;
export const projectMaterialsPath = (projectId: string) => `/api/v1/projects/${projectId}/materials`;
export const materialPath = (materialId: string) => `/api/v1/materials/${materialId}`;
export const materialVersionPath = (materialId: string, version: number) => `${materialPath(materialId)}/versions/${version}`;

export interface MaterialSource {
  materialId: string;
  version: number;
}

/**
 * What an explicit native effect contributed to a canonical task thread (#154). Ordinary text carries
 * no marker, so the JSON of every existing message is unchanged.
 */
export interface MessageContribution { kind: 'blocker' | 'handoff' | 'came_of_it' }

export interface ConversationMessageFields {
  id: string;
  conversationId: string;
  body: string;
  source: MaterialSource | null;
  /** Present only when the page this message cited was deleted (#941): `source` is then null and the message says "Page deleted". */
  sourceDeleted?: true;
  /** Monotonic per conversation, including concurrent sends. */
  sequence: number;
  createdAt: string;
  /**
   * Present only when the message was taken back (the assistant's Undo, #68; an agent's owner deleting its line, #938; the author's
   * Delete, #1006): `body` is then a fixed marker, and the message keeps its place.
   */
  removedAt?: string;
  /** Present only when the author changed the words after sending them (#1006): when they last did. The earlier words are not kept. */
  editedAt?: string;
  /**
   * Present only when the author posted an agent's answer with Show everyone (#842, F-036 AG-4), or when a local client posted for them in a
   * space's conversation (LC-2, #1091): the agent's or the client's name at that time, shown as "Ada · via Assistant" or "Ada · via Claude Code".
   * The person stays the author.
   */
  via?: string;
  /** Present only for a saved blocker, a "what came of it" line or an explicit public handoff. */
  contribution?: MessageContribution;
  /**
   * Present only when the message has attachments (#154), in the order they were attached. A message with
   * files may have an empty body; it never has neither.
   */
  files?: import('./files.js').MessageFile[];
  /**
   * Present only when the message cites a map thought (#469): one card per reference, in the
   * order they were attached, resolved for the reader who asks. A target the reader cannot open now is an
   * `unavailable` card with no id, title or place, so a reference never reveals what the reader may not read.
   */
  references?: MessageReferenceCard[];
}

/** What a message may cite besides a Wiki version (#469, F-026 §6): a map thought. (A message was citable too until #867 removed Cite.) */
export type MessageReferenceKind = 'thought';
export interface MessageReference { kind: MessageReferenceKind; id: string }
/** At most this many references on one message. */
export const MESSAGE_REFERENCE_LIMIT = 4;
/** Where a card opens; the same targets search results open (`targetHref` in the web app). */
export type MessageReferenceTarget = Extract<SearchTarget, { type: 'thought' }>;
export type MessageReferenceCard =
  | {
    kind: MessageReferenceKind; state: 'available';
    /** The thought's first line, on one line. */
    title: string;
    /** Who wrote it; null when the writer is not known (an agent that was removed). */
    author: string | null;
    /** When it was written or last changed. */
    at: string;
    /** The place it lives in: the sketch. */
    place: string;
    target: MessageReferenceTarget;
  }
  | { kind: MessageReferenceKind; state: 'unavailable' };

/**
 * The web addresses of a message that get a link card (#469), in order and without repeats: the one rule the reader and the
 * server share, so a card the server returns lands on the address the reader shows. The server reads them from the stored body,
 * never from a request, so no caller can name an address for it to fetch.
 */
export const LINK_URL_SOURCE = String.raw`https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]`;
export const LINK_CARD_LIMIT = 3;
export const LINK_URL_MAX_LENGTH = 2048;
export function messageLinkUrls(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(new RegExp(LINK_URL_SOURCE, 'g'))) {
    if (match[0].length <= LINK_URL_MAX_LENGTH) found.add(match[0]);
    if (found.size === LINK_CARD_LIMIT) break;
  }
  return [...found];
}

/**
 * `GET /api/v1/projects/:projectId/messages/:messageId/link-previews` (#469, F-026 §6): what the page behind each web address
 * of a stored message says about itself, fetched by the Flux server and shown as plain text. Only addresses with something to
 * show are listed; the reader draws the address card for every other one.
 * - `ready`: fetched (or cached) now; `cards` may be empty.
 * - `off`: the operator has not turned link previews on (`FLUX_LINK_PREVIEWS`); no page was fetched.
 * - `sealed`: the workspace is encrypted; no page is ever fetched for it, so none of its addresses leave the server.
 * - `busy`: this person asked for too many fetches lately; retry later.
 * - `agent`: an agent that runs on the server wrote the message (#1136, C-30); no page is fetched for it, since an address it wrote could
 *   carry what it read past the check of its web reads. A person's message, an answer a person posted with Show everyone and a post of the
 *   person's own local client are the person's.
 */
export interface LinkPreviewCard { url: string; title: string | null; description: string | null }
/** `GET /api/v1/projects/:projectId/messages/:messageId/place` (CW-2): the conversation a project message belongs to. */
export const projectMessagePlacePath = (projectId: string, messageId: string) => `/api/v1/projects/${projectId}/messages/${messageId}/place`;
export interface MessagePlace { projectId: string; conversationId: string; messageId: string }

export interface MessageLinkPreviews { status: 'ready' | 'off' | 'sealed' | 'busy' | 'agent'; cards: LinkPreviewCard[] }
export const messageLinkPreviewsPath = (projectId: string, messageId: string) => `/api/v1/projects/${projectId}/messages/${messageId}/link-previews`;

/** Optional current-project display metadata; never changes a stored author or grants access. */
/** The person an agent belongs to (F-036: every agent has one owner). */
export type AgentProjectOwner = { kind: 'human'; id: string };

export type MessageIdentity =
  | { authorId: string; author?: never }
  | { authorId: null; author: { kind: 'agent'; id: string; name?: string; projectOwner?: AgentProjectOwner } };
/** Existing human JSON is unchanged; agents never occupy a human account field. */
export type ConversationMessage = ConversationMessageFields & MessageIdentity;
export type HumanConversationMessage = ConversationMessageFields & { authorId: string; author?: never };
/**
 * `POST /api/v1/conversations/:conversationId/messages`: the stored reply. `answered` (#1170) names the Inbox items this reply answered,
 * as `note:<id>` keys: the questions and mentions of its author in this conversation, read and marked done as Done marks them, so
 * `DELETE /api/v1/needs-you/:key` (Undo) brings each back. It is absent when the reply answered nothing, and on a retried send.
 */
export type SentConversationMessage = ConversationMessage & { answered?: string[] };
export type ConversationIdentity =
  | { createdBy: string; createdByActor?: never }
  | { createdBy: null; createdByActor: { kind: 'agent'; id: string; name?: string } };

export interface ConversationFields {
  id: string;
  projectId: string;
  workspaceId: string;
  audience: { kind: 'project'; projectId: string };
  createdAt: string;
  /** Stable discussion label from the opening message. */
  firstMessageBody: string;
  /** The current canonical task binding, including windows that do not contain its root (#154). */
  task?: { workId: string; title: string };
  messages: ConversationMessage[];
  messagePage: {
    /** True when messages with a lower sequence can be fetched. */
    hasMoreBefore: boolean;
    nextBeforeSequence: number | null;
    limit: number;
  };
}
export type Conversation = ConversationFields & ConversationIdentity;

/** Stable, newest-first window returned in ascending display order. */
export interface ConversationWindowQuery {
  /** 1–100, default 50. */
  limit?: number;
  /** Fetch messages with sequence lower than this cursor. */
  beforeSequence?: number;
}

export interface ConversationSummaryFields {
  id: string;
  projectId: string;
  createdAt: string;
  /** Stable discussion label: the first message, even as newer replies arrive. */
  firstMessageBody: string;
  lastMessageAt: string;
  lastMessageBody: string;
}
export type ConversationSummary = ConversationSummaryFields & ConversationIdentity;

/**
 * One project conversation (UI116-1, 2026-10-02): a chronological stream of roots. A root is the
 * opening message (sequence 1) of a stored conversation; its later messages are that root's
 * one-level thread, read through `GET /api/v1/conversations/:id`.
 */
export const projectConversationRootsPath = (projectId: string) => `/api/v1/projects/${projectId}/conversation-roots`;

export interface ConversationRoot {
  conversationId: string;
  /** The root message, sequence 1, with its true author, time, source and contribution. */
  message: ConversationMessage;
  /** Messages after the root in its thread. */
  replyCount: number;
  lastReplyAt: string | null;
}

/** Stable, newest-first window of roots returned in ascending display order. */
export interface ConversationRootQuery {
  /** 1–100, default 50. */
  limit?: number;
  /** Fetch roots older than this conversation of the same project. */
  before?: string;
}

export interface ConversationRootWindow {
  projectId: string;
  roots: ConversationRoot[];
  rootPage: {
    /** True when older roots can be fetched with `before: nextBefore`. */
    hasMoreBefore: boolean;
    nextBefore: string | null;
    limit: number;
  };
}

/** `PATCH /api/v1/conversations/:conversationId/messages/:messageId` and its direct-message twin (#1006): the new words, 1–100000 characters. */
export interface EditMessageCommand {
  body: string;
}

/** What a message says in place of its words once its author deleted it (#1006); the stream, search and export show this and nothing else. */
export const REMOVED_BY_AUTHOR_BODY = 'Message removed';

export interface SendMessageCommand {
  /** 1–100000 characters, or empty when `attachmentIds` names at least one file. */
  body: string;
  /** UUID generated by the client and reused only for retries of this same send. */
  clientMessageId: string;
  source?: MaterialSource;
  /**
   * Files the sender staged in this project and has not attached elsewhere (#154): at most 10, 20 MiB
   * together, distinct, in the order they appear. A retry of the same send repeats the same list.
   */
  attachmentIds?: string[];
  /**
   * Map thoughts and messages this message cites (#469): at most {@link MESSAGE_REFERENCE_LIMIT}, distinct, each
   * readable by the sender now and in the sender's workspace; any other is 404 REFERENCE_UNAVAILABLE.
   */
  references?: MessageReference[];
}

export interface MaterialVersionFields {
  materialId: string;
  version: number;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
}
/**
 * The person who saved a version. A doc version an agent wrote under a standing grant (#152) names that
 * agent instead; existing human JSON is unchanged and an agent never occupies the human account field.
 */
export type MaterialVersion = MaterialVersionFields & MessageIdentity;

interface MaterialFields {
  /** `doc` for a project doc (#112); edit docs through the doc API. */
  kind: 'material' | 'doc';
  projectId: string;
  workspaceId: string;
  audience: { kind: 'project'; projectId: string };
  createdAt: string;
  updatedAt: string;
}
/** A #36 project material (kind `material`) is always person-written. */
export type Material = MaterialFields & MaterialVersionFields & { authorId: string; author?: never };
/** Any material or doc by ID (`GET /api/v1/materials/:id`): a doc's current version may be agent-written. */
export type MaterialOrDoc = MaterialFields & MaterialVersion;

export interface CreateMaterialCommand {
  /** UUID generated by the client and reused only for retries of this publication. */
  clientMutationId: string;
  title: string;
  body?: string;
  url?: string;
}

export interface UpdateMaterialCommand {
  /** UUID reused when retrying this exact edit after a lost response. */
  clientMutationId: string;
  expectedVersion: number;
  title?: string;
  body?: string;
  url?: string | null;
}
