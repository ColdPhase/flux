import { createHash } from 'node:crypto';
import {
  SEARCH_FILTER_TYPES, SEARCH_LIMITS,
  type SearchFilterType, type SearchKind, type SearchQuery, type SearchResponse, type SearchResult,
} from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { SearchPlan, SearchPorts, SearchRow } from './ports.js';
import { SEARCH_SOURCES, searchKindsOf, searchPlaceOf } from './sources.js';

// Search across Flux (issue #114, foundation 8.12). The access policy decides the audiences the
// reader may see now and the rows compose them into SQL before ranking, limits, counts and
// highlighting, so no result, snippet, count or `next` cursor ever reflects a hidden object.
// The cursor is sealed to the reader and to the exact query, and carries only the position of
// the last visible result.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /[\p{L}\p{N}]+/gu;
const MAX_PREFIX_WORDS = 12;

export class CursorInvalidError extends InvalidInputError {
  constructor() { super('The cursor does not belong to this search; start again without it', 'CURSOR_INVALID'); }
}

function reader(principal: Principal) {
  if ((principal.kind !== 'human' && principal.kind !== 'agent') || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

/**
 * The `to_tsquery` form of what the person is typing: every word, the last one as a prefix. Only
 * letters and digits reach it, so it cannot carry query operators. Queries that use the web
 * search syntax (quotes, `or`, `-word`) are left to `websearch_to_tsquery` alone.
 */
/** Whether the text uses web search syntax: quotes, `or` or `-word`. */
export function usesSearchSyntax(text: string) {
  return /["]|(^|\s)-|(^|\s)or(\s|$)/i.test(text);
}

export function prefixQuery(text: string): string | null {
  if (usesSearchSyntax(text)) return null;
  if (!/[\p{L}\p{N}]$/u.test(text)) return null;
  const words = (text.match(WORD) ?? []).slice(-MAX_PREFIX_WORDS).map((word) => word.toLowerCase());
  if (!words.length) return null;
  const last = words.pop()!;
  return [...words, `${last}:*`].join(' & ');
}

/**
 * The index keys of a query (migration 0014 `search_keys`): the first two characters of a
 * two-character word (`2:ai`) and the first three of a longer one (`3:sen`). Excluded words
 * (`-word`) and `or` add none, and one-character words are not searched.
 */
export function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(/(^|\s)(-?)("?)([^\s]+)/gu)) {
    if (match[2] === '-') continue;
    for (const word of match[4]!.match(WORD) ?? []) {
      const lower = word.toLowerCase();
      if (lower === 'or' || [...lower].length < 2) continue;
      const chars = [...lower];
      terms.add(chars.length >= 3 ? `3:${chars.slice(0, 3).join('')}` : `2:${lower}`);
    }
  }
  return [...terms].slice(0, 16);
}

export interface NormalizedSearch {
  text: string;
  type: SearchFilterType | null;
  place: SearchPlan['place'];
  author: SearchPlan['author'];
  cursor: string | null;
  limit: number;
}

export function normalizeSearch(query: Partial<SearchQuery> | null | undefined): NormalizedSearch {
  const raw = typeof query?.q === 'string' ? query.q : '';
  const text = raw.replace(/\s+/gu, ' ').trim();
  if (!text) throw new InvalidInputError('Type something to search for', 'QUERY_REQUIRED');
  if (text.length > SEARCH_LIMITS.query) throw new InvalidInputError(`A search is at most ${SEARCH_LIMITS.query} characters`, 'QUERY_TOO_LONG');
  let type: SearchFilterType | null = null;
  if (query?.type !== undefined && query.type !== null && (query.type as string) !== '') {
    if (!SEARCH_FILTER_TYPES.includes(query.type)) throw new InvalidInputError('Unknown result type', 'INVALID_TYPE');
    type = query.type;
  }
  let place: SearchPlan['place'] = null;
  if (query?.place) {
    const match = /^(project|dm):(.+)$/.exec(query.place);
    if (query.place === 'private') place = { type: 'private' };
    else if (match && UUID.test(match[2]!)) place = { type: match[1] as 'project' | 'dm', id: match[2]!.toLowerCase() };
    else throw new InvalidInputError('Place must be project:<id>, dm:<id> or private', 'INVALID_PLACE');
  }
  let author: SearchPlan['author'] = null;
  if (query?.author) {
    const match = /^(human|agent):([A-Za-z0-9_-]{1,64})$/.exec(query.author);
    if (!match) throw new InvalidInputError('Author must be human:<id> or agent:<id>', 'INVALID_AUTHOR');
    author = { kind: match[1] as 'human' | 'agent', id: match[2]! };
  }
  const limit = query?.limit === undefined ? SEARCH_LIMITS.pageDefault : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.pageMax) throw new InvalidInputError(`limit must be 1–${SEARCH_LIMITS.pageMax}`, 'INVALID_LIMIT');
  const cursor = typeof query?.cursor === 'string' && query.cursor ? query.cursor : null;
  return { text, type, place, author, cursor, limit };
}

/** What a cursor is sealed to besides the reader: the query and its filters, not the page size. */
function cursorScope(search: NormalizedSearch) {
  const place = search.place ? (search.place.type === 'private' ? 'private' : `${search.place.type}:${search.place.id}`) : '';
  const author = search.author ? `${search.author.kind}:${search.author.id}` : '';
  return createHash('sha256').update(JSON.stringify([search.text, search.type ?? '', place, author])).digest('base64url');
}

function toResult(row: SearchRow): SearchResult {
  const source = SEARCH_SOURCES[row.kind];
  const main = source.textIsTitle && row.snippet ? row.snippet : row.title;
  return {
    id: `${row.kind}:${row.objectId}${row.version !== null && (row.kind === 'material' || row.kind === 'doc') ? `:${row.version}` : ''}`,
    kind: row.kind,
    label: source.label(row),
    title: main.length ? main : [{ text: 'Untitled', match: false }],
    snippet: source.textIsTitle ? null : row.snippet,
    place: searchPlaceOf(row),
    author: row.authorName,
    at: row.at.toISOString(),
    target: source.target(row),
  };
}

const EMPTY: SearchResponse = { items: [], next: null, counts: {}, countsCapped: false };

export function createSearchUseCases<C>(ports: SearchPorts<C>) {
  async function prepare(principal: Principal, query: Partial<SearchQuery>) {
    const me = reader(principal);
    const search = normalizeSearch(query);
    const scope = cursorScope(search);
    const after = search.cursor ? ports.cursors.open(principal, scope, search.cursor) : null;
    if (search.cursor && !after) throw new CursorInvalidError();
    const plan: SearchPlan = {
      text: search.text,
      prefix: prefixQuery(search.text),
      fuzzy: !usesSearchSyntax(search.text),
      terms: searchTerms(search.text),
      kinds: search.type ? searchKindsOf(search.type) : null,
      place: search.place,
      author: search.author,
      after,
      limit: search.limit,
      reader: me,
    };
    // Access is decided now, on every request: a revocation applies to the very next search.
    const audiences = await ports.access.audiences(principal);
    const searchable = plan.terms.length > 0;
    return { plan, scope, audiences, searchable };
  }

  return {
    async search(principal: Principal, query: Partial<SearchQuery>): Promise<SearchResponse> {
      const { plan, scope, audiences, searchable } = await prepare(principal, query);
      if (!searchable || !audiences.length) return EMPTY;
      const [rows, counted] = await Promise.all([
        ports.rows.page(audiences, plan),
        ports.rows.counts(audiences, plan, SEARCH_LIMITS.countCap),
      ]);
      const page = rows.slice(0, plan.limit);
      const more = rows.length > plan.limit;
      const counts: SearchResponse['counts'] = {};
      for (const [kind, n] of counted.counts) {
        const filter = SEARCH_SOURCES[kind as SearchKind].filter;
        counts[filter] = (counts[filter] ?? 0) + n;
      }
      return {
        items: page.map(toResult),
        next: more ? ports.cursors.seal(principal, scope, page[page.length - 1]!.position) : null,
        counts,
        countsCapped: counted.capped,
      };
    },

    /** Test support (served only with test failure injection): rows examined by this search. */
    async explain(principal: Principal, query: Partial<SearchQuery>) {
      const { plan, audiences, searchable } = await prepare(principal, query);
      if (!searchable) return { rows: 0, indexRows: 0, searchBuffers: 0, buffers: 0, indexScans: 0, lookups: 0, nodes: [] };
      return ports.rows.explain(audiences, plan, SEARCH_LIMITS.countCap);
    },
  };
}

export type SearchUseCases = ReturnType<typeof createSearchUseCases>;
