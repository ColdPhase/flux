/**
 * Search across Flux (issue #114, foundation 8.12).
 *
 * One query over project and direct messages, docs and materials and every version of them, work, decisions, results,
 * sketches and their thoughts, drafts and people. Every result, snippet, count and the `next`
 * cursor come only from objects the caller may read at the moment of the request: the server
 * applies the access policy inside the SQL before ranking, limiting, counting and highlighting.
 */
export const SEARCH_PATH = '/api/v1/search';

/** What a result is. `dm_message` results belong to the `message` filter and `thought` results to `sketch`. */
export type SearchKind = 'message' | 'dm_message' | 'material' | 'doc' | 'work' | 'decision' | 'result' | 'sketch' | 'thought' | 'draft' | 'person';

/** Filter values of `type`: one kind, with project and direct messages together and sketches with their thoughts. */
export type SearchFilterType = 'message' | 'doc' | 'material' | 'work' | 'decision' | 'result' | 'sketch' | 'draft' | 'person';
export const SEARCH_FILTER_TYPES: readonly SearchFilterType[] = ['message', 'doc', 'material', 'work', 'decision', 'result', 'sketch', 'draft', 'person'];

export const SEARCH_LIMITS = { query: 200, pageDefault: 20, pageMax: 50, countCap: 500 } as const;

/**
 * `GET /api/v1/search?q=&type=&place=&author=&cursor=&limit=`.
 * - `q`: 1–200 characters in web-search syntax: words, `"exact phrase"`, `or`, `-exclude`.
 *   The last word also matches as a prefix while typing.
 * - `type`: one {@link SearchFilterType}.
 * - `place`: `project:<id>`, `dm:<id>` or `private` (your private drafts and sketches). A place you cannot
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

/** The exact object a result opens. Material results open the version that matched. */
export type SearchTarget =
  | { type: 'agent_thread'; projectId: string; taskId: string; conversationId: string; messageId: string }
  | { type: 'message'; projectId: string; conversationId: string; messageId: string }
  | { type: 'dm_message'; dmId: string; messageId: string }
  | { type: 'material'; projectId: string; materialId: string; version: number }
  /** A doc (#112) at the version that matched. */
  | { type: 'doc'; projectId: string; docId: string; version: number }
  | { type: 'work' | 'decision' | 'result'; projectId: string; id: string }
  /** `dmId`: the sketch belongs to this DM and opens inside it (#96); null otherwise. */
  | { type: 'sketch'; sketchId: string; dmId: string | null }
  | { type: 'thought'; sketchId: string; thoughtId: string; dmId: string | null }
  | { type: 'draft'; draftId: string }
  | { type: 'person'; userId: string; workspaceId: string };

export interface SearchResult {
  /** Stable within the answer. */
  id: string;
  kind: SearchKind;
  /** What it is, in human language: "Message", "Material · version 2 of 3", "Task · blocked". */
  label: string;
  /** The main line with the matched words marked. For a message it is the matching part of the message. */
  title: SearchText;
  /** A second line from the body with the matched words marked, when the body has one. */
  snippet: SearchText | null;
  place: SearchPlace;
  /** Who wrote or proposed it, when known. */
  author: string | null;
  /** When this text was written or last changed. */
  at: string;
  target: SearchTarget;
}

export interface SearchResponse {
  items: SearchResult[];
  /** Cursor of the next page; `null` when no more visible results exist. */
  next: string | null;
  /** Visible matches per filter type, over all types and without the cursor. */
  counts: Partial<Record<SearchFilterType, number>>;
  /** True when counting stopped at {@link SEARCH_LIMITS.countCap} visible matches. */
  countsCapped: boolean;
}
