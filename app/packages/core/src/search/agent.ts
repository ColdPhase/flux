import { AGENT_SEARCH_LIMITS, citeMark, type CiteKind, searchTargetPath, type SearchKind, type SearchText, WORK_STATUSES } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import type { SearchAudience, SearchPlan, SearchRow } from './ports.js';
import { searchPlaceOf, SEARCH_SOURCES } from './sources.js';

// What an agent searches with (F-042, AG-12, #1290): `flux_search` for the server engine and for the owner's Claude Code and Codex. Core states
// the query's meaning and what a hit is told as; the server decides, on every call, which audiences the caller may read (never this file) and
// labels each author as people see them (#1160).

/** The kinds an agent may ask for. A map covers its thoughts, a message a direct message too (in a run in that DM). Not people, not a space's own row. */
export const AGENT_SEARCH_KINDS = ['message', 'doc', 'material', 'task', 'decision', 'map'] as const;
export type AgentSearchKind = typeof AGENT_SEARCH_KINDS[number];

const KIND_ROWS: Record<AgentSearchKind, SearchKind[]> = {
  message: ['message', 'dm_message'], doc: ['doc'], material: ['material'], task: ['work'], decision: ['decision'], map: ['sketch', 'thought'],
};
const WORD = /[\p{L}\p{N}]+/gu;

/** What the tool is asked: as the model writes it, before anything is checked. */
export interface AgentSearchInput {
  q: string;
  /** An author's id as an earlier result gave it (`author.id`), or by the server, from a name (#1410): a person's or an agent's. */
  from?: string | undefined;
  /** A date (`2026-09-01`, from midnight UTC) or a time with its offset; from then on. */
  after?: string | undefined;
  /** The same; before it. */
  before?: string | undefined;
  kind?: AgentSearchKind | undefined;
  limit?: number | undefined;
}

/** Where the search is held, decided by the server from the run's place and the caller's rights. */
export interface AgentSearchScope {
  /** The reader's user id: the agent's owner, to name a direct message by the others in it. */
  reader: string;
  place: SearchPlan['place'];
  conversationId: string | null;
}

/** The words of a query, lower case, each once: the plain letters and digits only, so a query carries no operator. */
export function agentSearchWords(q: string): string[] {
  const text = typeof q === 'string' ? q.replace(/\s+/gu, ' ').trim() : '';
  if (!text) throw new InvalidInputError('Search for at least one word', 'QUERY_REQUIRED');
  if (text.length > AGENT_SEARCH_LIMITS.query) throw new InvalidInputError(`A search is at most ${AGENT_SEARCH_LIMITS.query} characters`, 'QUERY_TOO_LONG');
  const words = [...new Set((text.match(WORD) ?? []).map((word) => word.toLowerCase()))];
  if (!words.length) throw new InvalidInputError('Search for at least one word', 'QUERY_REQUIRED');
  return words.slice(0, AGENT_SEARCH_LIMITS.words);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** A date (from its midnight, UTC) or a time with its offset. Anything else is refused in words the model can fix. */
export function agentSearchTime(value: string, field: 'after' | 'before'): Date {
  const text = typeof value === 'string' ? value.trim() : '';
  const refused = () => new InvalidInputError(`${field} is a date like 2026-09-01 or a time like 2026-09-01T08:00:00Z`, 'INVALID_TIME');
  const date = DATE.exec(text);
  const time = date ? null : TIME.exec(text);
  const [, y, mo, d] = date ?? time ?? [];
  if (!y || !mo || !d) throw refused();
  // A day that does not exist (2026-02-31) is not rolled over into another one.
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) throw refused();
  const zone = time ? time[7]!.toUpperCase() : 'Z';
  const at = new Date(date ? `${text}T00:00:00Z` : `${y}-${mo}-${d}T${time![4]}:${time![5]}:${time![6] ?? '00'}${/^[+-]\d{4}$/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`);
  if (Number.isNaN(at.getTime())) throw refused();
  return at;
}

/** What `ranked` runs: the words, the scope the server decided, and what the agent filtered by. */
export type AgentSearchPlan = SearchPlan & { authorId: string | null; conversationId: string | null; since: Date | null; until: Date | null };

/** The BM25 statement of `@flux/db`'s search rows: one page, best first (one more than the limit, to know there is more). */
export interface AgentSearchRows<C> {
  ranked(audiences: SearchAudience<C>[], plan: AgentSearchPlan): Promise<SearchRow[]>;
}

/** The plan `ranked` runs: any of the words, in the scope the server decided, with the filters the agent gave. */
export function agentSearchPlan(input: AgentSearchInput, scope: AgentSearchScope): AgentSearchPlan {
  const words = agentSearchWords(input.q).join(' ');
  const since = input.after ? agentSearchTime(input.after, 'after') : null;
  const until = input.before ? agentSearchTime(input.before, 'before') : null;
  if (since && until && since >= until) throw new InvalidInputError('after must be earlier than before', 'INVALID_TIME');
  const limit = input.limit ?? AGENT_SEARCH_LIMITS.hitsDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_SEARCH_LIMITS.hitsMax) throw new InvalidInputError(`limit must be 1–${AGENT_SEARCH_LIMITS.hitsMax}`, 'INVALID_LIMIT');
  const kinds = input.kind ? KIND_ROWS[input.kind] : Object.values(KIND_ROWS).flat();
  if (!kinds) throw new InvalidInputError('Unknown kind', 'INVALID_TYPE');
  return { text: words, prefix: null, fuzzy: false, number: null, words, kinds, place: scope.place, author: null, after: null, limit, reader: scope.reader,
    authorId: input.from?.trim() || null, conversationId: scope.conversationId, since, until };
}

/**
 * Someone a search may be held to (#1410): a person by the name people see, or an agent with its owner's name, as the server
 * labels them for the caller. Only people and agents the caller may see named are ever candidates; the server decides who.
 */
export interface AuthorCandidate { kind: 'human' | 'agent'; id: string; name: string; ownerName?: string | null }

/** A name's words as they are compared: lower case, accents and the Polish ł folded, letters and digits only. */
export function foldedNameWords(text: string): string[] {
  return (text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[łŁ]/gu, 'l').toLowerCase().match(WORD) ?? []);
}

/**
 * Whether `from` names someone rather than giving an id (#1410). An id has no space and is long: a uuid (an agent) or an account id of
 * 20 characters or more with a digit. A name is anything else.
 */
export function isAuthorName(from: string): boolean {
  const text = from.trim();
  return !(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) || (/^[A-Za-z0-9_-]{20,}$/.test(text) && /\d/.test(text)));
}

/** One word as written against one word of a name: the same, or the same word in another case ending ("Maurycego" for "Maurycy"). */
function sameWord(asked: string, name: string): 'exact' | 'form' | null {
  if (asked === name) return 'exact';
  if (asked.length < 3 || name.length < 3) return null;
  let common = 0;
  while (common < asked.length && common < name.length && asked[common] === name[common]) common += 1;
  // A word that begins the name ("Mau" for "Maurycy"), or one that shares at least four letters and all but the last two of the shorter
  // ("Maurycego", "Jonasa"), never two names that only begin alike ("Marek" and "Marta").
  return common === asked.length || common >= Math.max(4, Math.min(asked.length, name.length) - 2) ? 'form' : null;
}

/**
 * Who `from` names among the candidates (#1410): every word of it matches a word of the name (an agent may also be named as people see
 * it, "Assistant (Ada's agent)", whose owner's words then match its owner). Exact words win over other forms: "Ada" is Ada and not
 * Adam when there is an Ada. None, one or several; the caller says which.
 */
export function authorsNamed(from: string, candidates: readonly AuthorCandidate[]): AuthorCandidate[] {
  const label = /^(.*?)\s*\((.+?)['’]s?\s+agent\)\s*$/iu.exec(from.trim());
  const asked = foldedNameWords(label ? label[1]! : from);
  const owner = label ? foldedNameWords(label[2]!) : [];
  if (!asked.length) return [];
  const score = (words: readonly string[], of: readonly string[]): 'exact' | 'form' | null => {
    let form = false;
    for (const word of words) {
      const best = of.map((name) => sameWord(word, name)).reduce<'exact' | 'form' | null>((top, next) => (top === 'exact' || next === 'exact' ? 'exact' : top ?? next), null);
      if (!best) return null;
      if (best === 'form') form = true;
    }
    return form ? 'form' : 'exact';
  };
  const matched = candidates.flatMap((candidate) => {
    const name = score(asked, foldedNameWords(candidate.name));
    if (!name) return [];
    if (owner.length && (candidate.kind !== 'agent' || !score(owner, foldedNameWords(candidate.ownerName ?? '')))) return [];
    return [{ candidate, exact: name === 'exact' }];
  });
  const exact = matched.filter((match) => match.exact);
  return (exact.length ? exact : matched).map((match) => match.candidate);
}

/** Matched words in **bold**: the one mark a model reads without a legend. */
export function markedText(parts: SearchText | null): string {
  return (parts ?? []).map((part) => (part.match ? `**${part.text}**` : part.text)).join('');
}

/** Who wrote a hit, as the server labelled them for this space (#1160). */
export interface AgentHitAuthor { kind: 'human' | 'agent'; id: string; name: string }

/** The kind an agent is told: its own words for a task and a map, a direct message is a message of a place that is a direct message. */
const KIND_WORD: Record<SearchKind, string> = {
  project: 'space', message: 'message', dm_message: 'message', material: 'material', doc: 'doc', work: 'task', decision: 'decision', sketch: 'map', thought: 'thought', person: 'person',
};

/** The kinds of hit an answer may cite (C-62): a message of a space, a Wiki page, a task, a decision. A direct message, a material, a map and a thought carry none. */
const CITE_OF: Partial<Record<SearchKind, CiteKind>> = { message: 'message', doc: 'doc', work: 'task', decision: 'decision' };

export interface AgentHit {
  kind: string;
  /** The object's id: a message's id is what `flux_read_around` takes. */
  id: string;
  link: string;
  /** The mark that cites this hit in an answer, `[doc:ID]` (C-62): copy it after the statement the hit supports. Absent for what an answer cannot cite. */
  cite?: string;
  /** The space or the direct message it is in. */
  place: { type: 'space' | 'dm'; id: string; name: string } | null;
  /** A message's conversation and its place in it, for reading around it. */
  conversationId?: string;
  sequence?: number;
  /** A page's version. */
  version?: number;
  /** A task's number and status; a decision's status. */
  number?: number;
  status?: string;
  title?: string;
  /** The matching text with the matched words in **bold**. */
  snippet?: string;
  author?: AgentHitAuthor;
  at: string;
  /** A task's discussion (#1410): how many messages people and agents wrote about it, read with `flux_get_task_discussion`. */
  discussion?: { messages: number };
}

/** One row as the model is told it: compact, with only what it can use. The author is the server's label, never the raw name. */
export function agentHit(row: SearchRow, author: AgentHitAuthor | null): AgentHit {
  const source = SEARCH_SOURCES[row.kind];
  // A message or a thought is its text: the matching part is the hit. Any other kind has a title and, when it has a body, a snippet of it.
  const text = markedText(source.textIsTitle && !row.snippet?.length ? row.title : row.snippet);
  const title = source.textIsTitle ? '' : markedText(row.title).replace(/\*\*/g, '');
  const place = searchPlaceOf(row);
  const status = row.kind === 'work' || row.kind === 'decision' ? (WORK_STATUSES.find((known) => known === row.status) ?? row.status) : null;
  return {
    kind: KIND_WORD[row.kind],
    id: row.objectId,
    link: searchTargetPath(source.target(row)),
    ...(CITE_OF[row.kind] ? { cite: citeMark(CITE_OF[row.kind]!, row.objectId) } : {}),
    place: place.type === 'project' ? { type: 'space', id: place.id, name: place.name } : place.type === 'dm' ? { type: 'dm', id: place.id, name: place.name } : null,
    ...(row.kind === 'message' && row.parentId ? { conversationId: row.parentId } : {}),
    ...((row.kind === 'message' || row.kind === 'dm_message') && row.sequence != null ? { sequence: row.sequence } : {}),
    ...((row.kind === 'doc' || row.kind === 'material') && row.version !== null ? { version: row.version } : {}),
    ...(row.kind === 'work' && row.workNumber !== null ? { number: row.workNumber } : {}),
    ...(status ? { status } : {}),
    ...(title ? { title } : {}),
    ...(text ? { snippet: text } : {}),
    ...(author ? { author } : {}),
    at: row.at.toISOString(),
  };
}

/** The audiences of the agent kinds only: spaces and their maps (people and a person's own places are not searched for an agent). */
export function agentSearchAudiences<C>(audiences: readonly SearchAudience<C>[]): SearchAudience<C>[] {
  return audiences.filter((audience) => audience.type === 'project' || audience.type === 'sketch');
}
