import { randomUUID } from 'node:crypto';
import type { DraftSummary } from '@flux/contracts';
import { ForbiddenError, NotFoundError } from '../access/errors.js';
import { assertAuthorized, enforce, evaluateDraft, isUuid } from '../access/policy.js';
import { recordEvent } from '../events.js';
import type { JobQueue } from '../push/ports.js';
import type { Database, Executor, Principal } from '../types.js';

/**
 * `draft.summarize.v1`: a placeholder derived-result job (a deterministic word count).
 * It exists to exercise the worker authorization contract: the job payload carries only
 * the result id; the worker rechecks the requesting principal's current access before it
 * reads the draft and again inside the transaction that commits the result.
 */
export const DRAFT_SUMMARY_JOB = 'draft.summarize.v1';

export interface DraftResultRecord {
  id: string;
  workspaceId: string;
  draftId: string;
  principalKind: 'human' | 'agent';
  principalId: string;
  status: 'queued' | 'running' | 'completed' | 'denied';
  deniedAtStage: 'before_read' | 'before_commit' | null;
  draftVersion: number | null;
  wordCount: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** Result rows and the draft text they are computed from (#87), bound to one transaction or connection. */
export interface DraftResultRepository {
  insert(result: { id: string; workspaceId: string; draftId: string; principalKind: 'human' | 'agent'; principalId: string }): Promise<void>;
  setJobId(id: string, jobId: string): Promise<DraftResultRecord>;
  /** The draft's newest results first. */
  list(draftId: string, limit: number): Promise<DraftResultRecord[]>;
  get(draftId: string, resultId: string): Promise<DraftResultRecord | null>;
  /** Marks a queued or running result running; null when it is missing or already finished. */
  claim(resultId: string): Promise<DraftResultRecord | null>;
  markDenied(resultId: string, stage: 'before_read' | 'before_commit'): Promise<void>;
  /** Completes a running result; false when it is no longer running. */
  complete(resultId: string, wordCount: number, draftVersion: number): Promise<boolean>;
  readDraftBody(draftId: string): Promise<{ body: string; version: number } | null>;
}

export type DraftResultStores = (db: Executor) => DraftResultRepository;

export interface DraftSummaryRequestPorts {
  results: DraftResultStores;
  /** Bound to the request transaction, so the job commits with its result row. */
  queue: (tx: Executor) => Pick<JobQueue, 'enqueueDraftSummary'>;
}

function toSummary(row: DraftResultRecord): DraftSummary {
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
export async function requestDraftSummary(principal: Principal, draftId: string, db: Database, ports: DraftSummaryRequestPorts): Promise<DraftSummary> {
  if (principal.kind !== 'human' && principal.kind !== 'agent') throw new ForbiddenError('Only people and agents can request summaries');
  const kind = principal.kind;
  return db.transaction(async (tx) => {
    const { draft } = enforce(await evaluateDraft(principal, 'draft.read', draftId, tx, { lock: true }), 'draft');
    const results = ports.results(tx);
    const id = randomUUID();
    await results.insert({ id, workspaceId: draft!.workspaceId, draftId, principalKind: kind, principalId: principal.id });
    const jobId = await ports.queue(tx).enqueueDraftSummary({ resultId: id });
    if (!jobId) throw new Error('Job enqueue failed');
    const row = await results.setJobId(id, jobId);
    await recordEvent(tx, principal, draft!.workspaceId, 'draft.summary_requested.v1', draftId, { resultId: id });
    return toSummary(row);
  });
}

export async function listDraftSummaries(principal: Principal, draftId: string, db: Database, results: DraftResultStores): Promise<DraftSummary[]> {
  enforce(await evaluateDraft(principal, 'draft.read', draftId, db), 'draft');
  return (await results(db).list(draftId, 20)).map(toSummary);
}

/** A result is readable by whoever can currently read its draft. */
export async function getDraftSummary(principal: Principal, draftId: string, resultId: string, db: Database, results: DraftResultStores): Promise<DraftSummary> {
  enforce(await evaluateDraft(principal, 'draft.read', draftId, db), 'draft');
  const row = isUuid(resultId) ? await results(db).get(draftId, resultId) : null;
  if (!row) throw new NotFoundError('Summary', 'SUMMARY_NOT_FOUND');
  return toSummary(row);
}

export type DraftSummaryOutcome = 'completed' | 'denied' | 'skipped';

/**
 * Test seams: `afterRead` runs after the inputs were read and before the commit
 * transaction; `beforeCommit` runs inside the commit transaction after the recheck and the
 * result write, while its locks are held.
 */
export interface DraftSummaryHooks {
  afterRead?: () => Promise<void>;
  beforeCommit?: (tx: Executor) => Promise<void>;
}

function isAccessDenial(error: unknown) {
  return error instanceof NotFoundError || error instanceof ForbiddenError;
}

async function deny(tx: Executor, results: DraftResultStores, row: DraftResultRecord, principal: Principal, stage: 'before_read' | 'before_commit') {
  await results(tx).markDenied(row.id, stage);
  await recordEvent(tx, principal, row.workspaceId, 'draft.summary_denied.v1', row.draftId, { resultId: row.id, stage });
}

/**
 * Worker handler. Claims the result, authorizes the requester before reading the draft,
 * computes the result, and commits it only if the requester is still authorized inside the
 * commit transaction. The recheck locks what it decides on (membership/agent rows FOR
 * SHARE, the draft FOR UPDATE, the draft's project row and the requester's grants on it FOR
 * SHARE), so a membership or grant change that commits first is seen, and one that starts
 * later waits until the result has committed. If access was lost at either point, nothing
 * is computed or committed and the result becomes `denied`.
 */
export async function processDraftSummary(resultId: string, db: Database, results: DraftResultStores, hooks: DraftSummaryHooks = {}): Promise<DraftSummaryOutcome> {
  if (!isUuid(resultId)) return 'skipped';
  const row = await results(db).claim(resultId);
  if (!row) return 'skipped';
  const principal: Principal = { kind: row.principalKind, id: row.principalId };
  const draftRef = { type: 'draft', id: row.draftId } as const;

  try {
    await assertAuthorized(principal, 'draft.read', draftRef, db);
  } catch (error) {
    if (!isAccessDenial(error)) throw error;
    await db.transaction((tx) => deny(tx, results, row, principal, 'before_read'));
    return 'denied';
  }
  const draft = await results(db).readDraftBody(row.draftId);
  if (!draft) return 'skipped';
  const wordCount = countWords(draft.body);
  await hooks.afterRead?.();

  return db.transaction(async (tx) => {
    try {
      await assertAuthorized(principal, 'draft.read', draftRef, tx, { lock: true });
    } catch (error) {
      if (!isAccessDenial(error)) throw error;
      await deny(tx, results, row, principal, 'before_commit');
      return 'denied' as const;
    }
    if (!(await results(tx).complete(row.id, wordCount, draft.version))) return 'skipped' as const;
    await hooks.beforeCommit?.(tx);
    await recordEvent(tx, principal, row.workspaceId, 'draft.summary_completed.v1', row.draftId, { resultId: row.id });
    return 'completed' as const;
  });
}
