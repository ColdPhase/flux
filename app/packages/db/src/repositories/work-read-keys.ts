import { sql, type SQL } from 'drizzle-orm';
import type { PrincipalRef, WorkGroup, WorkObjectType, WorkReadCursor } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/** Structural counterpart of core's normalized selector; DB never imports the core layer. */
export type NativeWorkViewSelector =
  | { purpose: 'tasks'; group: 'all' | WorkGroup; mine: boolean }
  | { purpose: 'choices'; choice: 'accepted_decisions' | 'pivot_work'; q: string }
  | { purpose: 'choices'; choice: 'result_work'; q: string; selected?: string }
  | { purpose: 'choices'; choice: 'parked_work'; q: string; decisionId: string }
  | { purpose: 'choices'; choice: 'doc_refs'; q: string; kind: WorkObjectType };
export type NativeWorkReadKey = { kind: WorkObjectType; id: string; rank: number; createdAt: string };
export interface NativeWorkKeyPage { items: NativeWorkReadKey[]; total: number; before: number; hasBefore: boolean; hasAfter: boolean }

const w = schema.projectWorkItems, d = schema.projectDecisions, r = schema.projectResults;
const unfinished = sql`${w.status} IN ('open', 'in_progress', 'blocked')`;
const parked = sql`(${w.parkedAt} IS NOT NULL AND ${w.parkedByDecisionId} IS NOT NULL)`;
/** A task whose creation was undone (#238) is history: never in a task group, count or chooser. */
const active = sql`${w.creationRevertedAt} IS NULL`;
const workRank = sql`CASE WHEN ${unfinished} AND ${parked} THEN 4 WHEN ${w.status} = 'in_progress' THEN 1 WHEN ${w.status} = 'blocked' THEN 2 WHEN ${w.status} = 'open' THEN 3 ELSE 5 END`;
const decisionRank = sql`CASE ${d.status} WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 6 ELSE 7 END`;

function literalTitle(column: SQL, q: string) {
  return q ? sql`${column} ILIKE ${'%'+q.replace(/[\\%_]/g, '\\$&')+'%'} ESCAPE ${'\\'}` : sql`true`;
}
export function nativeWorkViewKeySource(projectId: string, actor: PrincipalRef, selection: NativeWorkViewSelector): SQL {
  const parts: SQL[] = [];
  if (selection.purpose === 'tasks') {
    const group = selection.group;
    if (group === 'all' || ['in_progress', 'blocked', 'open', 'parked', 'finished'].includes(group)) {
      const predicate = group === 'all' ? sql`true` : group === 'parked' ? sql`${unfinished} AND ${parked}` : group === 'finished' ? sql`${w.status} IN ('done', 'not_pursued')` : sql`${w.status} = ${group} AND NOT ${parked}`;
      const owner = !selection.mine ? sql`true` : actor.kind === 'human' ? sql`${w.ownerUserId} = ${actor.id}` : sql`${w.ownerUserId} IS NULL AND ${w.ownerAgentId} = ${actor.id}::uuid`;
      parts.push(sql`SELECT 'work'::text AS kind, ${w.id} AS id, ${w.createdAt} AS created_at, ${workRank} AS rank FROM ${w} WHERE ${w.projectId} = ${projectId}::uuid AND ${active} AND (${predicate}) AND (${owner})`);
    }
    if (group === 'all' || group === 'needs' || group === 'rules') {
      const predicate = group === 'needs' ? sql`${d.status} = 'proposed'` : group === 'rules' ? sql`${d.status} IN ('accepted', 'superseded')` : sql`true`;
      const mine = selection.mine ? sql`${d.status} = 'proposed'` : sql`true`;
      parts.push(sql`SELECT 'decision'::text AS kind, ${d.id} AS id, ${d.createdAt} AS created_at, ${decisionRank} AS rank FROM ${d} WHERE ${d.projectId} = ${projectId}::uuid AND (${predicate}) AND (${mine})`);
    }
    if (group === 'all' || group === 'results') {
      const mine = selection.mine ? sql`${r.createdByKind} = ${actor.kind} AND ${r.createdById} = ${actor.id}` : sql`true`;
      parts.push(sql`SELECT 'result'::text AS kind, ${r.id} AS id, ${r.createdAt} AS created_at, 8 AS rank FROM ${r} WHERE ${r.projectId} = ${projectId}::uuid AND (${mine})`);
    }
  } else if (selection.choice === 'accepted_decisions' || (selection.choice === 'doc_refs' && selection.kind === 'decision')) {
    const predicate = selection.choice === 'accepted_decisions' ? sql`${d.status} = 'accepted'` : sql`true`;
    parts.push(sql`SELECT 'decision'::text AS kind, ${d.id} AS id, ${d.createdAt} AS created_at, 0 AS rank FROM ${d} WHERE ${d.projectId} = ${projectId}::uuid AND (${predicate}) AND (${literalTitle(sql`${d.title}`, selection.q)})`);
  } else if (selection.choice === 'doc_refs' && selection.kind === 'result') {
    parts.push(sql`SELECT 'result'::text AS kind, ${r.id} AS id, ${r.createdAt} AS created_at, 0 AS rank FROM ${r} WHERE ${r.projectId} = ${projectId}::uuid AND (${literalTitle(sql`${r.title}`, selection.q)})`);
  } else {
    const predicate = selection.choice === 'doc_refs' ? sql`true` : selection.choice === 'pivot_work' ? sql`${unfinished} AND NOT ${parked}` : selection.choice === 'parked_work' ? sql`${unfinished} AND ${parked} AND ${w.parkedByDecisionId} = ${selection.decisionId}::uuid` : unfinished;
    parts.push(sql`SELECT 'work'::text AS kind, ${w.id} AS id, ${w.createdAt} AS created_at, 0 AS rank FROM ${w} WHERE ${w.projectId} = ${projectId}::uuid AND ${active} AND (${predicate}) AND (${literalTitle(sql`${w.title}`, selection.q)})`);
  }
  return sql.join(parts, sql` UNION ALL `);
}

/** Mixed native order: rank ASC, raw timestamp DESC, UUID DESC. Never derive a key from Date. */
function preceding(key: WorkReadCursor['boundary']) {
  return sql`rank < ${key.rank} OR (rank = ${key.rank} AND (created_at, id) > (${key.createdAt}::timestamptz, ${key.id}::uuid))`;
}
function following(key: WorkReadCursor['boundary']) {
  return sql`rank > ${key.rank} OR (rank = ${key.rank} AND (created_at, id) < (${key.createdAt}::timestamptz, ${key.id}::uuid))`;
}
function safeCount(value: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Native work count exceeds the public range');
  return result;
}

/** Private key markers include edge/message; public work rows retain native kinds only. */
export interface NativeReadKeyPage<Kind extends string> {
  items: { kind: Kind; id: string; rank: number; createdAt: string }[];
  total: number; before: number; hasBefore: boolean; hasAfter: boolean;
}
/** One observation: overfetch only one lightweight key, then hydrate <=limit returned keys. */
export async function nativeReadKeyWindow<Kind extends string>(db: DbExecutor, selected: SQL, limit: number, cursor?: WorkReadCursor, ascending = false): Promise<NativeReadKeyPage<Kind>> {
  const precedingKey = ascending ? (key: WorkReadCursor['boundary']) => sql`(created_at, id) < (${key.createdAt}::timestamptz, ${key.id}::uuid)` : preceding;
  const followingKey = ascending ? (key: WorkReadCursor['boundary']) => sql`(created_at, id) > (${key.createdAt}::timestamptz, ${key.id}::uuid)` : following;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid bounded native key limit');
  // Every query/count in this observation owns the same continuation across awaits.
  const ownedCursor = cursor ? { direction: cursor.direction, boundary: { ...cursor.boundary } } : undefined;
  const forward = ownedCursor?.direction !== 'previous';
  const continuation = ownedCursor ? forward ? followingKey(ownedCursor.boundary) : precedingKey(ownedCursor.boundary) : sql`true`;
  const order = ascending ? forward ? sql`created_at ASC, id ASC` : sql`created_at DESC, id DESC` : forward ? sql`rank ASC, created_at DESC, id DESC` : sql`rank DESC, created_at ASC, id ASC`;
  const found = await db.execute<{ kind: Kind; id: string; rank: number; createdAt: string }>(sql`WITH selected AS (${selected}) SELECT kind, id, rank,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    FROM selected WHERE (${continuation}) ORDER BY ${order} LIMIT ${limit + 1}`);
  const items = found.rows.slice(0, limit);
  if (!forward) items.reverse();
  const boundary = items[0] ?? ownedCursor?.boundary;
  const prior = boundary ? precedingKey(boundary) : sql`false`;
  const later = boundary ? followingKey(boundary) : sql`false`;
  const counted = await db.execute<{ total: string; prior: string; later: string }>(sql`WITH selected AS (${selected}) SELECT count(*)::text AS total,
    count(*) FILTER (WHERE ${prior})::text AS prior, count(*) FILTER (WHERE ${later})::text AS later FROM selected`);
  const facts = counted.rows[0];
  if (!facts) throw new Error('Missing native work count observation');
  const total = safeCount(facts.total), priorCount = safeCount(facts.prior), laterCount = safeCount(facts.later);
  if (!ownedCursor && !items.length && total !== 0) throw new Error('Native work key/count observations differ');
  const before = items.length ? priorCount : ownedCursor?.direction === 'next' ? total : 0;
  if (before + items.length > total) throw new Error('Native work key/count observations differ');
  return { items, total, before,
    hasBefore: items.length ? before > 0 : ownedCursor?.direction === 'next' && priorCount > 0,
    hasAfter: items.length ? before + items.length < total : ownedCursor?.direction === 'previous' && laterCount > 0 };
}

/** Caller supplies its read-only REPEATABLE READ executor AFTER central access/selector validation. */
export function nativeWorkReadKeys(db: DbExecutor) {
  return {
    view: (projectId: string, actor: PrincipalRef, selection: NativeWorkViewSelector, limit: number, cursor?: WorkReadCursor): Promise<NativeWorkKeyPage> =>
      nativeReadKeyWindow<WorkObjectType>(db, nativeWorkViewKeySource(projectId, actor, selection), limit, cursor),
  };
}
