import { and, eq, inArray, or } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { taskGraphRows } from './task-graph.js';
import { taskUseRows, TaskUseRefusal } from './task-use.js';

type Reference = { type: string; id: string };
/** Canonical typed associations only; no opaque JSON traversal or caller-supplied ownership. */
export async function referencedTaskIds(tx: DbExecutor, refs: readonly Reference[]): Promise<string[]> {
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
export async function referencedProjectIds(tx: DbExecutor, refs: readonly Reference[]): Promise<string[]> {
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

/**
 * Caller holds authority/material/connection fences, with no graph/task/domain row yet. Collects every involved
 * project (also when the current task association set is empty), locks those graphs in one sorted pass, re-resolves
 * under them, then takes ONE sorted task pass. An association that appears meanwhile in a project outside the
 * retained graphs refuses with TASK_TARGET_SET_CHANGED; the caller retries from authority preparation.
 */
export async function prepareReferencedTaskUse(tx: DbExecutor, projectId: string, refs: readonly Reference[]) {
  const projectsOfTasks = async (ids: readonly string[]) => ids.length
    ? (await tx.select({ projectId: schema.projectWorkItems.projectId }).from(schema.projectWorkItems)
      .where(inArray(schema.projectWorkItems.id, [...ids]))).map((row) => row.projectId) : [];
  const initial = await referencedTaskIds(tx, refs);
  const graphIds = [...new Set([projectId, ...await referencedProjectIds(tx, refs), ...await projectsOfTasks(initial)])].sort();
  await taskGraphRows(tx).lockTaskGraphs(graphIds);
  // Re-resolve after waiting for graphs. Never extend the upstream set after taking any graph.
  const ids = await referencedTaskIds(tx, refs);
  if ([...await referencedProjectIds(tx, refs), ...await projectsOfTasks(ids)].some((id) => !graphIds.includes(id)))
    throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
  return { ...await taskUseRows(tx).lockPrepared(ids), projectIds: [...graphIds] };
}
