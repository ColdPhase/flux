import { sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Search needs its own read-only transaction to pin the plan (see {@link planned}). */
export type SearchExecutor = Pick<NodePgDatabase<typeof schema>, 'select' | 'execute' | 'transaction'>;

/**
 * Rows for search (issue #114). They satisfy the `SearchRepository` port of
 * `packages/core/src/search/ports.ts` structurally and make no access decisions: every statement
 * receives the audiences the caller may read now, each with the access policy's own list
 * condition (`visibleFilter`), and composes them into its WHERE clause, so ranking, the limit,
 * counts and highlighting only ever see visible rows. `search_documents` (migration 0014) is kept
 * current by triggers in the same transaction as every write.
 */

/** `search_documents.kind` (the contracts' `SearchKind`; this package does not depend on contracts). */
export type SearchKindRow = 'message' | 'dm_message' | 'material' | 'doc' | 'work' | 'decision' | 'result' | 'sketch' | 'thought' | 'draft' | 'person';
type SearchKind = SearchKindRow;
/** Highlighted text: plain and matched parts. */
export type SearchTextRow = { text: string; match: boolean }[];
type SearchText = SearchTextRow;

/** The object that carries the permission of a search row (`search_documents.audience_key`). */
export type SearchAudienceType = 'project' | 'dm' | 'sketch' | 'draft' | 'members';

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
const AUDIENCE_KEYS: Record<SearchAudienceType, (audience: SearchAudienceRows) => SQL> = {
  project: ({ condition }) => sql`SELECT 'project:' || ${schema.projects.id} FROM ${schema.projects} WHERE ${condition}`,
  dm: ({ condition }) => sql`SELECT 'dm:' || ${schema.dms.id} FROM ${schema.dms} WHERE ${condition}`,
  sketch: ({ condition }) => sql`SELECT 'sketch:' || ${schema.sketches.id} FROM ${schema.sketches} WHERE ${condition}`,
  draft: ({ condition }) => sql`SELECT 'draft:' || ${schema.drafts.id} FROM ${schema.drafts} WHERE ${condition}`,
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
  /** The DM of a DM message, or of a sketch or thought that belongs to a DM (#96). */
  dmId: string | null;
  dmName: string | null;
  sketchTitle: string | null;
  version: number | null;
  currentVersion: number | null;
  status: string | null;
  title: SearchText;
  snippet: SearchText | null;
  hasBody: boolean;
  authorName: string | null;
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

function visibleKeys(audiences: SearchAudienceRows[]): SQL {
  return sql`ARRAY(${sql.join(audiences.map((audience) => AUDIENCE_KEYS[audience.type](audience)), sql` UNION ALL `)})`;
}

/** Everything a hit must satisfy apart from the cursor. `withKinds` is false for the per-type counts. */
function hitConditions(plan: SearchPlanRows, withKinds: boolean): SQL {
  const conditions: SQL[] = [
    sql`sd.keys && (SELECT lookups FROM aud)`,
    sql`sd.audience_key = ANY ((SELECT keys FROM aud)::text[])`,
    plan.fuzzy ? sql`(sd.tsv @@ ${tsquery(plan)} OR sd.title %> ${plan.text})` : sql`sd.tsv @@ ${tsquery(plan)}`,
  ];
  if (withKinds && plan.kinds?.length) conditions.push(sql`sd.kind IN (${sql.join(plan.kinds.map((kind) => sql`${kind}`), sql`, `)})`);
  const place = plan.place;
  if (place?.type === 'project') conditions.push(sql`sd.project_id = ${place.id}::uuid`);
  // A DM's own messages carry its audience; its sketches and thoughts keep the sketch audience
  // (still checked above) and name the DM (#96).
  if (place?.type === 'dm') conditions.push(sql`(sd.audience_key = ${`dm:${place.id}`} OR sd.dm_id = ${place.id}::uuid)`);
  if (place?.type === 'private') conditions.push(sql`((sd.kind = 'draft' AND sd.status = 'private') OR (sd.kind IN ('sketch', 'thought') AND sd.project_id IS NULL AND sd.dm_id IS NULL))`);
  if (plan.author) conditions.push(sql`sd.author_kind = ${plan.author.kind} AND sd.author_id = ${plan.author.id}`);
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

function pageStatement(audiences: SearchAudienceRows[], plan: SearchPlanRows): SQL {
  const q = tsquery(plan);
  const after = plan.after
    ? sql`WHERE (hits.score, hits.at, hits.id) < (${plan.after.score}::numeric, ${plan.after.at}::timestamptz, ${plan.after.id}::bigint)`
    : sql``;
  const clean = (column: SQL) => sql`translate(left(${column}, ${HEADLINE_INPUT}), ${START + STOP}, '')`;
  return sql`
    WITH ${audienceCte(audiences, plan)},
    matched AS (
      SELECT sd.id, sd.kind, sd.workspace_id, sd.object_id, sd.parent_id, sd.project_id, sd.dm_id, sd.version, sd.status, sd.title, sd.body,
        sd.author_kind, sd.author_id, sd.at,
        round((ts_rank(sd.tsv, ${q}) + 0.5 * word_similarity(${plan.text}, sd.title))::numeric, 6)${exactNumber(plan)} AS score,
        row_number() OVER (PARTITION BY sd.kind, sd.object_id ORDER BY sd.version DESC NULLS LAST) AS newest
      FROM search_documents sd
      WHERE ${hitConditions(plan, true)}
    ),
    -- One result per object: of several matching versions of a material, the newest.
    hits AS (SELECT * FROM matched WHERE newest = 1)
    SELECT h.id::text AS id, h.score::text AS score, h.at::text AS at_key, h.at, h.kind, h.workspace_id, w.name AS workspace_name,
      h.object_id, h.parent_id, h.project_id, coalesce(h.dm_id, d.id) AS dm_id, p.name AS project_name, h.version, pm.current_version, h.status, sk.title AS sketch_title,
      h.author_kind, h.author_id, coalesce(au.name, ag.name) AS author_name, length(h.body) > 0 AS has_body,
      ts_headline('simple', ${clean(sql`h.title`)}, ${q}, ${TITLE_OPTIONS}) AS title_headline,
      CASE WHEN length(h.body) = 0 THEN NULL
        WHEN length(h.body) <= ${WHOLE} THEN ts_headline('simple', ${clean(sql`h.body`)}, ${q}, ${TITLE_OPTIONS})
        ELSE ts_headline('simple', ${clean(sql`h.body`)}, ${q}, ${BODY_OPTIONS}) END AS body_headline,
      CASE WHEN d.id IS NULL THEN NULL WHEN d.title IS NOT NULL THEN d.title
        WHEN d.kind = 'pair' THEN (SELECT u.name FROM auth_users u WHERE u.id IN (split_part(d.pair_key, ':', 1), split_part(d.pair_key, ':', 2)) AND u.id <> ${plan.reader} LIMIT 1)
        ELSE (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM dm_participants dp JOIN auth_users u ON u.id = dp.user_id WHERE dp.dm_id = d.id AND dp.user_id <> ${plan.reader})
      END AS dm_name
    FROM (SELECT * FROM hits ${after} ORDER BY hits.score DESC, hits.at DESC, hits.id DESC LIMIT ${plan.limit + 1}) h
    LEFT JOIN projects p ON p.id = h.project_id AND ('project:' || p.id) = ANY ((SELECT keys FROM aud)::text[])
    LEFT JOIN workspaces w ON w.id = h.workspace_id
    LEFT JOIN auth_users au ON h.author_kind = 'human' AND au.id = h.author_id
    LEFT JOIN agents ag ON ag.id = (CASE WHEN h.author_kind = 'agent' THEN h.author_id::uuid END)
    LEFT JOIN project_materials pm ON pm.id = (CASE WHEN h.kind IN ('material', 'doc') THEN h.object_id::uuid END)
    LEFT JOIN sketches sk ON h.kind = 'thought' AND sk.id = h.parent_id
    LEFT JOIN dms d ON d.id = (CASE WHEN h.kind = 'dm_message' THEN h.parent_id ELSE h.dm_id END)
    ORDER BY h.score DESC, h.at DESC, h.id DESC`;
}

function countStatement(audiences: SearchAudienceRows[], plan: SearchPlanRows, cap: number): SQL {
  return sql`
    WITH ${audienceCte(audiences, plan)}
    SELECT kind, count(DISTINCT object_id)::int AS n, count(*)::int AS sampled
    FROM (SELECT sd.kind, sd.object_id FROM search_documents sd WHERE ${hitConditions(plan, false)} LIMIT ${cap + 1}) x GROUP BY kind`;
}

interface PageRow {
  id: string; score: string; at_key: string; at: Date | string; kind: SearchKind; workspace_id: string; workspace_name: string | null;
  object_id: string; parent_id: string | null; project_id: string | null; dm_id: string | null; project_name: string | null; version: number | null;
  current_version: number | null; status: string | null; sketch_title: string | null; author_name: string | null; has_body: boolean;
  author_kind: 'human' | 'agent' | null; author_id: string | null;
  title_headline: string | null; body_headline: string | null; dm_name: string | null;
}

/**
 * Runs a search statement in its own read-only transaction with sequential scans disabled, so
 * PostgreSQL always reaches `search_documents` through the audience-leading GIN indexes, also
 * while the table is small. The work then depends only on the audiences the reader may see.
 */
async function planned(db: SearchExecutor, statement: SQL) {
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

export function searchRows(db: SearchExecutor) {
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
      return (result.rows as unknown as PageRow[]).map((row) => ({
        position: { score: row.score, at: row.at_key, id: row.id },
        kind: row.kind,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        objectId: row.object_id,
        parentId: row.parent_id,
        projectId: row.project_id,
        projectName: row.project_name,
        dmId: row.dm_id,
        dmName: row.dm_name,
        sketchTitle: row.sketch_title,
        version: row.version,
        currentVersion: row.current_version,
        status: row.status,
        title: highlightParts(row.title_headline ?? ''),
        snippet: row.body_headline ? highlightParts(row.body_headline) : null,
        hasBody: row.has_body,
        authorName: row.author_name,
        author: row.author_kind && row.author_id ? { kind: row.author_kind, id: row.author_id } : null,
        at: row.at instanceof Date ? row.at : new Date(row.at),
      }));
    },

    /** Visible matches per kind, over every kind, counting at most `cap + 1` rows. */
    async counts(audiences: SearchAudienceRows[], plan: SearchPlanRows, cap: number) {
      const counts = new Map<SearchKind, number>();
      if (!audiences.length) return { counts, capped: false };
      const result = await planned(db, countStatement(audiences, plan, cap));
      let total = 0;
      for (const row of result.rows as unknown as { kind: SearchKind; n: number; sampled: number }[]) { counts.set(row.kind, row.n); total += row.sampled; }
      // Counting stopped when the sample of `cap + 1` rows was full (versions of one material count once).
      return { counts, capped: total > cap };
    },

    /** Test support: what the page and count statements of this plan read, and the keys each index scan looks up. */
    async explain(audiences: SearchAudienceRows[], plan: SearchPlanRows, cap: number) {
      if (!audiences.length) return { rows: 0, indexRows: 0, searchBuffers: 0, buffers: 0, indexScans: 0, lookups: 0, nodes: [] as string[] };
      const page = await examined(db, pageStatement(audiences, plan));
      const count = await examined(db, countStatement(audiences, plan, cap));
      const keys = await planned(db, sql`WITH ${audienceCte(audiences, plan)} SELECT cardinality(lookups) AS n FROM aud`);
      return { rows: page.rows + count.rows, indexRows: page.indexRows + count.indexRows, searchBuffers: page.searchBuffers + count.searchBuffers,
        buffers: page.buffers + count.buffers, indexScans: page.indexScans + count.indexScans,
        lookups: Number((keys.rows[0] as { n: number | string }).n), nodes: [...page.nodes, '|', ...count.nodes] };
    },
  };
}
