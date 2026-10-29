import { sql } from 'drizzle-orm';
import { AUDIENCE_KEYS, type SearchAudienceRows, type SearchKindRow, type SearchPlanRows, type SearchRowRecord, type SearchTextRow } from './repositories/search.js';
import type { DbExecutor } from './repositories/push.js';
import { openRows, sealOf } from './sealing.js';

/**
 * Search in an encrypted workspace (F-030, #655, S2b; docs/product/encrypted-workspaces.md#search). PostgreSQL cannot index
 * ciphertext, and the placeholder rows of `search_documents` hold no text. Each API process therefore keeps an in-memory
 * index per unlocked workspace, built from the opened content on the first search after an unlock and kept current from
 * `search_changes`. It is never written to disk, is dropped when the workspace locks or the process drops its keys, and a
 * workspace whose text exceeds `FLUX_SEALED_SEARCH_MAX_BYTES` is not indexed (it answers `unavailable`).
 *
 * The grammar and the refusals are the SQL path's (the core use case checks them first); matching is the `simple`
 * configuration's: lowercase, no stemming, the last word also as a prefix, websearch quotes, `or` and `-word`, and a title
 * trigram match that tolerates typos. Scores approximate `ts_rank` and `word_similarity`, so order between the two sources
 * is approximate. Access is decided before this runs: only the partitions of the audience keys the reader may see are read.
 */

export const SEALED_SEARCH_DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
/** `pg_trgm.word_similarity_threshold` (the `%>` operator the SQL path uses on titles). */
const SIMILARITY = 0.6;
const BODY_CHARS = 100_000;
const WHOLE = 240;
const CHUNK = 2000;
/** `search_changes` older than this are pruned (hourly job); an index idle for longer is rebuilt rather than caught up. */
export const SEALED_SEARCH_CHANGE_RETENTION_MS = 24 * 3_600_000;
const REBUILD_AFTER_MS = 23 * 3_600_000;

const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string) => text.toLowerCase().match(WORD) ?? [];

/** Trigrams of `text` in order, with duplicates, as pg_trgm pads each word: two spaces before, one after. */
function trigramsOf(text: string): string[] {
  const out: string[] = [];
  for (const word of wordsOf(text)) {
    const chars = Array.from(`  ${word} `);
    for (let i = 0; i + 3 <= chars.length; i++) out.push(chars[i]! + chars[i + 1]! + chars[i + 2]!);
  }
  return out;
}

/** `word_similarity(query, title)`: the best share of the query's trigrams in a continuous extent of the title's. */
function wordSimilarity(query: ReadonlySet<string>, title: string[]): number {
  if (!query.size || !title.length) return 0;
  let best = 0;
  const reach = query.size * 3 + 8;
  for (let start = 0; start < title.length; start++) {
    if (!query.has(title[start]!)) continue;
    const seen = new Set<string>(); const extent = new Set<string>();
    let count = 0;
    for (let at = start; at < title.length && at - start < reach; at++) {
      const gram = title[at]!;
      extent.add(gram);
      if (query.has(gram) && !seen.has(gram)) { seen.add(gram); count++; }
      best = Math.max(best, count / (query.size + extent.size - count));
      if (count === query.size) break;
    }
  }
  return best;
}

interface Clause { words: string[]; phrase: boolean }
interface Group { positive: Clause[]; negative: Clause[] }

/** `websearch_to_tsquery` as groups joined by OR; inside a group every positive clause and no negative one must match. */
export function parseWebSearch(text: string): Group[] {
  const groups: Group[] = [{ positive: [], negative: [] }];
  const current = () => groups[groups.length - 1]!;
  let at = 0;
  while (at < text.length) {
    if (/\s/u.test(text[at]!)) { at++; continue; }
    let negated = false;
    if (text[at] === '-' && at + 1 < text.length && !/\s/u.test(text[at + 1]!)) { negated = true; at++; }
    const into = () => (negated ? current().negative : current().positive);
    if (text[at] === '"') {
      const end = text.indexOf('"', at + 1);
      const words = wordsOf(text.slice(at + 1, end < 0 ? text.length : end));
      at = end < 0 ? text.length : end + 1;
      if (words.length) into().push({ words, phrase: true });
      continue;
    }
    let end = at;
    while (end < text.length && !/\s/u.test(text[end]!)) end++;
    const raw = text.slice(at, end);
    at = end;
    if (!negated && raw.toLowerCase() === 'or') { if (current().positive.length) groups.push({ positive: [], negative: [] }); continue; }
    for (const word of wordsOf(raw)) into().push({ words: [word], phrase: false });
  }
  return groups.filter((group) => group.positive.length);
}

interface Compiled {
  groups: Group[];
  /** The prefix query: every word, the last as a prefix. */
  prefix: { exact: string[]; last: string } | null;
  fuzzy: boolean;
  queryGrams: Set<string>;
  /** Positive terms, for scoring and marking. */
  terms: { word: string; prefix: boolean }[];
}

function compile(plan: SearchPlanRows): Compiled {
  const groups = parseWebSearch(plan.text);
  let prefix: Compiled['prefix'] = null;
  if (plan.prefix) {
    const parts = plan.prefix.split(' & ');
    const last = parts.pop()!.replace(/:\*$/, '');
    prefix = { exact: parts, last };
  }
  const terms = new Map<string, boolean>();
  for (const group of groups) for (const clause of group.positive) for (const word of clause.words) if (!terms.has(word)) terms.set(word, false);
  if (prefix) { for (const word of prefix.exact) if (!terms.has(word)) terms.set(word, false); terms.set(prefix.last, true); }
  return { groups, prefix, fuzzy: plan.fuzzy, queryGrams: new Set(trigramsOf(plan.text)), terms: [...terms].map(([word, isPrefix]) => ({ word, prefix: isPrefix })) };
}

/** What a search read: postings entries and documents examined (the saturation test compares it with and without hidden matches). */
export interface SealedSearchWork { postings: number; terms: number; documents: number }

interface IndexDoc {
  id: string;
  key: string;
  kind: SearchKindRow;
  audience: string;
  workspaceId: string;
  projectId: string | null;
  objectId: string;
  parentId: string | null;
  dmId: string | null;
  version: number | null;
  status: string | null;
  author: { kind: 'human' | 'agent'; id: string } | null;
  at: Date;
  /** `at::text`, the cursor's form; `atMicros` the same instant as microseconds. */
  atKey: string;
  atMicros: bigint;
  title: string;
  body: string;
  number: number | null;
  /** A reverted task creation: not found by search, still offered to the chooser (as the SQL path does). */
  hidden: boolean;
  bytes: number;
}

class Partition {
  docs: (IndexDoc | null)[] = [];
  live = 0;
  stale = 0;
  readonly title = new Map<string, number[]>();
  readonly body = new Map<string, number[]>();
  readonly grams = new Map<string, number[]>();

  add(doc: IndexDoc): number {
    const index = this.docs.push(doc) - 1;
    this.live++;
    const post = (map: Map<string, number[]>, items: Iterable<string>) => {
      for (const item of new Set(items)) { const list = map.get(item); if (list) list.push(index); else map.set(item, [index]); }
    };
    post(this.title, wordsOf(doc.title));
    post(this.body, wordsOf(doc.body.slice(0, BODY_CHARS)));
    post(this.grams, trigramsOf(doc.title));
    return index;
  }

  drop(index: number) {
    if (!this.docs[index]) return;
    this.docs[index] = null;
    this.live--;
    this.stale++;
  }
}

/** The postings one search reads from a partition, each term at most once. */
class Lookup {
  private readonly cache = new Map<string, Set<number>>();
  constructor(readonly part: Partition, private readonly work: SealedSearchWork) {}

  private read(map: Map<string, number[]>, word: string, prefix: boolean) {
    const found = new Set<number>();
    const take = (list: number[]) => { this.work.postings += list.length; for (const index of list) if (this.part.docs[index]) found.add(index); };
    if (!prefix) { const list = map.get(word); if (list) take(list); }
    else { this.work.terms += map.size; for (const [term, list] of map) if (term.startsWith(word)) take(list); }
    return found;
  }

  title(word: string, prefix: boolean) {
    const key = `t${prefix ? '*' : ' '}${word}`;
    let found = this.cache.get(key);
    if (!found) this.cache.set(key, found = this.read(this.part.title, word, prefix));
    return found;
  }

  both(word: string, prefix: boolean) {
    const key = `b${prefix ? '*' : ' '}${word}`;
    let found = this.cache.get(key);
    if (!found) {
      found = new Set(this.title(word, prefix));
      for (const index of this.read(this.part.body, word, prefix)) found.add(index);
      this.cache.set(key, found);
    }
    return found;
  }
}

const intersect = (sets: Set<number>[]): Set<number> => {
  if (!sets.length) return new Set();
  const [smallest, ...rest] = [...sets].sort((a, b) => a.size - b.size);
  return new Set([...smallest!].filter((index) => rest.every((set) => set.has(index))));
};

function hasPhrase(tokens: string[], phrase: string[]) {
  outer: for (let at = 0; at + phrase.length <= tokens.length; at++) {
    for (let offset = 0; offset < phrase.length; offset++) if (tokens[at + offset] !== phrase[offset]) continue outer;
    return true;
  }
  return false;
}

function clauseDocs(clause: Clause, lookup: Lookup): Set<number> {
  if (!clause.phrase || clause.words.length === 1) return lookup.both(clause.words[0]!, false);
  const candidates = intersect(clause.words.map((word) => lookup.both(word, false)));
  return new Set([...candidates].filter((index) => {
    const doc = lookup.part.docs[index]!;
    return hasPhrase(wordsOf(doc.title), clause.words) || hasPhrase(wordsOf(doc.body.slice(0, BODY_CHARS)), clause.words);
  }));
}

interface Hit { doc: IndexDoc; score: number }

/** The matches of a plan in one partition (before kinds and the cursor), with their scores. */
function searchPartition(part: Partition, compiled: Compiled, plan: SearchPlanRows, accept: (doc: IndexDoc) => boolean, work: SealedSearchWork): Hit[] {
  const lookup = new Lookup(part, work);
  const matched = new Set<number>();
  const similarity = new Map<number, number>();
  for (const group of compiled.groups) {
    const found = intersect(group.positive.map((clause) => clauseDocs(clause, lookup)));
    for (const clause of group.negative) for (const index of clauseDocs(clause, lookup)) found.delete(index);
    for (const index of found) matched.add(index);
  }
  if (compiled.prefix) {
    const sets = compiled.prefix.exact.map((word) => lookup.both(word, false));
    sets.push(lookup.both(compiled.prefix.last, true));
    for (const index of intersect(sets)) matched.add(index);
  }
  if (compiled.fuzzy && compiled.queryGrams.size) {
    const shared = new Map<number, number>();
    for (const gram of compiled.queryGrams) {
      const list = part.grams.get(gram);
      if (!list) continue;
      work.postings += list.length;
      for (const index of list) if (part.docs[index]) shared.set(index, (shared.get(index) ?? 0) + 1);
    }
    const needed = Math.ceil(SIMILARITY * compiled.queryGrams.size - 1e-9);
    for (const [index, count] of shared) {
      if (count < needed || matched.has(index)) continue;
      const value = wordSimilarity(compiled.queryGrams, trigramsOf(part.docs[index]!.title));
      if (value >= SIMILARITY) { matched.add(index); similarity.set(index, value); }
    }
  }
  const hits: Hit[] = [];
  const queryGrams = compiled.queryGrams;
  for (const index of matched) {
    const doc = part.docs[index]!;
    if (!accept(doc)) continue;
    work.documents++;
    let rank = 0;
    for (const term of compiled.terms) {
      if (lookup.title(term.word, term.prefix).has(index)) rank += 1;
      else if (lookup.both(term.word, term.prefix).has(index)) rank += 0.4;
    }
    rank = compiled.terms.length ? rank / compiled.terms.length : 0;
    const closeness = similarity.get(index) ?? (doc.title ? wordSimilarity(queryGrams, trigramsOf(doc.title)) : 0);
    let score = Math.round((rank + 0.5 * closeness) * 1e6);
    if (plan.number !== null && doc.kind === 'work' && doc.body.split('\n', 1)[0] === `#${plan.number}`) score += 10 * 1e6;
    hits.push({ doc, score });
  }
  return hits;
}

function mark(text: string, compiled: Compiled, range?: [number, number]): SearchTextRow {
  const parts: SearchTextRow = [];
  const push = (value: string, match: boolean) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += value; else parts.push({ text: value, match });
  };
  const [from, to] = range ?? [0, text.length];
  let cursor = from;
  for (const found of text.matchAll(WORD)) {
    const at = found.index!;
    if (at < from || at + found[0].length > to) continue;
    const word = found[0].toLowerCase();
    const hit = compiled.terms.some((term) => (term.prefix ? word.startsWith(term.word) : word === term.word));
    push(text.slice(cursor, at), false);
    push(found[0], hit);
    cursor = at + found[0].length;
  }
  push(text.slice(cursor, to), false);
  return parts;
}

/** The title whole, and a body shown whole when short or as a window around the first match when long (`ts_headline`'s shape). */
function headlines(doc: IndexDoc, compiled: Compiled): { title: SearchTextRow; snippet: SearchTextRow | null } {
  const title = mark(doc.title.slice(0, 20_000), compiled);
  if (!doc.body) return { title, snippet: null };
  if (doc.body.length <= WHOLE) return { title, snippet: mark(doc.body, compiled) };
  const text = doc.body.slice(0, 20_000);
  const found = [...text.matchAll(WORD)];
  const first = found.findIndex((word) => { const value = word[0].toLowerCase(); return compiled.terms.some((term) => (term.prefix ? value.startsWith(term.word) : value === term.word)); });
  const start = Math.max(0, (first < 0 ? 0 : first) - 6);
  const end = Math.min(found.length, start + 26);
  const range: [number, number] = [found[start]?.index ?? 0, end > 0 && found[end - 1] ? found[end - 1]!.index! + found[end - 1]![0].length : text.length];
  return { title, snippet: mark(text, compiled, range) };
}

/** One workspace's index. */
export class SealedSearchIndex {
  private readonly partitions = new Map<string, Partition>();
  private readonly byKey = new Map<string, { audience: string; index: number }>();
  bytes = 0;
  /** The first transaction id whose changes this index has not applied (`search_changes.xid`), and when it last caught up. */
  nextXid = '0';
  syncedAt = Date.now();

  constructor(readonly workspaceId: string) {}

  get size() { return this.byKey.size; }

  put(doc: IndexDoc) {
    this.remove(doc.key);
    let part = this.partitions.get(doc.audience);
    if (!part) this.partitions.set(doc.audience, part = new Partition());
    this.byKey.set(doc.key, { audience: doc.audience, index: part.add(doc) });
    this.bytes += doc.bytes;
  }

  remove(key: string) {
    const old = this.byKey.get(key);
    if (!old) return;
    const part = this.partitions.get(old.audience)!;
    this.bytes -= part.docs[old.index]?.bytes ?? 0;
    part.drop(old.index);
    this.byKey.delete(key);
    if (part.stale > 1024 && part.stale > part.live) this.compact(old.audience, part);
  }

  private compact(audience: string, part: Partition) {
    const next = new Partition();
    for (const doc of part.docs) if (doc) this.byKey.set(doc.key, { audience, index: next.add(doc) });
    this.partitions.set(audience, next);
  }

  doc(key: string) {
    const at = this.byKey.get(key);
    return at ? this.partitions.get(at.audience)!.docs[at.index] ?? null : null;
  }

  /** The chooser's text filter: the objects of one kind in a project whose title contains `q`, case-insensitively. */
  titleContains(projectId: string, kind: SearchKindRow, q: string): string[] {
    const part = this.partitions.get(`project:${projectId}`);
    const needle = q.toLowerCase();
    return part ? part.docs.flatMap((doc) => (doc && doc.kind === kind && doc.title.toLowerCase().includes(needle) ? [doc.objectId] : [])) : [];
  }

  /** Matches in the partitions of the visible audience keys only, newest version of each object kept. */
  search(visible: ReadonlySet<string>, plan: SearchPlanRows, compiled: Compiled) {
    const work: SealedSearchWork = { postings: 0, terms: 0, documents: 0 };
    const accept = (doc: IndexDoc) => {
      if (doc.hidden) return false;
      const place = plan.place;
      if (place?.type === 'project' && doc.projectId !== place.id) return false;
      if (place?.type === 'dm' && doc.audience !== `dm:${place.id}` && doc.dmId !== place.id) return false;
      if (place?.type === 'private' && !((doc.kind === 'draft' && doc.status === 'private') || ((doc.kind === 'sketch' || doc.kind === 'thought') && doc.projectId === null && doc.dmId === null))) return false;
      if (plan.author && (doc.author?.kind !== plan.author.kind || doc.author.id !== plan.author.id)) return false;
      return true;
    };
    const hits: Hit[] = [];
    for (const [audience, part] of this.partitions) {
      if (!visible.has(audience) || !part.live) continue;
      hits.push(...searchPartition(part, compiled, plan, accept, work));
    }
    return { hits, work };
  }
}

/** `YYYY-MM-DD HH:MM:SS[.ffffff]+TZ` (PostgreSQL's `timestamptz::text`) as microseconds since the epoch. */
export function pgMicros(text: string): bigint {
  const match = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?([+-]\d\d)(?::?(\d\d))?$/.exec(text);
  if (!match) throw new Error('Unreadable search timestamp');
  const [, y, mo, d, h, mi, s, f = '', oh, om = '00'] = match;
  const millis = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offset = (Math.abs(Number(oh)) * 60 + Number(om)) * (oh!.startsWith('-') ? -1 : 1) * 60_000;
  return BigInt(millis - offset) * 1000n + BigInt(f.padEnd(6, '0'));
}

// ---- Loading: placeholder rows, then the opened content of each kind.

interface Placeholder {
  id: string; doc_key: string; kind: SearchKindRow; audience_key: string; project_id: string | null; object_id: string; parent_id: string | null;
  dm_id: string | null; version: number | null; status: string | null; author_kind: 'human' | 'agent' | null; author_id: string | null; at: Date; at_key: string;
}
interface Content { title: string; body: string; number?: number | null; hidden?: boolean }

const rowsOf = async (db: DbExecutor, table: string, statement: ReturnType<typeof sql>) =>
  openRows(db, table, (await db.execute(statement)).rows as Record<string, unknown>[]);
const uuids = (ids: string[]) => sql`${sql.param(ids)}::uuid[]`;

/** Content by `object_id` (or `object_id:version`) of each placeholder's source row, opened. A source that no longer qualifies is absent. */
async function contentOf(db: DbExecutor, kind: string, rows: Placeholder[]): Promise<Map<string, Content>> {
  const ids = [...new Set(rows.map((row) => row.object_id))];
  const found = new Map<string, Content>();
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const joined = (...parts: unknown[]) => parts.filter((part): part is string => typeof part === 'string').join('\n');
  switch (kind) {
    case 'project':
      for (const r of await rowsOf(db, 'projects', sql`SELECT id, workspace_id, name FROM projects WHERE id = ANY(${uuids(ids)})`)) found.set(String(r.id), { title: str(r.name), body: '' });
      break;
    case 'message':
      // A task agent thread has no people-facing surface (#400): its messages are not findable.
      for (const r of await rowsOf(db, 'project_messages', sql`SELECT m.id, m.workspace_id, m.body FROM project_messages m
        JOIN project_conversations c ON c.id = m.conversation_id WHERE m.id = ANY(${uuids(ids)}) AND c.space <> 'agents'`)) {
        const body = str(r.body);
        found.set(String(r.id), { title: body.trim() === '' ? 'Attached files' : '', body });
      }
      break;
    case 'dm_message':
      for (const r of await rowsOf(db, 'dm_messages', sql`SELECT id, workspace_id, body FROM dm_messages WHERE id = ANY(${uuids(ids)})`)) found.set(String(r.id), { title: '', body: str(r.body) });
      break;
    case 'material': case 'doc': {
      const versions = rows.map((row) => row.version ?? 0);
      for (const r of await rowsOf(db, 'project_material_versions', sql`SELECT v.material_id, v.version, v.workspace_id, v.title, v.body, v.url
        FROM project_material_versions v JOIN unnest(${uuids(rows.map((row) => row.object_id))}, ${sql.param(versions)}::int[]) AS k(id, version)
        ON v.material_id = k.id AND v.version = k.version`)) found.set(`${r.material_id}:${r.version}`, { title: str(r.title), body: joined(r.body, r.url) });
      break;
    }
    case 'work':
      for (const r of await rowsOf(db, 'project_work_items', sql`SELECT id, workspace_id, number, title, outcome, blocker, creation_reverted_at IS NOT NULL AS reverted
        FROM project_work_items WHERE id = ANY(${uuids(ids)})`)) {
        found.set(String(r.id), { title: str(r.title), body: joined(`#${r.number}`, str(r.outcome) === '' ? null : r.outcome, r.blocker), number: Number(r.number), hidden: r.reverted === true });
      }
      break;
    case 'decision':
      for (const r of await rowsOf(db, 'project_decisions', sql`SELECT id, workspace_id, title, rationale FROM project_decisions WHERE id = ANY(${uuids(ids)})`)) found.set(String(r.id), { title: str(r.title), body: str(r.rationale) });
      break;
    case 'result':
      for (const r of await rowsOf(db, 'project_results', sql`SELECT id, workspace_id, title, evidence FROM project_results WHERE id = ANY(${uuids(ids)})`)) found.set(String(r.id), { title: str(r.title), body: str(r.evidence) });
      break;
    case 'sketch':
      for (const r of await rowsOf(db, 'sketches', sql`SELECT id, workspace_id, title FROM sketches WHERE id = ANY(${uuids(ids)})`)) found.set(String(r.id), { title: str(r.title), body: '' });
      break;
    case 'thought':
      for (const r of await rowsOf(db, 'sketch_thoughts', sql`SELECT id, workspace_id, text FROM sketch_thoughts WHERE id = ANY(${uuids(ids)})`)) found.set(String(r.id), { title: str(r.text), body: '' });
      break;
    case 'draft':
      for (const r of await rowsOf(db, 'drafts', sql`SELECT id, workspace_id, title, body FROM drafts WHERE id = ANY(${uuids(ids)})`)) found.set(String(r.id), { title: str(r.title), body: str(r.body) });
      break;
    default: break;
  }
  return found;
}

async function docsOf(db: DbExecutor, workspaceId: string, placeholders: Placeholder[]): Promise<IndexDoc[]> {
  const byKind = new Map<string, Placeholder[]>();
  for (const row of placeholders) { const list = byKind.get(row.kind); if (list) list.push(row); else byKind.set(row.kind, [row]); }
  const docs: IndexDoc[] = [];
  for (const [kind, rows] of byKind) {
    const content = await contentOf(db, kind, rows);
    for (const row of rows) {
      const found = content.get(kind === 'material' || kind === 'doc' ? `${row.object_id}:${row.version}` : row.object_id);
      if (!found) continue;
      docs.push({ id: row.id, key: row.doc_key, kind: row.kind, audience: row.audience_key, workspaceId, projectId: row.project_id, objectId: row.object_id,
        parentId: row.parent_id, dmId: row.dm_id, version: row.version, status: row.status,
        author: row.author_kind && row.author_id ? { kind: row.author_kind, id: row.author_id } : null,
        at: row.at instanceof Date ? row.at : new Date(row.at), atKey: row.at_key, atMicros: pgMicros(row.at_key), title: found.title, body: found.body,
        number: found.number ?? null, hidden: found.hidden === true, bytes: Buffer.byteLength(found.title) + Buffer.byteLength(found.body) });
    }
  }
  return docs;
}

const PLACEHOLDERS = sql`id::text AS id, doc_key, kind, audience_key, project_id::text AS project_id, object_id, parent_id::text AS parent_id, dm_id::text AS dm_id,
  version, status, author_kind, author_id, at, at::text AS at_key`;

class TooLargeError extends Error {}

const maxBytes = (env: NodeJS.ProcessEnv = process.env) => {
  const value = Number(env.FLUX_SEALED_SEARCH_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : SEALED_SEARCH_DEFAULT_MAX_BYTES;
};

async function currentXmin(db: DbExecutor): Promise<string> {
  return String(((await db.execute(sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`)).rows[0] as { xmin: string }).xmin);
}

async function build(db: DbExecutor, workspaceId: string): Promise<SealedSearchIndex> {
  const index = new SealedSearchIndex(workspaceId);
  const limit = maxBytes();
  // Every transaction below this id has finished before the rows are read; later ones are applied again by the next catch-up.
  index.nextXid = await currentXmin(db);
  let after = 0n;
  for (;;) {
    const rows = (await db.execute(sql`SELECT ${PLACEHOLDERS} FROM search_documents WHERE workspace_id = ${workspaceId}::uuid AND sealed AND id > ${after.toString()}::bigint
      ORDER BY id LIMIT ${CHUNK}`)).rows as unknown as Placeholder[];
    if (!rows.length) break;
    for (const doc of await docsOf(db, workspaceId, rows)) {
      index.put(doc);
      if (index.bytes > limit) throw new TooLargeError();
    }
    after = BigInt(rows[rows.length - 1]!.id);
  }
  index.syncedAt = Date.now();
  return index;
}

/** Applies the committed changes since the last catch-up: reloads each changed document, or removes it. */
async function catchUp(db: DbExecutor, index: SealedSearchIndex) {
  const limit = maxBytes();
  const result = (await db.execute(sql`WITH s AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin)
    SELECT s.xmin::text AS xmin, c.doc_key FROM s LEFT JOIN search_changes c
      ON c.workspace_id = ${index.workspaceId}::uuid AND c.xid >= ${index.nextXid}::xid8 AND c.xid < s.xmin`)).rows as { xmin: string; doc_key: string | null }[];
  const keys = [...new Set(result.flatMap((row) => (row.doc_key ? [row.doc_key] : [])))];
  for (let from = 0; from < keys.length; from += CHUNK) {
    const slice = keys.slice(from, from + CHUNK);
    const rows = (await db.execute(sql`SELECT ${PLACEHOLDERS} FROM search_documents WHERE workspace_id = ${index.workspaceId}::uuid AND sealed
      AND doc_key = ANY(${sql.param(slice)}::text[])`)).rows as unknown as Placeholder[];
    const docs = await docsOf(db, index.workspaceId, rows);
    const present = new Set(docs.map((doc) => doc.key));
    for (const key of slice) if (!present.has(key)) index.remove(key);
    for (const doc of docs) { index.put(doc); if (index.bytes > limit) throw new TooLargeError(); }
  }
  if (result[0] && BigInt(result[0].xmin) > BigInt(index.nextXid)) index.nextXid = result[0].xmin;
  index.syncedAt = Date.now();
}

interface Entry { index: SealedSearchIndex | null; tooLarge: boolean; building: Promise<void> | null }
const entries = new Map<string, Entry>();

/** Drops the in-memory index of one workspace, or of all (null): on lock, and when the process drops its keys. */
export function dropSealedSearchIndex(workspaceId: string | null) {
  if (workspaceId === null) entries.clear(); else entries.delete(workspaceId);
}

/** Workspaces with an index in this process (tests, diagnostics). */
export const sealedSearchIndexedWorkspaces = () => [...entries].filter(([, entry]) => entry.index).map(([id]) => id);

/** The index of an unlocked encrypted workspace, built or caught up now; null when it is too large to hold in memory. */
async function ensure(db: DbExecutor, workspaceId: string): Promise<SealedSearchIndex | null> {
  let entry = entries.get(workspaceId);
  if (!entry) entries.set(workspaceId, entry = { index: null, tooLarge: false, building: null });
  const current = entry;
  if (current.tooLarge) return null;
  if (current.building) await current.building;
  if (current.tooLarge) return null;
  if (current.index && Date.now() - current.index.syncedAt > REBUILD_AFTER_MS) current.index = null;
  const work = async () => {
    try {
      if (!current.index) current.index = await build(db, workspaceId);
      else await catchUp(db, current.index);
    } catch (error) {
      current.index = null;
      if (error instanceof TooLargeError) current.tooLarge = true; else { if (entries.get(workspaceId) === current) entries.delete(workspaceId); throw error; }
    }
  };
  // Concurrent searches of one workspace share one catch-up.
  if (!current.building) {
    const run = work().finally(() => { if (current.building === run) current.building = null; });
    current.building = run;
  }
  await current.building;
  return current.index;
}

// ---- Rows for the page.

const comparePosition = (a: Hit, b: Hit) => (b.score - a.score) || (a.doc.atMicros === b.doc.atMicros ? 0 : a.doc.atMicros < b.doc.atMicros ? 1 : -1)
  || (BigInt(a.doc.id) === BigInt(b.doc.id) ? 0 : BigInt(a.doc.id) < BigInt(b.doc.id) ? 1 : -1);

const scoreText = (micros: number) => (micros / 1e6).toFixed(6);

async function hydrate(db: DbExecutor, index: SealedSearchIndex, hits: Hit[], compiled: Compiled, visible: ReadonlySet<string>, reader: string): Promise<SearchRowRecord[]> {
  if (!hits.length) return [];
  const ids = (pick: (doc: IndexDoc) => string | null | undefined) => [...new Set(hits.flatMap(({ doc }) => { const value = pick(doc); return value ? [value] : []; }))];
  const get = async <T>(statement: ReturnType<typeof sql>) => (await db.execute(statement)).rows as T[];
  const workspaceNames = new Map((await get<{ id: string; name: string }>(sql`SELECT id::text AS id, name FROM workspaces WHERE id = ${index.workspaceId}::uuid`)).map((r) => [r.id, r.name]));
  const humans = ids((doc) => (doc.author?.kind === 'human' ? doc.author.id : null));
  const people = humans.length ? new Map((await get<{ id: string; name: string }>(sql`SELECT id, name FROM auth_users WHERE id = ANY(${sql.param(humans)}::text[])`)).map((r) => [r.id, r.name])) : new Map<string, string>();
  const agentIds = ids((doc) => (doc.author?.kind === 'agent' ? doc.author.id : null)).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const agents = agentIds.length ? new Map((await get<{ id: string; name: string }>(sql`SELECT id::text AS id, name FROM agents WHERE id = ANY(${uuids(agentIds)})`)).map((r) => [r.id, r.name])) : new Map<string, string>();
  const materialIds = ids((doc) => (doc.kind === 'material' || doc.kind === 'doc' ? doc.objectId : null));
  const versions = materialIds.length ? new Map((await get<{ id: string; current_version: number }>(sql`SELECT id::text AS id, current_version FROM project_materials WHERE id = ANY(${uuids(materialIds)})`)).map((r) => [r.id, Number(r.current_version)])) : new Map<string, number>();
  // A DM is named by its title (sealed), else by the other people in it.
  const dmIds = ids((doc) => (doc.kind === 'dm_message' ? doc.parentId : doc.dmId));
  const dmNames = new Map<string, string | null>();
  if (dmIds.length) {
    const dms = await rowsOf(db, 'dms', sql`SELECT id, workspace_id, kind, pair_key, title FROM dms WHERE id = ANY(${uuids(dmIds)})`);
    const bare = dms.filter((dm) => !dm.title);
    const members = bare.length ? await get<{ dm_id: string; id: string; name: string }>(sql`SELECT dp.dm_id::text AS dm_id, u.id, u.name FROM dm_participants dp JOIN auth_users u ON u.id = dp.user_id
      WHERE dp.dm_id = ANY(${uuids(bare.map((dm) => String(dm.id)))}) AND u.id <> ${reader}`) : [];
    const pairIds = bare.filter((dm) => dm.kind === 'pair').flatMap((dm) => String(dm.pair_key).split(':')).filter((id) => id !== reader);
    const pairNames = pairIds.length ? new Map((await get<{ id: string; name: string }>(sql`SELECT id, name FROM auth_users WHERE id = ANY(${sql.param(pairIds)}::text[])`)).map((r) => [r.id, r.name])) : new Map<string, string>();
    for (const dm of dms) {
      const id = String(dm.id);
      if (dm.title) dmNames.set(id, String(dm.title));
      else if (dm.kind === 'pair') dmNames.set(id, String(dm.pair_key).split(':').filter((user) => user !== reader).map((user) => pairNames.get(user)).find(Boolean) ?? null);
      else dmNames.set(id, members.filter((m) => m.dm_id === id).map((m) => m.name).sort().join(', ') || null);
    }
  }
  return hits.map(({ doc, score }) => {
    const { title, snippet } = headlines(doc, compiled);
    const dmId = doc.kind === 'dm_message' ? doc.parentId : doc.dmId;
    const project = doc.projectId && visible.has(`project:${doc.projectId}`) ? index.doc(`project:${doc.projectId}`) : null;
    return {
      position: { score: scoreText(score), at: doc.atKey, id: doc.id },
      kind: doc.kind, workspaceId: doc.workspaceId, workspaceName: workspaceNames.get(doc.workspaceId) ?? null, objectId: doc.objectId, parentId: doc.parentId,
      projectId: doc.projectId, projectName: project?.title ?? null, dmId, dmName: dmId ? dmNames.get(dmId) ?? null : null,
      sketchTitle: doc.kind === 'thought' && doc.parentId ? index.doc(`sketch:${doc.parentId}`)?.title ?? null : null,
      workNumber: doc.number, version: doc.version, currentVersion: versions.get(doc.objectId) ?? null, status: doc.status, title, snippet, hasBody: doc.body.length > 0,
      authorName: doc.author ? (doc.author.kind === 'human' ? people.get(doc.author.id) : agents.get(doc.author.id)) ?? null : null,
      author: doc.author, at: doc.at,
    };
  });
}

export interface SealedSearchResult {
  rows: SearchRowRecord[];
  counts: Map<SearchKindRow, number>;
  capped: boolean;
  /** Encrypted workspaces too large to hold in memory (`FLUX_SEALED_SEARCH_MAX_BYTES`). */
  unavailable: string[];
  work: SealedSearchWork;
}

/** Search across the unlocked encrypted workspaces among `audiences`. A locked workspace contributes nothing (and loses its index). */
export function sealedSearchRows(db: DbExecutor) {
  return {
    async search(audiences: SearchAudienceRows[], plan: SearchPlanRows, cap: number): Promise<SealedSearchResult> {
      const result: SealedSearchResult = { rows: [], counts: new Map(), capped: false, unavailable: [], work: { postings: 0, terms: 0, documents: 0 } };
      const compiled = compile(plan);
      const hits: Hit[] = [];
      const owners = new Map<Hit, SealedSearchIndex>();
      const visibleByIndex = new Map<SealedSearchIndex, Set<string>>();
      for (const workspaceId of new Set(audiences.map((audience) => audience.workspaceId))) {
        let index: SealedSearchIndex | null;
        try {
          if (!(await sealOf(db, workspaceId, { write: false })).sealed) continue;
          index = await ensure(db, workspaceId);
        } catch (error) {
          if ((error as { code?: unknown }).code === 'WORKSPACE_LOCKED') { dropSealedSearchIndex(workspaceId); continue; }
          throw error;
        }
        if (!index) { result.unavailable.push(workspaceId); continue; }
        const mine = audiences.filter((audience) => audience.workspaceId === workspaceId && audience.type !== 'members');
        if (!mine.length) continue;
        // Access before ranking: the keys the policy allows now; the index reads only those partitions.
        const keys = new Set(((await db.execute(sql`SELECT unnest(ARRAY(${sql.join(mine.map((audience) => AUDIENCE_KEYS[audience.type](audience)), sql` UNION ALL `)})) AS key`)).rows as { key: string }[]).map((row) => row.key));
        visibleByIndex.set(index, keys);
        const found = index.search(keys, plan, compiled);
        result.work.postings += found.work.postings; result.work.terms += found.work.terms; result.work.documents += found.work.documents;
        for (const hit of found.hits) { hits.push(hit); owners.set(hit, index); }
      }
      // Counts: every match without the kind filter and the cursor, at most cap + 1 rows, objects counted once.
      const sample = hits.slice(0, cap + 1);
      result.capped = hits.length > cap;
      const seen = new Set<string>();
      for (const { doc } of sample) {
        const id = `${doc.kind}:${doc.objectId}`;
        if (!seen.has(id)) { seen.add(id); result.counts.set(doc.kind, (result.counts.get(doc.kind) ?? 0) + 1); }
      }
      // One result per object: of several matching versions, the newest.
      const newest = new Map<string, Hit>();
      for (const hit of hits) {
        if (plan.kinds?.length && !plan.kinds.includes(hit.doc.kind)) continue;
        const id = `${hit.doc.kind}:${hit.doc.objectId}`;
        const old = newest.get(id);
        if (!old || (hit.doc.version ?? -1) > (old.doc.version ?? -1)) newest.set(id, hit);
      }
      const after = plan.after ? { score: Math.round(Number(plan.after.score) * 1e6), at: pgMicros(plan.after.at), id: BigInt(plan.after.id) } : null;
      const page = [...newest.values()].filter(({ doc, score }) => !after || score < after.score
        || (score === after.score && (doc.atMicros < after.at || (doc.atMicros === after.at && BigInt(doc.id) < after.id))))
        .sort(comparePosition).slice(0, plan.limit + 1);
      // Hydrate per index (one workspace each).
      for (const [index, keys] of visibleByIndex) {
        const mine = page.filter((hit) => owners.get(hit) === index);
        result.rows.push(...await hydrate(db, index, mine, compiled, keys, plan.reader));
      }
      result.rows.sort((a, b) => (Number(b.position.score) - Number(a.position.score)) || (pgMicros(b.position.at) === pgMicros(a.position.at) ? 0 : pgMicros(b.position.at) > pgMicros(a.position.at) ? 1 : -1)
        || (BigInt(b.position.id) > BigInt(a.position.id) ? 1 : -1));
      return result;
    },

    /** The chooser's title filter (a task, decision or result of one project whose title contains `q`): null when the workspace is plain, locked or too large. */
    async titleMatches(workspaceId: string, projectId: string, kind: 'work' | 'decision' | 'result', q: string): Promise<{ ids: string[] } | { unavailable: true } | null> {
      try {
        if (!(await sealOf(db, workspaceId, { write: false })).sealed) return null;
        const index = await ensure(db, workspaceId);
        if (!index) return { unavailable: true };
        return { ids: index.titleContains(projectId, kind, q) };
      } catch (error) {
        if ((error as { code?: unknown }).code === 'WORKSPACE_LOCKED') { dropSealedSearchIndex(workspaceId); throw error; }
        throw error;
      }
    },
  };
}

/** Deletes the change log older than {@link SEALED_SEARCH_CHANGE_RETENTION_MS} (hourly job). An index idle for longer is rebuilt, not caught up. */
export async function pruneSearchChanges(db: DbExecutor): Promise<number> {
  const result = await db.execute(sql`DELETE FROM search_changes WHERE at < now() - ${SEALED_SEARCH_CHANGE_RETENTION_MS / 1000} * interval '1 second'`);
  return result.rowCount ?? 0;
}
