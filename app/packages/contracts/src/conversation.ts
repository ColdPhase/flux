import { ownerInLabel } from './names.js';
import type { SearchTarget } from './search.js';
import type { AgentColour } from './agents.js';

/** Project conversations and materials are visible only through current project access. */
export const projectConversationsPath = (projectId: string) => `/api/v1/projects/${projectId}/conversations`;
export const conversationPath = (conversationId: string) => `/api/v1/conversations/${conversationId}`;
export const conversationMessagesPath = (conversationId: string) => `${conversationPath(conversationId)}/messages`;
/** `PATCH` edits and `DELETE` removes a message its author wrote (#1006). */
export const conversationMessagePath = (conversationId: string, messageId: string) => `${conversationMessagesPath(conversationId)}/${messageId}`;
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
  /**
   * Present only with `via` when it names an agent, not a local client (#1232): the agent's colour, so every reader sees its Kreska in it. A
   * message with it is read as that agent's answer, "Hubert's Assistant", shown by the person who is its author.
   */
  viaColour?: AgentColour;
  /**
   * Present only on a person's message whose author left the company or was removed from it, and has not come back (founder decision,
   * Hubert, 2026-11-17, #1424): their name, which every reader of the space shows as "Stefan Kowal (removed)" (`removedName`). It is
   * already in the space's history; Restore takes it off, and then they are named as everyone is.
   */
  removedAuthorName?: string;
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
/**
 * Who wrote a message posted "via" something, where only text fits (notifications, search results, what an agent reads; #1232, #1424): an
 * agent's answer its person showed everyone is "Ada's Assistant", the one name it has on the message, and a local client's post stays "Ada ·
 * via Claude Code" (LC-2). `viaAgent`: the message carries the agent's colour (`viaColour`), which only an agent's answer has.
 */
export function viaName(author: string, via?: string | null, viaAgent = false): string {
  if (!via) return author;
  // The person as an agent's label names its owner: first name, or the whole marked name of someone removed (C-56, #1424, train 37 row 33).
  return viaAgent ? `${ownerInLabel(author)}'s ${via}` : `${author} · via ${via}`;
}

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

/** The headings of the block Flux appends to an agent's answer (F-036 AG-8, #918, #954); the block starts at the first of them, after a blank line. */
export const WEB_SOURCES_HEADINGS = ['Searched the web for:', 'Found on the web:', 'Read on the web:', 'Requested, not read:'] as const;

/**
 * Where the block Flux appended to a text starts, or the text's length when it has none: it comes last, after a blank line, and holds only
 * its headings and `- ` lines. What stands there is Flux's list, never the agent's words (a query in it is the model's own, #1156).
 */
export function webSourcesStart(text: string): number {
  let at = text.length;
  for (const heading of WEB_SOURCES_HEADINGS) {
    const start = text.lastIndexOf(`\n\n${heading}\n`);
    if (start >= 0 && start < at && text.slice(start + 2).trimEnd().split('\n')
      .every((line) => line.startsWith('- ') || (WEB_SOURCES_HEADINGS as readonly string[]).includes(line))) at = start;
  }
  return at;
}

/**
 * Why an address the server asked for a run was not read, as the block says it (`webSourcesLine`) and as the reader's list of sources says
 * it, short (founder check, Hubert 2026-11-17). `redirected`: the site sent the request on to the next address, which is listed too, so
 * it is no failure and says only that.
 */
export const WEB_NOT_READ = {
  asked: { says: 'the request was sent; no answer was recorded', short: 'not read · no answer' },
  redirected: { says: 'it sent the request on to another address', short: 'redirected' },
  blocked: { says: 'refused: not a public address', short: 'not read · not public' },
  unreachable: { says: 'not reached', short: 'not read · not reached' },
  timeout: { says: 'took too long', short: 'not read · too slow' },
  status: { says: 'the site answered with an error', short: 'not read · site error' },
  type: { says: 'not a web page or a text page', short: 'not read · not a page' },
  redirects: { says: 'too many redirects', short: 'not read · too many redirects' },
  invalid: { says: 'not a web address', short: 'not read · not an address' },
  empty: { says: 'no text on the page', short: 'not read · empty page' },
} as const;

/** One address of the block: `read` came back, `found` an answer cited it, `asked` was sent and not read (with its short reason). */
export interface WebSourceItem { address: string; state: 'read' | 'found' | 'asked'; reason: string | null }
export interface WebSourceList { queries: string[]; items: WebSourceItem[]; more: number }

/**
 * The block Flux appended to a text (`webSourcesStart`), as the list a reader is shown (founder check, Hubert 2026-11-17): what was
 * searched for, and each address once, in the block's order. A page read wins over the same address cited or asked for; "- and 3 more"
 * lines are counted.
 */
export function webSourceList(block: string): WebSourceList {
  const queries: string[] = [];
  const items = new Map<string, WebSourceItem>();
  let more = 0;
  let section = -1;
  const rank = { read: 2, found: 1, asked: 0 } as const;
  for (const line of block.split('\n')) {
    const heading = (WEB_SOURCES_HEADINGS as readonly string[]).indexOf(line.trim());
    if (heading >= 0) { section = heading; continue; }
    if (!line.startsWith('- ') || section < 0) continue;
    const value = line.slice(2).trim();
    const counted = /^and (\d+) more$/.exec(value);
    if (counted) { more += Number(counted[1]); continue; }
    if (section === 0) { queries.push(value); continue; }
    let address = value;
    let reason: string | null = null;
    if (section === 3) {
      const said = /^(.*\S) \(([^()]*)\)$/.exec(value);
      if (said) {
        address = said[1]!;
        reason = Object.values(WEB_NOT_READ).find((item) => item.says === said[2])?.short ?? 'not read';
      }
    }
    const state = section === 2 ? 'read' : section === 1 ? 'found' : 'asked';
    const before = items.get(address);
    if (!before || rank[state] > rank[before.state]) items.set(address, { address, state, reason: state === 'asked' ? reason : null });
  }
  return { queries, items: [...items.values()], more };
}

/**
 * An address as a short line of the list of sources: its site and the last words of its path ("commons.wikimedia.org › Coffee mugs"),
 * decoded, with `_`, `-` and `+` as spaces, without a file's extension and a wiki's `Category:`-style prefix. Null when it is not a web
 * address (a defanged one, `hxxps://…`, stays as written and is never a link).
 */
export function webSourceLabel(address: string): { site: string; page: string | null } | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const site = url.hostname.replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  let segment = segments.pop() ?? '';
  // `index.php?title=Special:Redirect/file/X`, `/view?id=`: a generic last segment says nothing; a `title` query does.
  if (/^(index|default|view|show|redirect)(\.[a-z]{2,5})?$/i.test(segment)) segment = url.searchParams.get('title')?.split('/').pop() ?? segments.pop() ?? '';
  let page: string;
  try { page = decodeURIComponent(segment); } catch { page = segment; }
  page = page.replace(/^[A-Z][A-Za-z]{2,15}:(?=\S)/, '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { site, page: page || null };
}

/**
 * The web addresses of a message that get a link card (#469), in order and without repeats: the one rule the reader and the
 * server share, so a card the server returns lands on the address the reader shows. The server reads them from the stored body,
 * never from a request, so no caller can name an address for it to fetch. A `*` ends no address: `**https://a.example**` is bold (#1247).
 * An address that Flux's own list under an agent's answer ("Found on the web", #1222) already holds gets no card: each address shows once.
 */
export const LINK_URL_SOURCE = String.raw`https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]*]`;
export const LINK_CARD_LIMIT = 3;
export const LINK_URL_MAX_LENGTH = 2048;
/** An address as it is compared: valid and without its fragment; the text itself when it is not one. */
function comparedAddress(address: string): string {
  try { const url = new URL(address); url.hash = ''; return url.href; } catch { return address; }
}
export function messageLinkUrls(body: string): string[] {
  const at = webSourcesStart(body);
  const listed = new Set(at < body.length ? [...body.slice(at).matchAll(new RegExp(LINK_URL_SOURCE, 'g'))].map((match) => comparedAddress(match[0])) : []);
  const found = new Set<string>();
  for (const match of body.slice(0, at).matchAll(new RegExp(LINK_URL_SOURCE, 'g'))) {
    if (match[0].length <= LINK_URL_MAX_LENGTH && !listed.has(comparedAddress(match[0]))) found.add(match[0]);
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
/**
 * The person an agent belongs to (F-036: every agent has one owner). `removedName` is their name when they left the space's company or were
 * removed from it and have not come back: the agent is then "Planner · Stefan Kowal (removed)'s agent" (`removedName`, `ownerInLabel`;
 * founder decision, Hubert, 2026-11-17, #1424), as their own messages name them.
 */
export type AgentProjectOwner = { kind: 'human'; id: string; removedName?: string };

export type MessageIdentity =
  | { authorId: string; author?: never }
  | { authorId: null; author: { kind: 'agent'; id: string; name?: string; projectOwner?: AgentProjectOwner; colour?: AgentColour } };
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
  | { createdBy: null; createdByActor: { kind: 'agent'; id: string; name?: string; colour?: AgentColour } };

export interface ConversationFields {
  id: string;
  projectId: string;
  workspaceId: string;
  audience: { kind: 'project'; projectId: string };
  createdAt: string;
  /** Stable discussion label from the opening message. */
  firstMessageBody: string;
  /** The current canonical task binding, including windows that do not contain its root (#154), with its number ("#3") so a thread names it. */
  task?: { workId: string; number: number; title: string };
  /** The decision this conversation is the one discussion of (#1424): the thread on its card. */
  decision?: { decisionId: string; title: string };
  messages: ConversationMessage[];
  messagePage: {
    /** True when messages with a lower sequence can be fetched. */
    hasMoreBefore: boolean;
    nextBeforeSequence: number | null;
    limit: number;
  };
  /** Where the caller left off in this conversation (#1246); only a person's own read says it. See {@link UnreadFrom}. */
  unreadFrom?: UnreadFrom;
}
export type Conversation = ConversationFields & ConversationIdentity;

/**
 * Where a person left off in a conversation (#1246), from the messages they observed in it (the viewing receipts of #534, so no other
 * write): the id of the first message by someone else after the newest one they observed, where the "New" divider goes. A conversation they
 * have never opened, with nothing observed, is all new: it names the first message by someone else (a thread's first reply). `null` when
 * they have observed everything up to the newest. A message removed since, and the line "used AI here" of a DM, never count. Absent for a
 * reader that is not a person.
 */
export type UnreadFrom = string | null;

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
  projectId: string;
  workspaceId: string;
  audience: { kind: 'project'; projectId: string };
  createdAt: string;
  updatedAt: string;
}
/**
 * A page by its id (`GET /api/v1/materials/:id`), what a message's citation and a task's source name: every saved source is a Wiki page
 * (#1508, C-71), and its current version may be agent-written (#152). Pages are written through the doc API.
 */
export type MaterialOrDoc = MaterialFields & MaterialVersion;

/**
 * The newest message of each of the spaces asked about (`GET /api/v1/space-previews?projectIds=a,b`, at most 100), for the Spaces list's
 * second line and time, as a direct message's row has them. Task and decision discussions are not part of a space's conversation, so they
 * are not counted; a space with no message yet has no item, and one the caller cannot read is left out as if it did not exist.
 */
export const SPACE_PREVIEWS_PATH = '/api/v1/space-previews';
export const SPACE_PREVIEWS_LIMIT = 100;

export interface SpacePreview {
  projectId: string;
  /** When the message was sent. */
  at: string;
  /** Who wrote it, named as everywhere in that space (an agent by its name, a person who left "… (removed)"); null when no name is known. */
  author: { kind: 'human' | 'agent'; id: string; name: string } | null;
  /** The beginning of its words (at most 300 characters); empty for a message of files alone. */
  body: string;
  /** How many files it carries. */
  files: number;
}

export interface SpacePreviewsResponse { items: SpacePreview[] }
