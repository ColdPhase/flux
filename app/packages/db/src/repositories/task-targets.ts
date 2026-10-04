import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { RuleViolationError } from '@flux/core';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { taskUseRows } from './task-use.js';

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
    const incoming = await tx.select({ id: l.fromId }).from(l).where(and(eq(l.fromType, 'work'),
      or(...owners.map((ref) => and(eq(l.toType, ref.type as 'result' | 'decision'), eq(l.toId, ref.id))))));
    incoming.forEach((row) => ids.add(row.id));
  }
  return [...ids].sort();
}

/** Caller holds authority/material/connection fences, with no task/domain row yet. */
export async function prepareReferencedTaskUse(tx: DbExecutor, projectId: string, refs: readonly Reference[]) {
  // Retain the known project graph even when the current association set is empty.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`flux.task-graph:${projectId}`}))`);
  const ids = await referencedTaskIds(tx, refs);
  const rows = ids.length ? await tx.select({ id: schema.projectWorkItems.id, projectId: schema.projectWorkItems.projectId }).from(schema.projectWorkItems)
    .where(inArray(schema.projectWorkItems.id, ids)) : [];
  if (rows.some((row) => row.projectId !== projectId)) throw new RuleViolationError('A task reference is outside the current project', 'TASK_TARGET_SCOPE_INVALID');
  return taskUseRows(tx).lockPrepared(ids);
}
