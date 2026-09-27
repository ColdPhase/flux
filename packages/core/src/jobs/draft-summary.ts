import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { schema } from '@flux/db';
import type { DraftSummary } from '@flux/contracts';
import { ForbiddenError, NotFoundError } from '../access/errors.js';
import { assertAuthorized, enforce, evaluateDraft, isUuid } from '../access/policy.js';
import { recordEvent } from '../events.js';
import type { Database, Principal } from '../types.js';

/**
 * `draft.summarize.v1`: a placeholder derived-result job (a deterministic word count).
 * It exists to exercise the worker authorization contract: the job payload carries only
 * the result id; the worker rechecks the requesting principal's current access before it
 * reads the draft and again inside the transaction that commits the result.
 */
export const DRAFT_SUMMARY_JOB = 'draft.summarize.v1';

type ResultRow = typeof schema.draftResults.$inferSelect;
type JobQueue = Pick<PgBoss, 'send'>;

function toSummary(row: ResultRow): DraftSummary {
  return {
    id: row.id,
    draftId: row.draftId,
    workspaceId: row.workspaceId,
    requestedBy: { kind: row.principalKind, id: row.principalId },
    status: row.status,
    deniedAtStage: row.deniedAtStage,
    draftVersion: row.draftVersion,
    wordCount: row.wordCount,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export function countWords(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

/**
 * Queues a summary of a draft the principal can read. The result row, the event and the
 * pg-boss job commit in one transaction.
 */
export async function requestDraftSummary(principal: Principal, draftId: string, db: Database, boss: JobQueue): Promise<DraftSummary> {
  if (principal.kind !== 'human' && principal.kind !== 'agent') throw new ForbiddenError('Only people and agents can request summaries');
  const kind = principal.kind;
  return db.transaction(async (tx) => {
    const { draft } = enforce(await evaluateDraft(principal, 'draft.read', draftId, tx, { lock: true }), 'draft');
    const id = randomUUID();
    await tx.insert(schema.draftResults).values({ id, workspaceId: draft!.workspaceId, draftId, principalKind: kind, principalId: principal.id });
    const jobId = await boss.send(DRAFT_SUMMARY_JOB, { resultId: id }, { db: fromDrizzle(tx, sql) });
    if (!jobId) throw new Error('Job enqueue failed');
    const [row] = await tx.update(schema.draftResults).set({ jobId }).where(eq(schema.draftResults.id, id)).returning();
    await recordEvent(tx, principal, draft!.workspaceId, 'draft.summary_requested.v1', draftId, { resultId: id });
    return toSummary(row!);
  });
}

export async function listDraftSummaries(principal: Principal, draftId: string, db: Database): Promise<DraftSummary[]> {
  enforce(await evaluateDraft(principal, 'draft.read', draftId, db), 'draft');
  const rows = await db.select().from(schema.draftResults).where(eq(schema.draftResults.draftId, draftId))
    .orderBy(desc(schema.draftResults.createdAt), desc(schema.draftResults.id)).limit(20);
  return rows.map(toSummary);
}

/** A result is readable by whoever can currently read its draft. */
export async function getDraftSummary(principal: Principal, draftId: string, resultId: string, db: Database): Promise<DraftSummary> {
  enforce(await evaluateDraft(principal, 'draft.read', draftId, db), 'draft');
  const [row] = isUuid(resultId) ? await db.select().from(schema.draftResults)
    .where(and(eq(schema.draftResults.id, resultId), eq(schema.draftResults.draftId, draftId))) : [];
  if (!row) throw new NotFoundError('Summary', 'SUMMARY_NOT_FOUND');
  return toSummary(row);
}

export type DraftSummaryOutcome = 'completed' | 'denied' | 'skipped';

/** Test seam: `afterRead` runs after the inputs were read and before the commit transaction. */
export interface DraftSummaryHooks {
  afterRead?: () => Promise<void>;
}

function isAccessDenial(error: unknown) {
  return error instanceof NotFoundError || error instanceof ForbiddenError;
}

async function deny(db: Database, row: ResultRow, principal: Principal, stage: 'before_read' | 'before_commit') {
  await db.update(schema.draftResults).set({ status: 'denied', deniedAtStage: stage, updatedAt: new Date(), completedAt: new Date() })
    .where(eq(schema.draftResults.id, row.id));
  await recordEvent(db, principal, row.workspaceId, 'draft.summary_denied.v1', row.draftId, { resultId: row.id, stage });
}

/**
 * Worker handler. Claims the result, authorizes the requester before reading the draft,
 * computes the result, and commits it only if the requester is still authorized inside the
 * commit transaction (membership/agent rows FOR SHARE, the draft FOR UPDATE). If access was
 * lost at either point, nothing is computed or committed and the result becomes `denied`.
 */
export async function processDraftSummary(resultId: string, db: Database, hooks: DraftSummaryHooks = {}): Promise<DraftSummaryOutcome> {
  if (!isUuid(resultId)) return 'skipped';
  const [row] = await db.update(schema.draftResults).set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(schema.draftResults.id, resultId), inArray(schema.draftResults.status, ['queued', 'running']))).returning();
  if (!row) return 'skipped';
  const principal: Principal = { kind: row.principalKind, id: row.principalId };
  const draftRef = { type: 'draft', id: row.draftId } as const;

  try {
    await assertAuthorized(principal, 'draft.read', draftRef, db);
  } catch (error) {
    if (!isAccessDenial(error)) throw error;
    await db.transaction((tx) => deny(tx, row, principal, 'before_read'));
    return 'denied';
  }
  const [draft] = await db.select({ body: schema.drafts.body, version: schema.drafts.version }).from(schema.drafts).where(eq(schema.drafts.id, row.draftId));
  if (!draft) return 'skipped';
  const wordCount = countWords(draft.body);
  await hooks.afterRead?.();

  return db.transaction(async (tx) => {
    try {
      await assertAuthorized(principal, 'draft.read', draftRef, tx, { lock: true });
    } catch (error) {
      if (!isAccessDenial(error)) throw error;
      await deny(tx, row, principal, 'before_commit');
      return 'denied' as const;
    }
    const updated = await tx.update(schema.draftResults)
      .set({ status: 'completed', wordCount, draftVersion: draft.version, updatedAt: new Date(), completedAt: new Date() })
      .where(and(eq(schema.draftResults.id, row.id), eq(schema.draftResults.status, 'running'))).returning({ id: schema.draftResults.id });
    if (!updated.length) return 'skipped' as const;
    await recordEvent(tx, principal, row.workspaceId, 'draft.summary_completed.v1', row.draftId, { resultId: row.id });
    return 'completed' as const;
  });
}

