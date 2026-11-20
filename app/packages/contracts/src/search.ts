/**
 * Search across Flux (issue #114, foundation 8.12).
 *
 * One query over project names, project and direct messages, docs and materials and every version of them, work,
 * decisions, sketches and their thoughts and people. Every result, snippet and the `next`
 * cursor come only from objects the caller may read at the moment of the request: the server
 * applies the access policy inside the SQL before ranking, limiting and highlighting.
 */
import { decisionAppPath, type WorkStatus } from './work.js';

import type { LockedWorkspaceRef } from './encryption.js';

export const SEARCH_PATH = '/api/v1/search';

/** What a result is. `dm_message` results belong to the `message` filter and `thought` results to `sketch`. */
export type SearchKind = 'project' | 'message' | 'dm_message' | 'doc' | 'file' | 'work' | 'decision' | 'sketch' | 'thought' | 'person';

/** Filter values of `type`: one kind, with project and direct messages together and sketches with their thoughts. */
export type SearchFilterType = 'project' | 'message' | 'doc' | 'file' | 'work' | 'decision' | 'sketch' | 'person';
export const SEARCH_FILTER_TYPES: readonly SearchFilterType[] = ['project', 'message', 'doc', 'file', 'work', 'decision', 'sketch', 'person'];

export const SEARCH_LIMITS = { query: 200, pageDefault: 20, pageMax: 50 } as const;

/**
 * `GET /api/v1/search?q=&type=&place=&author=&cursor=&limit=`.
 * - `q`: 1–200 characters in web-search syntax: words, `"exact phrase"`, `or`, `-exclude`.
 *   The last word also matches as a prefix while typing.
 * - `type`: one {@link SearchFilterType}.
 * - `place`: `project:<id>`, `dm:<id>` or `private` (your private map). A place you cannot
 *   see gives the same empty answer as a place without matches.
 * - `author`: `human:<id>` or `agent:<id>`, e.g. from a person result.
 * - `cursor`: the `next` of the previous page. It is sealed to you and to this exact query.
 */
export interface SearchQuery {
  q: string;
  type?: SearchFilterType;
  place?: string;
  author?: string;
  cursor?: string;
  limit?: number;
}

/** Where a result opens: the exact message, version, thought or object. The web and the agents' links share it. */
export function searchTargetPath(target: SearchTarget): string {
  switch (target.type) {
    case 'project': return `/projects/${target.projectId}`;
    case 'message': return `/projects/${target.projectId}/conversations/${target.conversationId}#message-${target.messageId}`;
    case 'dm_message': return `/dm/${target.dmId}#message-${target.messageId}`;
    // A match in the page as it is now opens the page itself, where it is read and edited; only an earlier version opens as a saved one (round 15).
    case 'doc': return `/projects/${target.projectId}/docs/${target.docId}${target.current ? '' : `/versions/${target.version}`}`;
    // A file (C-63) opens its message with its preview open, at the page that matched for a PDF.
    case 'file': return `/projects/${target.projectId}/conversations/${target.conversationId}?file=${target.fileId}${target.page ? `&page=${target.page}` : ''}#message-${target.messageId}`;
    // A file sent in a direct message (C-64 (3), #1590) opens its conversation at its message, with its preview open as a space's does.
    case 'dm_file': return `/dm/${target.dmId}?file=${target.fileId}${target.page ? `&page=${target.page}` : ''}#message-${target.messageId}`;
    case 'sketch': return `/map/${target.sketchId}`;
    case 'thought': return `/map/${target.sketchId}#thought-${target.thoughtId}`;
    case 'person': return `/dm/new?workspace=${encodeURIComponent(target.workspaceId)}&with=${encodeURIComponent(target.userId)}`;
    // A decision opens as a decision: in the one panel over its space's conversation, where its card is (P4), as the Inbox, a
    // notification, Discuss and the conversation's card open it, never over a Tasks view that does not list it.
    case 'decision': return decisionAppPath(target.projectId, target.id);
    // A task opens in Details on the space's Tasks view (#101, #117).
    default: return `/projects/${target.projectId}/tasks?open=${target.type}:${target.id}`;
  }
}

/**
 * What an agent's `flux_search` and `flux_read_around` return at most (F-042, AG-12): ten hits unless it asks for more, and up to 25 messages on each side
 * of the message it reads around. Both are safety bounds of one answer, far below a run's result bound.
 */
export const AGENT_SEARCH_LIMITS = { query: 300, words: 30, hitsDefault: 10, hitsMax: 25, aroundDefault: 5, aroundMax: 25 } as const;

/** Highlighted text: plain parts and matched parts, never markup. */
export interface SearchTextPart { text: string; match: boolean }
export type SearchText = SearchTextPart[];

/** Where a result lives. */
export type SearchPlace =
  | { type: 'project'; id: string; name: string }
  /** `name` is the group title, or the other participants' names. */
  | { type: 'dm'; id: string; name: string }
  | { type: 'private' }
  | { type: 'workspace'; id: string; name: string };

/** The exact object a result opens. A Wiki page's result opens the version that matched. */
export type SearchTarget =
  /** A project (#465) opens its home; it is found by its name, for whoever may open the project. */
  | { type: 'project'; projectId: string }
  | { type: 'message'; projectId: string; conversationId: string; messageId: string }
  | { type: 'dm_message'; dmId: string; messageId: string }
  /** A doc (#112) at the version that matched; `current` when that is the page as it is now, which then opens itself. */
  | { type: 'doc'; projectId: string; docId: string; version: number; current?: true }
  /** A file someone sent (C-63): its message, with its preview open at `page` (a PDF's page where the match is). */
  | { type: 'file'; projectId: string; conversationId: string; messageId: string; fileId: string; page?: number }
  /** A file sent in a direct message (C-64 (3), #1590): its conversation, the message it was sent with and its preview, at `page` for a PDF. */
  | { type: 'dm_file'; dmId: string; messageId: string; fileId: string; page?: number }
  | { type: 'work' | 'decision'; projectId: string; id: string }
  | { type: 'sketch'; sketchId: string }
  | { type: 'thought'; sketchId: string; thoughtId: string }
  | { type: 'person'; userId: string; workspaceId: string };

export interface SearchResult {
  /** Stable within the answer. */
  id: string;
  kind: SearchKind;
  /** What it is, in human language: "Message", "Wiki page · version 2 of 3", "Task · blocked". */
  label: string;
  /** The main line with the matched words marked. For a message it is the matching part of the message. */
  title: SearchText;
  /** A second line from the body with the matched words marked, when the body has one. */
  snippet: SearchText | null;
  place: SearchPlace;
  /**
   * Who wrote or proposed it, when known: a person who left the company or was removed is "Stefan Kowal (removed)" (`removedName`, founder
   * decision 2026-11-17, #1424).
   */
  author: string | null;
  /**
   * Present when the reader wrote it, or a person result is the reader: the row names them "Kasia Wójcik (you)" as every view does (design §5
   * "Naming people", personas-37).
   */
  mine?: true;
  /**
   * Present when the author is an agent, or the result is an agent's answer its person showed everyone (#1232), also an agent with no colour
   * (ink): its row's tile is the Kreska, never inferred from how the name reads (a person may be named "Planner · Ada's agent").
   */
  byAgent?: true;
  /**
   * Present when that author is an agent, or the result is an agent's answer its person showed everyone (#1232): the agent's colour, so the
   * result's tile is its Kreska in it (#1528), as the message itself draws it. Absent for a person and for an agent without a colour (ink).
   */
  agentColour?: import('./agents.js').AgentColour;
  /** When this text was written or last changed. */
  at: string;
  target: SearchTarget;
  /** A task's number in its project and its status, so its row shows the glyph and "#12" (#514). */
  task?: { number: number; status: WorkStatus };
}

export interface SearchResponse {
  /**
   * F-030: the caller's encrypted workspaces that are locked on this server; their items are left out, and the page
   * draws one "Waiting to be unlocked" row for each. Absent when none is locked.
   */
  lockedWorkspaces?: LockedWorkspaceRef[];
  items: SearchResult[];
  /**
   * Cursor of the next page; `null` when no more visible results exist. The web does not page: it only tells the reader that
   * there are more than it lists. An agent's `flux_search` does not use it (it is ranked by BM25 and asks for a larger `limit` instead).
   */
  next: string | null;
  /**
   * F-030: encrypted workspaces the reader belongs to that are too large to search in memory
   * (`FLUX_SEALED_SEARCH_MAX_BYTES`); their content is not in this answer. Absent when there are none.
   */
  sealedUnavailable?: string[];
}
