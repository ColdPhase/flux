import { sql, type SQL } from 'drizzle-orm';
import { foldSearchWord } from '@flux/contracts';
import * as schema from '../schema.js';
import { hybridMatched, vectorLiteral, type QueryVectors } from './search-vectors.js';
import { cleanName } from '../display-name.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Search needs its own read-only transaction to pin the plan (see {@link planned}). */
export type SearchExecutor = Pick<NodePgDatabase<typeof schema>, 'select' | 'execute' | 'transaction'>;

/**
 * Rows for search (issue #114). They satisfy the `SearchRepository` port of
 * `packages/core/src/search/ports.ts` structurally and make no access decisions: every statement
 * receives the audiences the caller may read now, each with the access policy's own list
 * condition (`visibleFilter`), and composes them into its WHERE clause, so ranking, the limit,
 * counts and highlighting only ever see visible rows. Nothing computed over rows the caller may not see (a word's rarity among them, a
 * count of them) may reach the order or the answer: the BM25 statement lets pg_search match and ranks over the visible hits itself.
 * `search_documents` (migration 0014) is kept current by triggers in the same transaction as every write.
 */

/** `search_documents.kind` (the contracts' `SearchKind`; this package does not depend on contracts). */
export type SearchKindRow = 'project' | 'message' | 'dm_message' | 'material' | 'doc' | 'file' | 'work' | 'decision' | 'sketch' | 'thought' | 'person';
type SearchKind = SearchKindRow;
/** Highlighted text: plain and matched parts. */
export type SearchTextRow = { text: string; match: boolean }[];
type SearchText = SearchTextRow;

/** The object that carries the permission of a search row (`search_documents.audience_key`). */
export type SearchAudienceType = 'project' | 'dm' | 'sketch' | 'members';

export interface SearchAudienceRows {
  type: SearchAudienceType;
  workspaceId: string;
  /** The policy's list condition over the audience table; unused for `members`. */
  condition: SQL | null;
}

/**
 * The audience registry: for each type, the keys of the audiences that pass the policy's
 * condition. A source that carries its own permission (for example docs) adds one entry here,
 * one in the server's policy adapter and a trigger that writes its rows.
 */
export const AUDIENCE_KEYS: Record<SearchAudienceType, (audience: SearchAudienceRows) => SQL> = {
  project: ({ condition }) => sql`SELECT 'project:' || ${schema.projects.id} FROM ${schema.projects} WHERE ${condition}`,
  dm: ({ condition }) => sql`SELECT 'dm:' || ${schema.dms.id} FROM ${schema.dms} WHERE ${condition}`,
  sketch: ({ condition }) => sql`SELECT 'sketch:' || ${schema.sketches.id} FROM ${schema.sketches} WHERE ${condition}`,
  members: ({ workspaceId }) => sql`SELECT ${`members:${workspaceId}`}::text`,
};

export interface SearchPosition { score: string; at: string; id: string }

export interface SearchPlanRows {
  /** Web-search syntax input of `websearch_to_tsquery`. */
  text: string;
  /** A sanitized `to_tsquery` input whose last word is a prefix (`lamp & sens:*`), or null. */
  prefix: string | null;
  /** Also match titles by trigram similarity (plain words only; never with `-word` or quotes). */
  fuzzy: boolean;
  /** The task number the query names on its own ("#12"): a task with that number ranks above every other hit. */
  number: number | null;
  /** The plain words of the prefix query, also looked up in the index (see `audienceCte`). */
  words: string;
  kinds: SearchKind[] | null;
  place: { type: 'project' | 'dm'; id: string } | { type: 'private' } | null;
  author: { kind: 'human' | 'agent'; id: string } | null;
  after: SearchPosition | null;
  limit: number;
  /** The reader's user id, to name a DM by the other people in it. */
  reader: string;
  /**
   * What an agent's search adds (F-042, #1290; BM25 only): by whoever wrote it, whatever kind of author (an id from an earlier result);
   * in one conversation (a space's, a thread's or a task's discussion); and from this moment (inclusive) until that one (exclusive).
   */
  authorId?: string | null;
  conversationId?: string | null;
  since?: Date | null;
  until?: Date | null;
  /** Plain words (F-042, #1293): any of them matches. Read by the in-memory search of encrypted workspaces; the BM25 statement is picked by the caller. */
  anyWord?: boolean;
}

export interface SearchRowRecord {
  position: SearchPosition;
  kind: SearchKind;
  workspaceId: string;
  workspaceName: string | null;
  objectId: string;
  parentId: string | null;
  projectId: string | null;
  /** Set only when the project is itself visible to the reader. */
  projectName: string | null;
  /** The name of the DM of a DM message. */
  dmName: string | null;
  sketchTitle: string | null;
  workNumber: number | null;
  version: number | null;
  currentVersion: number | null;
  status: string | null;
  /** A message's place in its conversation (or direct message), for reading around it (#1290). */
  sequence?: number | null;
  /** A file's part of the text (C-63): the PDF page where the part begins, and the message the file was sent with. */
  page?: number | null;
  messageId?: string | null;
  title: SearchText;
  snippet: SearchText | null;
  hasBody: boolean;
  authorName: string | null;
  /** The client or assistant a message was posted through, for the author's line ("Ada · via Claude Code"). */
  via?: string | null;
  author: { kind: 'human' | 'agent'; id: string } | null;
  at: Date;
}

// Highlight markers that cannot come from content: they are removed from the text first.
const START = '⦃';
const STOP = '⦄';
const TITLE_OPTIONS = `StartSel=${START}, StopSel=${STOP}, HighlightAll=true`;
const BODY_OPTIONS = `StartSel=${START}, StopSel=${STOP}, MaxWords=26, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`;
const HEADLINE_INPUT = 20_000;
/** Text up to this length is shown whole, with every match marked. */
const WHOLE = 240;

/** Splits `ts_headline` output into plain and matched parts. */
export function highlightParts(value: string): SearchText {
  const parts: SearchText = [];
  let rest = value;
  while (rest.length) {
    const start = rest.indexOf(START);
    if (start < 0) { parts.push({ text: rest, match: false }); break; }
    if (start > 0) parts.push({ text: rest.slice(0, start), match: false });
    const stop = rest.indexOf(STOP, start + 1);
    const end = stop < 0 ? rest.length : stop;
    const text = rest.slice(start + 1, end);
    if (text) parts.push({ text, match: true });
    rest = stop < 0 ? '' : rest.slice(stop + 1);
  }
  // Adjacent parts of the same kind read as one.
  return parts.reduce<SearchText>((out, part) => {
    const last = out[out.length - 1];
    if (last && last.match === part.match) last.text += part.text;
    else out.push({ ...part });
    return out;
  }, []);
}

function tsquery(plan: SearchPlanRows): SQL {
  return plan.prefix
    ? sql`(websearch_to_tsquery('simple', ${plan.text}) || to_tsquery('simple', ${plan.prefix}))`
    : sql`websearch_to_tsquery('simple', ${plan.text})`;
}

/**
 * The reader's visible audience keys, and the index keys to look up: every visible audience
 * combined with every query word's term (`project:<id>|3:sen`) and, for plain words, every query
 * trigram (`project:<id>|t:ens`). Postings of other audiences are never read.
 */
function audienceCte(audiences: SearchAudienceRows[], plan: SearchPlanRows): SQL {
  // Every lexeme the parser finds in the query text (negated words and `or` included: that only adds
  // candidates) plus the words of the prefix query, as their index terms. A row that matches the
  // full-text or prefix query contains one of them, so no match is dropped by the lookup.
  const words = sql`ARRAY(SELECT DISTINCT search_term(lexeme) FROM unnest(to_tsvector('simple', ${plan.text} || ' ' || ${plan.words})))`;
  // Trigram similarity: the query's trigrams, so a title with a typo anywhere is still a candidate.
  const terms = plan.fuzzy ? sql`(${words} || ARRAY(SELECT 't:' || trigram FROM unnest(show_trgm(${plan.text})) AS trigram))` : words;
  return sql`aud AS MATERIALIZED (
      SELECT v.keys, ARRAY(SELECT search_key(key, term) FROM unnest(v.keys) AS key CROSS JOIN unnest(${terms}) AS term) AS lookups
      FROM (SELECT ${visibleKeys(audiences)} AS keys) v)`;
}

export function visibleKeys(audiences: SearchAudienceRows[]): SQL {
  return sql`ARRAY(${sql.join(audiences.map((audience) => AUDIENCE_KEYS[audience.type](audience)), sql` UNION ALL `)})`;
}

/**
 * How a search matches and ranks (F-042). `prefix`: today's index, every word required, the last as a prefix, ranked by `ts_rank`.
 * `bm25`: the BM25 index of migration 0065 (pg_search) **matches**: any of the words, Polish and English stems, accents folded. It does
 * not rank. pg_search's own score counts word rarity over the whole index, which holds what the caller may not read (restricted spaces,
 * other people's direct messages, other workspaces), so the order is computed here, in the statement, from the hits the caller may see
 * (see {@link rankedStatement}). Both apply the same audiences and filters in the same statement.
 */
export type SearchRanking = 'prefix' | 'bm25';

/** The BM25 index's text fields (migration 0065): title and body, each with a Polish and an English stemmer. */
const BM25_TITLES = [sql`sd.title::pdb.alias('title_pl')`, sql`sd.title::pdb.alias('title_en')`];
const BM25_BODIES = [sql`sd.body::pdb.alias('body_pl')`, sql`sd.body::pdb.alias('body_en')`];
/**
 * What a word counts in a hit (BM25F, F-042, #1387): each time it occurs in the title counts twice each time in the body, as in the exact
 * search. A hit that holds none of the query's whole words but matched only as the word being typed (a prefix of one) or as a title with one
 * typo counts `part` of the average rarity of the query's words, once.
 */
const WEIGHT = { title: 2, body: 1, part: 0.5 } as const;
/**
 * Okapi BM25's constants, applied to the visible hits only. Chosen on the research bench (#1387: 10,000 messages, 60 questions, tuned on the
 * odd half, reported on the even half and on all; F-042): k1 changed nothing between 0.9 and 2, and b 0 or 0.1 found one more answer on
 * the tuning half than 0.2 to 0.75; of the two, 0.1 keeps some length normalisation for long documents.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.1;
/** The query words that are looked up (a longer query keeps its first words and the word being typed), and the words that also match a title with a typo. */
const MATCH_WORDS = 12;
const TYPO_MIN_LETTERS = 4;
const TYPO_MAX_WORDS = 6;
/** A position carries `rank / (rank + SQUASH)`, in (0, 1), so that an encrypted space's rows (ranked 0 to 1.5 in memory) merge with them. The order is the same. */
const SQUASH = 10;

/** The word a person is still typing: the last word of the prefix query (`lamp & sens:*`), folded, when it has two letters or more. */
function typingWord(plan: SearchPlanRows): string | null {
  const word = /([\p{L}\p{N}]+):\*$/u.exec(plan.prefix ?? '')?.[1];
  const folded = word ? foldSearchWord(word) : '';
  // Only letters and digits reach a pattern, so it carries no regular expression syntax.
  return /^[\p{L}\p{N}]{2,}$/u.test(folded) ? folded : null;
}

/**
 * The plan's plain words as an "any of them" `tsquery`, to mark them in BM25 snippets: each word, and a longer form of it as the prefix
 * of the word without its last letters (`czujn:*` marks "czujników", `calibra:*` "calibrated" and "calibration").
 */
function anyWord(plan: SearchPlanRows): SQL {
  return sql`to_tsquery('simple', array_to_string(ARRAY(SELECT DISTINCT CASE
    WHEN length(lexeme) >= 6 THEN left(lexeme, length(lexeme) - 2) || ':*' WHEN length(lexeme) >= 4 THEN left(lexeme, length(lexeme) - 1) || ':*' ELSE lexeme END
    FROM unnest(to_tsvector('simple', ${plan.words}))), ' | '))`;
}

/** A task that exists and whose creation was not reverted: work IDs are UUIDs, other kinds (including people) carry arbitrary text IDs, so only a task's is cast. */
const WORK_LIFECYCLE = sql`(sd.kind <> 'work' OR COALESCE((SELECT active_work.creation_reverted_at IS NULL FROM project_work_items active_work
      WHERE active_work.id = (CASE WHEN sd.kind = 'work' THEN sd.object_id::uuid END)), false))`;

/** What the caller asked to narrow the search to: kind, place, author (and for an agent: author id, conversation, time). */
function scopeConditions(plan: SearchPlanRows): SQL[] {
  const conditions: SQL[] = [];
  if (plan.kinds?.length) conditions.push(sql`sd.kind IN (${sql.join(plan.kinds.map((kind) => sql`${kind}`), sql`, `)})`);
  const place = plan.place;
  if (place?.type === 'project') conditions.push(sql`sd.project_id = ${place.id}::uuid`);
  // A DM's own messages carry its audience.
  if (place?.type === 'dm') conditions.push(sql`sd.audience_key = ${`dm:${place.id}`}`);
  if (place?.type === 'private') conditions.push(sql`(sd.kind IN ('sketch', 'thought') AND sd.project_id IS NULL)`);
  if (plan.author) conditions.push(sql`sd.author_kind = ${plan.author.kind} AND sd.author_id = ${plan.author.id}`);
  if (plan.authorId) conditions.push(sql`sd.author_id = ${plan.authorId}`);
  // A conversation's messages carry it as their parent (a task's discussion is one), and so do the files sent with them.
  if (plan.conversationId) conditions.push(sql`(sd.kind IN ('message', 'file') AND sd.parent_id = ${plan.conversationId})`);
  if (plan.since) conditions.push(sql`sd.at >= ${plan.since.toISOString()}::timestamptz`);
  if (plan.until) conditions.push(sql`sd.at < ${plan.until.toISOString()}::timestamptz`);
  return conditions;
}

const AUDIENCE_ANY = sql`sd.audience_key = ANY ((SELECT keys FROM aud)::text[])`;

/** Everything a hit of the exact (`prefix`) statement must satisfy apart from the cursor. */
function hitConditions(plan: SearchPlanRows): SQL {
  const conditions: SQL[] = [
    sql`sd.keys && (SELECT lookups FROM aud)`,
    AUDIENCE_ANY,
    // Keep the indexed UUID side intact and apply lifecycle before page/count/probe limits.
    // A correlated scalar projection cannot become a hashed scan of unrelated tasks.
    WORK_LIFECYCLE,
    plan.fuzzy ? sql`(sd.tsv @@ ${tsquery(plan)} OR sd.title %> ${plan.text})` : sql`sd.tsv @@ ${tsquery(plan)}`,
    ...scopeConditions(plan),
  ];
  return sql.join(conditions, sql` AND `);
}

/**
 * A task's number is the first line of its indexed body ("#12", see migration 0055). A query that is only a
 * number puts that task first: rank (at most 1) plus half the similarity stays far below the added 10, which
 * therefore orders it above every other hit, also across pages (the cursor carries the same score).
 */
function exactNumber(plan: SearchPlanRows): SQL {
  return plan.number === null
    ? sql``
    : sql` + CASE WHEN sd.kind = 'work' AND split_part(sd.body, E'\n', 1) = ${`#${plan.number}`} THEN 10 ELSE 0 END`;
}

/** The words that are looked up, and the one being typed (as the prefix query gives it). */
function lookedUpWords(plan: SearchPlanRows): { words: string[]; typed: string | null } {
  const distinct = [...new Set(plan.words.split(' ').filter(Boolean))];
  const typed = /([\p{L}\p{N}]+):\*$/u.exec(plan.prefix ?? '')?.[1] ?? null;
  const words = distinct.slice(0, MATCH_WORDS);
  if (typed && distinct.includes(typed) && !words.includes(typed)) words[MATCH_WORDS - 1] = typed;
  return { words, typed };
}

/**
 * The ranked statement's evidence (F-042): which of the query's words each visible document holds, and where. The BM25 index decides what
 * a word matches (stems, accents, a prefix, a typo); how rare a word is, is decided from these facts alone, never from the index's statistics.
 *
 * pg_search can tell which clause matched only through the score. Every clause is therefore a constant-score query (`pdb.const`), so a hit's
 * score is the sum of the constants of the clauses that matched and nothing else: no term frequency, no rarity of any word, no other
 * document. A constant is a power of two, one bit for each time a clause of a kind can match (a word in the title may match through the
 * Polish and through the English field: two clauses, two bits). pg_search keeps a constant only up to 2048 (a larger one scores 2048: before
 * #1387 every word after the third was read as the third), and a score is a 32-bit float, exact over 24 binary digits; the audience filter
 * adds exactly 1 (a set of audiences scores a constant 1). The constants are therefore 2^-12 to 2^10, and `score × 2^12 − 2^12` is the
 * code, 23 bits (`SCORE_BITS`). The scan holds no other filter:
 * pg_search scores a filter it is given on a single value (a kind, a place, an author, a conversation) by BM25, with that value's rarity over
 * the whole index, which would flip the bits. The caller's filters and the work lifecycle are therefore applied to the scan's rows, after
 * it, in `cand`. The words are packed into as few scans as the 23 bits allow (five words a scan), and each hit's score is decoded into the
 * words it holds and where: for each word, whole in the title or whole in the body; and for the document, matched only as the word being
 * typed (a prefix) or as a title with a typo, which is not tied to one word.
 */
interface RankedField { shift: number; bits: number }
/** A clause of a scan: the query for a constant, and the field of the score that constant belongs to (null: the document-level partial match of the chunk). */
interface RankedClause { query: (constant: SQL) => SQL; at: RankedField | null }
interface RankedWord { w: number; word: string; title: RankedField; body: RankedField }
interface RankedChunk { words: RankedWord[]; clauses: RankedClause[]; part: RankedField | null }

const bitsFor = (count: number) => Math.ceil(Math.log2(count + 1));
/** The bits of a decoded score (see the evidence above): code bit `k` is the constant 2^(k − 12), so the largest is 2^10. */
const SCORE_BITS = 23;
const FRACTION_BITS = 12;
const constantOf = (bit: number) => 2 ** (bit - FRACTION_BITS);

/** The clauses that match a word only partly: the word being typed as a prefix of what is indexed, and a title with one typo. */
function partialClauses(plan: SearchPlanRows): RankedClause[] {
  const { words, typed } = lookedUpWords(plan);
  const prefix = typingWord(plan);
  const clauses: RankedClause[] = [];
  // "sens" finds "sensors": the index holds stems, so a prefix is looked up in them.
  if (prefix && typed && words.includes(typed))
    for (const field of [...BM25_TITLES, ...BM25_BODIES]) clauses.push({ at: null, query: (constant) => sql`${field} @@@ (pdb.regex(${`${prefix}.*`}::text)::pdb.const(${constant}))` });
  // A person's search (`fuzzy`) also tolerates a typo in a title, in any of its longer words; a task number names one task.
  const typos = plan.fuzzy && plan.number === null ? words.filter((word) => [...word].length >= TYPO_MIN_LETTERS).slice(0, TYPO_MAX_WORDS) : [];
  if (typos.length)
    for (const field of BM25_TITLES) clauses.push({ at: null, query: (constant) => sql`${field} ||| ${typos.join(' ')}::text::pdb.fuzzy(1)::pdb.const(${constant})` });
  return clauses;
}

const num = (value: number) => sql.raw(String(value));

function rankedChunks(plan: SearchPlanRows): RankedChunk[] {
  const { words } = lookedUpWords(plan);
  const partial = partialClauses(plan);
  const chunks: RankedChunk[] = [{ words: [], clauses: [...partial], part: partial.length ? { shift: 0, bits: bitsFor(partial.length) } : null }];
  let used = chunks[0]!.part ? chunks[0]!.part.bits : 0;
  words.forEach((word, w) => {
    if (used + 4 > SCORE_BITS) { chunks.push({ words: [], clauses: [], part: null }); used = 0; }
    const chunk = chunks[chunks.length - 1]!;
    const title = { shift: used, bits: 2 };
    const body = { shift: used + 2, bits: 2 };
    chunk.words.push({ w, word, title, body });
    for (const field of BM25_TITLES) chunk.clauses.push({ at: title, query: (constant) => sql`${field} ||| ${word}::text::pdb.const(${constant})` });
    for (const field of BM25_BODIES) chunk.clauses.push({ at: body, query: (constant) => sql`${field} ||| ${word}::text::pdb.const(${constant})` });
    used += 4;
  });
  return chunks;
}

/** The scan of one chunk: each visible hit, read once, with the sum of the constants of the clauses it matched (decoded in `cand`), and its own tsvector. */
function rankedScan(chunk: RankedChunk, plan: SearchPlanRows): SQL {
  const clauses = chunk.clauses.map((clause) => clause.query(sql.raw(String(constantOf((clause.at ?? chunk.part!).shift)))));
  const numbered = plan.number === null ? sql`false` : sql`(sd.kind = 'work' AND split_part(sd.body, E'\n', 1) = ${`#${plan.number}`})`;
  // Only the audiences filter the scan; the caller's filters read these columns after it, in `cand` (see the evidence above `RankedField`).
  return sql`SELECT sd.id, sd.kind, sd.object_id, sd.version, sd.at, sd.tsv, ${numbered} AS numbered,
        sd.audience_key, sd.project_id, sd.parent_id, sd.author_kind, sd.author_id,
        (pdb.score(sd.id)::float8 * ${num(2 ** FRACTION_BITS)})::bigint AS raw
      FROM search_documents sd WHERE NOT sd.sealed AND ${AUDIENCE_ANY} AND (${sql.join(clauses, sql` OR `)})`;
}

/** A scan's score as its code bits: the audience filter's 1 taken out. */
const decoded = (raw: SQL) => sql`(${raw} - ${num(2 ** FRACTION_BITS)})`;

/**
 * The ranked statement's CTEs: BM25 over the visible hits only, in SQL (#1326, #1387). `cand` holds the documents that match any word and may
 * be shown (the audiences are in every scan; the caller's filters and the work lifecycle are applied to its rows). A word's document
 * frequency, the number of documents and their average length are counted over `cand` and nothing else, so what the caller cannot read, in
 * this space, in another or in another workspace, moves nothing. A document's own part comes from its own tsvector (`tsv`, stored with the
 * row) and nothing else: its length (`length(tsv)`, its distinct words) and, for each query word the index found in it, how often the word
 * occurs in the title and in the body (at least once where the index found it). With `tf = 2 × title + body`, each word adds
 * `idf × tf × (k1 + 1) / (tf + k1 × (1 − b + b × length / average))`; a word that every hit holds counts for little. A document that holds
 * no whole word but matched as the word being typed or with a typo counts `part` of the average rarity of the query's words, once.
 */
function rankedStatement(plan: SearchPlanRows, vector: string | null = null): SQL {
  const chunks = rankedChunks(plan);
  const scans = chunks.map((chunk, index) => sql`chunk${num(index)} AS MATERIALIZED (${rankedScan(chunk, plan)}),`);
  // A document found by several scans is one row, with the code of each; one scan (the usual case) needs no grouping.
  // The caller's filters and the work lifecycle, on each scan's rows (a MATERIALIZED scan keeps them out of pg_search's query and score).
  const keep = sql.join([WORK_LIFECYCLE, ...scopeConditions(plan)], sql` AND `);
  const hits = chunks.length === 1
    ? sql`SELECT sd.id, sd.kind, sd.object_id, sd.version, sd.at, sd.tsv, sd.numbered, ${decoded(sql`sd.raw`)} AS c0 FROM chunk0 sd WHERE ${keep}`
    : sql`SELECT id, min(kind) AS kind, min(object_id) AS object_id, min(version) AS version, min(at) AS at, (array_agg(tsv))[1] AS tsv,
        bool_or(numbered) AS numbered, ${sql.join(chunks.map((_, index) => sql`max(code) FILTER (WHERE k = ${num(index)}) AS c${num(index)}`), sql`, `)}
      FROM (${sql.join(chunks.map((_, index) => sql`SELECT ${num(index)} AS k, sd.id, sd.kind, sd.object_id, sd.version, sd.at, sd.tsv, sd.numbered,
        ${decoded(sql`sd.raw`)} AS code FROM chunk${num(index)} sd WHERE ${keep}`), sql` UNION ALL `)}) u GROUP BY id`;
  const words = chunks.flatMap((chunk, index) => chunk.words.map((word) => ({ word, code: sql.raw(`coalesce(h.c${index}, 0)`) })));
  const field = (code: SQL, f: RankedField) => sql`((${code} >> ${num(f.shift)}) & ${num(2 ** f.bits - 1)}) > 0`;
  // The document's own counts, from its tsvector: how often the word occurs in the title (weight A) and in the body (weight B), as typed or
  // folded (`ts_rank_cd` of a query of one word, without normalisation, is that count). Only the fields where the index found the word count,
  // each at least once: another form of it (a stem, an accent) is found by the index but is not this word.
  const own = words.map(({ word, code }) => {
    const title = sql`ts_rank_cd('{0,0,0,1}', h.tsv, q.q${num(word.w)}, 0)`;
    const body = sql`ts_rank_cd('{0,0,1,0}', h.tsv, q.q${num(word.w)}, 0)`;
    return sql`(CASE WHEN ${field(code, word.title)} THEN ${num(WEIGHT.title)} * greatest(${title}, 1) ELSE 0 END
        + CASE WHEN ${field(code, word.body)} THEN ${num(WEIGHT.body)} * greatest(${body}, 1) ELSE 0 END)::float8 AS tf${num(word.w)}`;
  });
  const queries = words.map(({ word }) => {
    const typed = word.word.toLowerCase();
    const folded = foldSearchWord(word.word);
    const query = typed === folded ? sql`plainto_tsquery('simple', ${typed})` : sql`(plainto_tsquery('simple', ${typed}) || plainto_tsquery('simple', ${folded}))`;
    return sql`${query} AS q${num(word.w)}`;
  });
  const tf = (entry: (typeof words)[number]) => sql.raw(`c.tf${entry.word.w}`);
  const idf = (entry: (typeof words)[number]) => sql`ln(1 + (st.n - st.n${num(entry.word.w)} + 0.5) / (st.n${num(entry.word.w)} + 0.5))`;
  const counts = words.map((entry) => sql`count(*) FILTER (WHERE ${tf(entry)} > 0)::float8 AS n${num(entry.word.w)}`);
  const norm = sql`${num(BM25_K1)} * (1 - ${num(BM25_B)} + ${num(BM25_B)} * c.dl / st.avgdl)`;
  const whole = sql.join(words.map((entry) => sql`${idf(entry)} * ${tf(entry)} * ${num(BM25_K1 + 1)} / (${tf(entry)} + ${norm})`), sql` + `);
  const partial = sql`${num(WEIGHT.part)} * (${sql.join(words.map((entry) => idf(entry)), sql` + `)}) / ${num(words.length)} * ${num(BM25_K1 + 1)} / (1 + ${norm})`;
  const any = sql.join(words.map((entry) => sql`${tf(entry)} > 0`), sql` OR `);
  // With a query vector (the optional embeddings, #1294) the visible BM25 order above is one list of the fusion (see `hybridMatched`).
  const matched = vector
    ? hybridMatched({ vector, visible: sql`NOT sd.sealed AND ${AUDIENCE_ANY} AND ${keep}`, number: plan.number })
    : sql`matched AS (
      SELECT r.id, r.kind, r.object_id, r.version, r.at,
        round((r.rank / (r.rank + ${num(SQUASH)}))::numeric, 6) + CASE WHEN r.numbered THEN 10 ELSE 0 END AS score,
        row_number() OVER (PARTITION BY r.kind, r.object_id ORDER BY r.version DESC NULLS LAST) AS newest
      FROM ranked r
    ),`;
  return sql`
    ${sql.join(scans, sql`
    `)}
    q AS MATERIALIZED (SELECT ${sql.join(queries, sql`, `)}),
    cand AS MATERIALIZED (
      SELECT h.id, h.kind, h.object_id, h.version, h.at, h.numbered, length(h.tsv)::float8 AS dl, ${sql.join(own, sql`, `)}
      FROM (${hits}) h CROSS JOIN q),
    stats AS (SELECT count(*)::float8 AS n, greatest(avg(c.dl)::float8, 1) AS avgdl, ${sql.join(counts, sql`, `)} FROM cand c),
    scored AS (
      SELECT c.id, c.kind, c.object_id, c.version, c.at, c.numbered,
        CASE WHEN ${any} THEN ${whole} ELSE ${partial} END AS rank
      FROM cand c CROSS JOIN stats st),
    -- A file is several rows, one for each part of its text (C-63): it counts once, by its best part, before the hybrid's lists take their first 50.
    ranked AS (
      SELECT s.id, s.kind, s.object_id, s.version, s.at, s.numbered, s.rank FROM scored s WHERE s.kind <> 'file'
      UNION ALL
      (SELECT DISTINCT ON (f.object_id) f.id, f.kind, f.object_id, f.version, f.at, f.numbered, f.rank FROM scored f WHERE f.kind = 'file'
        ORDER BY f.object_id, f.rank DESC, f.version, f.id)),
    ${matched}`;
}

function pageStatement(audiences: SearchAudienceRows[], plan: SearchPlanRows, ranking: SearchRanking = 'prefix', vector: string | null = null): SQL {
  const bm25 = ranking === 'bm25';
  const q = bm25 ? anyWord(plan) : tsquery(plan);
  const columns = (alias: string) => sql.raw(['id', 'kind', 'workspace_id', 'object_id', 'parent_id', 'project_id', 'version', 'page', 'status', 'title', 'body', 'author_kind', 'author_id', 'at']
    .map((column) => `${alias}.${column}`).join(', '));
  // The BM25 statement needs only the audiences; the index keys of today's index are not looked up.
  const audience = bm25 ? sql`aud AS MATERIALIZED (SELECT ${visibleKeys(audiences)} AS keys)` : audienceCte(audiences, plan);
  const matched = bm25 ? rankedStatement(plan, vector) : sql`
    matched AS (
      SELECT ${columns('sd')},
        round((ts_rank(sd.tsv, ${q}) + 0.5 * word_similarity(${plan.text}, sd.title))::numeric, 6)${exactNumber(plan)} AS score,
        row_number() OVER (PARTITION BY sd.kind, sd.object_id ORDER BY CASE WHEN sd.kind = 'file' THEN ts_rank(sd.tsv, ${q}) END DESC NULLS LAST, sd.version DESC NULLS LAST) AS newest
      FROM search_documents sd WHERE ${hitConditions(plan)}
    ),`;
  const after = plan.after
    ? sql`WHERE (hits.score, hits.at, hits.id) < (${plan.after.score}::numeric, ${plan.after.at}::timestamptz, ${plan.after.id}::bigint)`
    : sql``;
  const clean = (column: SQL) => sql`translate(left(${column}, ${HEADLINE_INPUT}), ${START + STOP}, '')`;
  // The ranked statement ranks narrow rows; the page's rows are read whole by id, so a long body is read for at most `limit + 1` documents.
  const page = bm25
    ? sql`(SELECT ${columns('x')}, r.score FROM (SELECT hits.id, hits.score FROM hits ${after} ORDER BY hits.score DESC, hits.at DESC, hits.id DESC LIMIT ${plan.limit + 1}) r
      JOIN search_documents x ON x.id = r.id)`
    : sql`(SELECT * FROM hits ${after} ORDER BY hits.score DESC, hits.at DESC, hits.id DESC LIMIT ${plan.limit + 1})`;
  // The BM25 plan joins the hits from a CTE, where PostgreSQL may cast before it checks the kind: only a task's id is cast there.
  // The prefix plan keeps its join as it was (its rows examined are what the hidden-work tests pin).
  const workJoin = bm25
    ? sql`wi.id = (CASE WHEN h.kind = 'work' THEN h.object_id::uuid END)`
    : sql`h.kind = 'work' AND wi.id = h.object_id::uuid`;
  return sql`
    WITH ${audience},
    ${matched}
    -- One result per object: of several matching versions of a material, the newest.
    hits AS (SELECT * FROM matched WHERE newest = 1)
    SELECT h.id::text AS id, h.score::text AS score, h.at::text AS at_key, h.at, h.kind, h.workspace_id, w.name AS workspace_name,
      h.object_id, h.parent_id, h.project_id, p.name AS project_name, h.version, h.page, pf.message_id AS file_message_id, pm.current_version, h.status, sk.title AS sketch_title, wi.number AS work_number,
      h.author_kind, h.author_id, ${cleanName(sql`coalesce(au.name, ag.name)`)} AS author_name, coalesce(pmv.via, dmv.via) AS via, coalesce(pmv.sequence, dmv.sequence) AS sequence,
      length(h.body) > 0 AS has_body,
      ts_headline('simple', ${clean(sql`h.title`)}, ${q}, ${TITLE_OPTIONS}) AS title_headline,
      CASE WHEN length(h.body) = 0 THEN NULL
        WHEN length(h.body) <= ${WHOLE} THEN ts_headline('simple', ${clean(sql`h.body`)}, ${q}, ${TITLE_OPTIONS})
        ELSE ts_headline('simple', ${clean(sql`h.body`)}, ${q}, ${BODY_OPTIONS}) END AS body_headline,
      CASE WHEN d.id IS NULL THEN NULL WHEN d.title IS NOT NULL THEN d.title
        WHEN d.kind = 'pair' THEN (SELECT ${cleanName(sql`u.name`)} FROM auth_users u WHERE u.id IN (split_part(d.pair_key, ':', 1), split_part(d.pair_key, ':', 2)) AND u.id <> ${plan.reader} LIMIT 1)
        ELSE (SELECT string_agg(${cleanName(sql`u.name`)}, ', ' ORDER BY u.name) FROM dm_participants dp JOIN auth_users u ON u.id = dp.user_id WHERE dp.dm_id = d.id AND dp.user_id <> ${plan.reader})
      END AS dm_name
    FROM ${page} h
    LEFT JOIN projects p ON p.id = h.project_id AND ('project:' || p.id) = ANY ((SELECT keys FROM aud)::text[])
    LEFT JOIN workspaces w ON w.id = h.workspace_id
    LEFT JOIN auth_users au ON h.author_kind = 'human' AND au.id = h.author_id
    LEFT JOIN agents ag ON ag.id = (CASE WHEN h.author_kind = 'agent' THEN h.author_id::uuid END)
    LEFT JOIN project_messages pmv ON pmv.id = (CASE WHEN h.kind = 'message' THEN h.object_id::uuid END)
    LEFT JOIN dm_messages dmv ON dmv.id = (CASE WHEN h.kind = 'dm_message' THEN h.object_id::uuid END)
    LEFT JOIN project_materials pm ON pm.id = (CASE WHEN h.kind IN ('material', 'doc') THEN h.object_id::uuid END)
    LEFT JOIN project_files pf ON pf.id = (CASE WHEN h.kind = 'file' THEN h.object_id::uuid END)
    LEFT JOIN sketches sk ON h.kind = 'thought' AND sk.id = h.parent_id
    LEFT JOIN project_work_items wi ON ${workJoin}
    LEFT JOIN dms d ON d.id = (CASE WHEN h.kind = 'dm_message' THEN h.parent_id END)
    ORDER BY h.score DESC, h.at DESC, h.id DESC`;
}

interface PageRow {
  id: string; score: string; at_key: string; at: Date | string; kind: SearchKind; workspace_id: string; workspace_name: string | null;
  object_id: string; parent_id: string | null; project_id: string | null; project_name: string | null; version: number | null;
  current_version: number | null; status: string | null; sequence: number | null; page: number | null; file_message_id: string | null; sketch_title: string | null; author_name: string | null; has_body: boolean;
  author_kind: 'human' | 'agent' | null; author_id: string | null; via: string | null;
  title_headline: string | null; body_headline: string | null; dm_name: string | null; work_number: number | null;
}

function toRecord(row: PageRow): SearchRowRecord {
  return {
    position: { score: row.score, at: row.at_key, id: row.id },
    kind: row.kind,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    objectId: row.object_id,
    parentId: row.parent_id,
    projectId: row.project_id,
    projectName: row.project_name,
    dmName: row.dm_name,
    sketchTitle: row.sketch_title,
    workNumber: row.work_number,
    version: row.version,
    currentVersion: row.current_version,
    status: row.status,
    sequence: row.sequence,
    page: row.page,
    messageId: row.file_message_id,
    title: highlightParts(row.title_headline ?? ''),
    snippet: row.body_headline ? highlightParts(row.body_headline) : null,
    hasBody: row.has_body,
    authorName: row.author_name,
    via: row.via,
    author: row.author_kind && row.author_id ? { kind: row.author_kind, id: row.author_id } : null,
    at: row.at instanceof Date ? row.at : new Date(row.at),
  };
}

/**
 * Runs a search statement in its own read-only transaction with sequential scans disabled, so
 * PostgreSQL always reaches `search_documents` through the audience-leading GIN indexes, also
 * while the table is small. The work then depends only on the audiences the reader may see.
 */
async function planned(db: SearchExecutor, statement: SQL, ranking: SearchRanking = 'prefix') {
  if (ranking === 'bm25') {
    // pg_search's custom scan scores BM25 and is off by default in Flux's database image (docker/database, F-042): on for this
    // statement only. Not read-only: pg_search records each field alias it meets in its own table (paradedb._typmod_cache).
    // When `db` is itself a transaction this is a savepoint, after which SET LOCAL would stay for the rest of the caller's
    // transaction (and pg_search's scan would then refuse its other statements on search_documents): the settings are put back.
    return db.transaction(async (tx) => {
      const before = await tx.execute(sql`SELECT (SELECT current_setting('enable_seqscan')) AS seq,
        (SELECT current_setting('paradedb.enable_custom_scan')) AS scan,
        set_config('enable_seqscan', 'off', true), set_config('paradedb.enable_custom_scan', 'on', true)`);
      const { seq, scan } = before.rows[0] as { seq: string; scan: string };
      const result = await tx.execute(statement);
      await tx.execute(sql`SELECT set_config('enable_seqscan', ${seq}, true), set_config('paradedb.enable_custom_scan', ${scan}, true)`);
      return result;
    });
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    return tx.execute(statement);
  }, { accessMode: 'read only' });
}

interface PlanNode {
  'Node Type': string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[];
  'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; 'Actual Total Time'?: number;
}

/** What a statement read (EXPLAIN ANALYZE, BUFFERS), from its scan nodes. */
export interface ExaminedWork {
  /** Table rows read by scan nodes, including rows a filter discarded (bitmap index scans only list addresses). */
  rows: number;
  /** Row addresses the `search_documents` bitmap index scans produced. */
  indexRows: number;
  /** Buffers (hit + read) of the scan nodes on `search_documents` and its indexes, index work included. */
  searchBuffers: number;
  /** Buffers (hit + read) of the whole statement. */
  buffers: number;
  /** Index scans on `search_documents` (each looks up every visible audience × query term key). */
  indexScans: number;
  nodes: string[];
}

const blocks = (node: PlanNode) => (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0);

async function examined(db: SearchExecutor, statement: SQL): Promise<ExaminedWork> {
  const result = await planned(db, sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
  const plan = ((result.rows[0] as Record<string, unknown>)['QUERY PLAN'] as { Plan: PlanNode }[])[0]!.Plan;
  const work: ExaminedWork = { rows: 0, indexRows: 0, searchBuffers: 0, buffers: blocks(plan), indexScans: 0, nodes: [] };
  // A node's buffers include its children's: count the topmost scan on search_documents once.
  const walk = (node: PlanNode, inSearchScan: boolean) => {
    const type = node['Node Type'];
    const name = node['Index Name'] ?? node['Relation Name'] ?? '';
    const loops = node['Actual Loops'] ?? 1;
    let read = 0;
    if (type.includes('Scan') && type !== 'Bitmap Index Scan') {
      read = ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * loops;
      work.rows += read;
    }
    const onSearch = name.startsWith('search_documents') && type.includes('Scan');
    if (onSearch && type === 'Bitmap Index Scan') { work.indexRows += (node['Actual Rows'] ?? 0) * loops; work.indexScans += loops; }
    if (onSearch && !inSearchScan) work.searchBuffers += blocks(node);
    work.nodes.push(`${type}${name ? ` ${name}` : ''}${read ? ` rows=${read}` : ''}${onSearch ? ` buffers=${blocks(node)}` : ''}`);
    for (const child of node.Plans ?? []) walk(child, inSearchScan || onSearch);
  };
  walk(plan, false);
  return work;
}

/**
 * `vectors` is given only while the optional embeddings are on (migration 0068, #1294): `ranked` then fuses its visible BM25 order with
 * the visible rows nearest to the query's vector. Without it, or when it answers null, nothing changes.
 */
export function searchRows(db: SearchExecutor, vectors?: QueryVectors) {
  return {
    /** The workspaces a person belongs to now. */
    async memberWorkspaces(userId: string) {
      const rows = await db.select({ id: schema.workspaceMembers.workspaceId }).from(schema.workspaceMembers)
        .where(sql`${schema.workspaceMembers.userId} = ${userId}`);
      return rows.map((row) => row.id);
    },

    /** The workspace of an unrevoked agent. */
    async agentWorkspaces(agentId: string) {
      const rows = await db.select({ id: schema.agents.workspaceId }).from(schema.agents)
        .where(sql`${schema.agents.id}::text = ${agentId} AND ${schema.agents.revokedAt} IS NULL`);
      return rows.map((row) => row.id);
    },

    /** One page (up to `limit + 1` rows, best first) of the visible matches after `plan.after`. */
    async page(audiences: SearchAudienceRows[], plan: SearchPlanRows): Promise<SearchRowRecord[]> {
      if (!audiences.length) return [];
      const result = await planned(db, pageStatement(audiences, plan));
      return (result.rows as unknown as PageRow[]).map(toRecord);
    },

    /**
     * One page like `page`, matched by the BM25 index (F-042, migration 0065): any of the plan's plain words, Polish and English stems, accents
     * folded. pg_search only matches; the order is BM25 over the hits the caller may see, computed in the statement, so nothing the caller
     * may not read moves it. The same audiences, filters, cursor and one-row-per-object rule; the access policy decides the audiences on
     * every call, so a lost grant, a space whose AI was turned off, a removed or edited row is reflected by the next call. With embeddings on,
     * the order is the fusion of that BM25 order and the exact nearest vectors among the same visible, filtered rows.
     */
    async ranked(audiences: SearchAudienceRows[], plan: SearchPlanRows): Promise<SearchRowRecord[]> {
      if (!audiences.length || !/[\p{L}\p{N}]/u.test(plan.words)) return [];
      const vector = vectors ? await vectors(plan.words) : null;
      const result = await planned(db, pageStatement(audiences, plan, 'bm25', vector ? vectorLiteral(vector) : null), 'bm25');
      return (result.rows as unknown as PageRow[]).map(toRecord);
    },

    /** Test support: what the page statement of this plan reads, and the keys each index scan looks up. */
    async explain(audiences: SearchAudienceRows[], plan: SearchPlanRows) {
      if (!audiences.length) return { rows: 0, indexRows: 0, searchBuffers: 0, buffers: 0, indexScans: 0, lookups: 0, nodes: [] as string[] };
      const page = await examined(db, pageStatement(audiences, plan));
      const keys = await planned(db, sql`WITH ${audienceCte(audiences, plan)} SELECT cardinality(lookups) AS n FROM aud`);
      return { ...page, lookups: Number((keys.rows[0] as { n: number | string }).n) };
    },
  };
}
