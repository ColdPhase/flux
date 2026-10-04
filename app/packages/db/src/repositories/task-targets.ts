import { and, eq, inArray, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { taskGraphRows } from './task-graph.js';
import { taskUseMemoryScope, taskUseRows, TaskUseRefusal, type TaskUseMemory } from './task-use.js';

type Reference = { type: string; id: string };
/** Canonical typed associations only; no opaque JSON traversal or caller-supplied ownership. */
export async function referencedTaskIds(tx: DbExecutor, refs: readonly Reference[], memory?: TaskUseMemory): Promise<string[]> {
  if (memory) {
    // Reserve reference/SQL AST ownership before constructing this continuation.
    // Fan-out itself has no product cap: count first, reserve, then bound the read.
    memory.reserve(4096 + refs.length * 8192);
    if (!refs.length) return [];
    const scope = sql`WITH refs(type,id) AS (VALUES ${sql.join(refs.map(ref => sql`(${ref.type}::text, ${ref.id}::uuid)`), sql`,`)})
      SELECT id FROM (
        SELECT id FROM refs WHERE type='work'
        UNION SELECT ${schema.projectTaskDiscussions.workId} FROM refs JOIN ${schema.projectTaskDiscussions}
          ON refs.type='conversation' AND refs.id=${schema.projectTaskDiscussions.conversationId}
        UNION SELECT ${schema.projectTaskDiscussions.workId} FROM refs JOIN ${schema.projectMessages}
          ON refs.type='message' AND refs.id=${schema.projectMessages.id} JOIN ${schema.projectTaskDiscussions}
          ON ${schema.projectMessages.conversationId}=${schema.projectTaskDiscussions.conversationId}
        UNION SELECT ${schema.githubTaskLinks.taskId} FROM refs JOIN ${schema.githubTaskLinks}
          ON refs.type='github_pr' AND refs.id=${schema.githubTaskLinks.id}
        UNION SELECT ${schema.projectObjectLinks.toId} FROM refs JOIN ${schema.projectObjectLinks}
          ON refs.type IN ('result','decision') AND refs.type=${schema.projectObjectLinks.fromType}::text
          AND refs.id=${schema.projectObjectLinks.fromId} AND ${schema.projectObjectLinks.toType}='work'
      ) canonical_tasks`;
    const counted = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM (${scope}) counted_tasks`);
    const count = counted.rows[0]!.count;
    // Includes UUID strings, rows, sorted arrays, Sets and all retained graph/task
    // continuation copies. No task-domain/body row is loaded by this query.
    memory.reserve(4096 + (count + 1) * 4096);
    const loaded = await tx.execute<{ id: string }>(sql`${scope} ORDER BY id LIMIT ${count + 1}`);
    if (loaded.rows.length > count) throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
    return loaded.rows.map(row => row.id);
  }
  const ids = new Set(refs.filter((ref) => ref.type === 'work').map((ref) => ref.id));
  const conversationIds = refs.filter((ref) => ref.type === 'conversation').map((ref) => ref.id);
  const messageIds = refs.filter((ref) => ref.type === 'message').map((ref) => ref.id);
  if (messageIds.length) {
    const rows = await tx.select({ id: schema.projectMessages.conversationId }).from(schema.projectMessages)
      .where(inArray(schema.projectMessages.id, messageIds));
    conversationIds.push(...rows.map((row) => row.id));
  }
  if (conversationIds.length) {
    const rows = await tx.select({ id: schema.projectTaskDiscussions.workId }).from(schema.projectTaskDiscussions)
      .where(inArray(schema.projectTaskDiscussions.conversationId, conversationIds));
    rows.forEach((row) => ids.add(row.id));
  }
  const pullLinks = refs.filter((ref) => ref.type === 'github_pr').map((ref) => ref.id);
  if (pullLinks.length) {
    const rows = await tx.select({ id: schema.githubTaskLinks.taskId }).from(schema.githubTaskLinks).where(inArray(schema.githubTaskLinks.id, pullLinks));
    rows.forEach((row) => ids.add(row.id));
  }
  const owners = refs.filter((ref) => ref.type === 'result' || ref.type === 'decision');
  if (owners.length) {
    const l = schema.projectObjectLinks;
    const rows = await tx.select({ id: l.toId }).from(l).where(and(eq(l.toType, 'work'),
      or(...owners.map((ref) => and(eq(l.fromType, ref.type as 'result' | 'decision'), eq(l.fromId, ref.id))))));
    rows.forEach((row) => ids.add(row.id));
    // Incoming work links can be that task's immutable initial provenance. Retaining those
    // after Undo must not poison a later unrelated use of the original result/decision.
  }
  return [...ids].sort();
}

/** Reference graphs also matter when their current task association set is empty. */
async function referencedProjectIds(tx: DbExecutor, refs: readonly Reference[]): Promise<string[]> {
  const projects = new Set<string>();
  const groups = [
    ['work', schema.projectWorkItems], ['result', schema.projectResults], ['decision', schema.projectDecisions],
    ['conversation', schema.projectConversations], ['message', schema.projectMessages],
    ['material', schema.projectMaterials], ['doc', schema.projectMaterials], ['github_pr', schema.githubTaskLinks],
  ] as const;
  for (const [type, table] of groups) {
    const ids = refs.filter((ref) => ref.type === type).map((ref) => ref.id);
    if (ids.length) {
      const rows = await tx.select({ projectId: table.projectId }).from(table).where(inArray(table.id, ids));
      rows.forEach((row) => projects.add(row.projectId));
    }
  }
  const sketchIds = refs.filter((ref) => ref.type === 'sketch').map((ref) => ref.id);
  const thoughtIds = refs.filter((ref) => ref.type === 'thought').map((ref) => ref.id);
  if (thoughtIds.length) {
    const thoughts = await tx.select({ sketchId: schema.sketchThoughts.sketchId }).from(schema.sketchThoughts)
      .where(inArray(schema.sketchThoughts.id, thoughtIds));
    sketchIds.push(...thoughts.map((row) => row.sketchId));
  }
  if (sketchIds.length) {
    const sketches = await tx.select({ projectId: schema.sketches.projectId }).from(schema.sketches)
      .where(inArray(schema.sketches.id, sketchIds));
    sketches.forEach((row) => { if (row.projectId) projects.add(row.projectId); });
  }
  return [...projects].sort();
}

/** Caller holds authority/material/connection fences, with no graph/task/domain row yet. */
export async function prepareReferencedTaskUse(tx: DbExecutor, projectId: string, refs: readonly Reference[], memory?: TaskUseMemory) {
  const scope = taskUseMemoryScope(memory);
  try {
    const projectsOfTasks = async (ids: readonly string[]) => ids.length
      ? (await tx.select({ projectId: schema.projectWorkItems.projectId }).from(schema.projectWorkItems)
        .where(inArray(schema.projectWorkItems.id, [...ids]))).map((row) => row.projectId) : [];
    const initial = await referencedTaskIds(tx, refs, scope.memory);
    const graphIds = [...new Set([projectId, ...await referencedProjectIds(tx, refs), ...await projectsOfTasks(initial)])].sort();
    await taskGraphRows(tx).lockTaskGraphs(graphIds);
    // Re-resolve after waiting for graphs. Never extend the upstream set after taking any graph.
    const ids = await referencedTaskIds(tx, refs, scope.memory);
    if ([...await referencedProjectIds(tx, refs), ...await projectsOfTasks(ids)].some((id) => !graphIds.includes(id)))
      throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
    // The one sorted pass owns fresh retained arrays/sets, rather than returning
    // the discovery array after its short-lived ownership has ended.
    memory?.reserve(4096 + graphIds.length * 512);
    return { ...await taskUseRows(tx, memory).lockPrepared(ids), projectIds: [...graphIds] };
  } finally { scope.release(); }
}
