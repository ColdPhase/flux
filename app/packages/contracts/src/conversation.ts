import type { SearchTarget } from './search.js';

/** Project conversations and materials are visible only through current project access. */
export const projectConversationsPath = (projectId: string) => `/api/v1/projects/${projectId}/conversations`;
export const conversationPath = (conversationId: string) => `/api/v1/conversations/${conversationId}`;
export const conversationMessagesPath = (conversationId: string) => `${conversationPath(conversationId)}/messages`;
/** Internal app entry; public MCP exposure/version transition remains a separate #400 gate. */
export const taskAgentThreadPath = (workId: string) => `/api/v1/work/${workId}/agent-thread`;
export const projectMaterialsPath = (projectId: string) => `/api/v1/projects/${projectId}/materials`;
export const materialPath = (materialId: string) => `/api/v1/materials/${materialId}`;
export const materialVersionPath = (materialId: string, version: number) => `${materialPath(materialId)}/versions/${version}`;

export interface MaterialSource {
  materialId: string;
  version: number;
}

/**
 * What an explicit native effect contributed to a canonical task thread (#154). Ordinary text carries
 * no marker, so the JSON of every existing message is unchanged. A result contribution names the one
 * canonical result; its finding, evidence and sources come from that result's ordinary authorized API.
 */
export type MessageContribution =
  | { kind: 'blocker' | 'handoff' }
  | { kind: 'result'; resultId: string };

export interface ConversationMessageFields {
  id: string;
  conversationId: string;
  body: string;
  source: MaterialSource | null;
  /** Monotonic per conversation, including concurrent sends. */
  sequence: number;
  createdAt: string;
  /** Present only for a saved blocker, a published result or an explicit public handoff. */
  contribution?: MessageContribution;
  /**
   * Present only when the message has attachments (#154), in the order they were attached. A message with
   * files may have an empty body; it never has neither.
   */
  files?: import('./files.js').MessageFile[];
  /**
   * Present only when the message cites a map thought or another message (#469): one card per reference, in the
   * order they were attached, resolved for the reader who asks. A target the reader cannot open now is an
   * `unavailable` card with no id, title or place, so a reference never reveals what the reader may not read.
   */
  references?: MessageReferenceCard[];
}

/** What a message may cite besides a Wiki version (#469, F-026 §6): a map thought or another message. */
export type MessageReferenceKind = 'thought' | 'message';
export interface MessageReference { kind: MessageReferenceKind; id: string }
/** At most this many references on one message. */
export const MESSAGE_REFERENCE_LIMIT = 4;
/** Where a card opens; the same targets search results open (`targetHref` in the web app). */
export type MessageReferenceTarget = Extract<SearchTarget, { type: 'thought' | 'message' | 'dm_message' }>;
export type MessageReferenceCard =
  | {
    kind: MessageReferenceKind; state: 'available';
    /** The thought's text, or the message's first line, on one line. */
    title: string;
    /** Who wrote it; null when the writer is not known (an agent that was removed). */
    author: string | null;
    /** When it was written or last changed. */
    at: string;
    /** The place it lives in: the project, the sketch or "Direct message". */
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
 */
export interface LinkPreviewCard { url: string; title: string | null; description: string | null }
export interface MessageLinkPreviews { status: 'ready' | 'off' | 'sealed' | 'busy'; cards: LinkPreviewCard[] }
export const messageLinkPreviewsPath = (projectId: string, messageId: string) => `/api/v1/projects/${projectId}/messages/${messageId}/link-previews`;

/** Optional current-project display metadata; never changes a stored author or grants access. */
export type AgentProjectOwner = { kind: 'workspace' } | { kind: 'human'; id: string };

export type MessageIdentity =
  | { authorId: string; author?: never }
  | { authorId: null; author: { kind: 'agent'; id: string; name?: string; projectOwner?: AgentProjectOwner } };
/** Existing human JSON is unchanged; agents never occupy a human account field. */
export type ConversationMessage = ConversationMessageFields & MessageIdentity;
export type HumanConversationMessage = ConversationMessageFields & { authorId: string; author?: never };
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

/** An absent thread is a real empty state; reading/opening it creates no conversation. */
export interface TaskAgentThread {
  task: { id: string; projectId: string; number: number; title: string };
  conversation: Conversation | null;
  messageCount: number;
  canWrite: boolean;
  /** Human writes await the actual shared task-use adapter; agent writes remain guarded or closed. */
  postingAvailable: boolean;
}

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
  /**
   * Present when this root opened a task's discussion (UI116-3): the first genuine contribution to that
   * task, which every later contribution answers. The title is the task's current one. The number is
   * immutable, so its chip names the task as "#12" before the visible reference read answers (#367).
   */
  task?: { workId: string; title: string; number: number };
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
  sourceDraft: { id: string; version: number } | null;
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
  /** Publication copies exactly the selected text, never the whole private draft. */
  sourceDraftId?: string;
  sourceDraftVersion?: number;
}

export interface UpdateMaterialCommand {
  /** UUID reused when retrying this exact edit after a lost response. */
  clientMutationId: string;
  expectedVersion: number;
  title?: string;
  body?: string;
  url?: string | null;
}
