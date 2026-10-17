import { sql } from 'drizzle-orm';
import type { CoWorkSourceRef } from '@flux/contracts';
import { readableReferenceSet } from './cowork-recovery.js';
import type { DbExecutor } from './push.js';

// Review verdicts and the task's coordination records (#153 AC-4, #400 AC-4/AC-5). Storage only: the server
// composition has already authorized the caller and taken the request locks. No content is copied here.
export type CoWorkReviewVerdict = 'passed' | 'changes_requested';
export interface CoWorkVerdictInput { requestId: string; verdict: CoWorkReviewVerdict; evidenceRef: CoWorkSourceRef;
  reviewerConnectionId: string; reviewerOwnerId: string }
export interface CoWorkTaskVerdictRow { requestId: string; verdict: CoWorkReviewVerdict; target: CoWorkSourceRef;
  criteriaRefs: CoWorkSourceRef[]; evidenceRef: CoWorkSourceRef; reviewerConnectionId: string; reviewerName: string;
  authorConnectionId: string; authorName: string; current: boolean; createdAt: string }

const name = (connection: string) => sql.raw(`COALESCE((SELECT a.name FROM agent_connections c JOIN agents a ON a.id = c.agent_id
  WHERE c.id = ${connection}), 'An agent')`);

export function coworkReviewRows(tx: DbExecutor) {
  return {
    /** The request facts a response needs: its kind, pinned target, criteria and sender. Read under the request lock. */
    async request(workspaceId: string, projectId: string, id: string) {
      const result = await tx.execute<{ kind: string; target: CoWorkSourceRef; criteria_refs: CoWorkSourceRef[];
        sender_connection_id: string; work_id: string }>(sql`
        SELECT kind, target, criteria_refs, sender_connection_id, work_id FROM cowork_requests
        WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid AND project_id = ${projectId}::uuid`);
      const row = result.rows[0];
      return row ? { kind: row.kind, target: row.target, criteriaRefs: row.criteria_refs, senderConnectionId: row.sender_connection_id,
        taskId: row.work_id } : null;
    },
    /** Records the verdict pinned to the request's own target and criteria. One verdict per request. */
    async record(workspaceId: string, projectId: string, input: CoWorkVerdictInput) {
      await tx.execute(sql`
        INSERT INTO cowork_review_verdicts (request_id, workspace_id, project_id, work_id, reviewer_connection_id, reviewer_owner_id,
          author_connection_id, target, criteria_refs, verdict, evidence_ref)
        SELECT r.id, r.workspace_id, r.project_id, r.work_id, ${input.reviewerConnectionId}::uuid, ${input.reviewerOwnerId},
          r.sender_connection_id, r.target, r.criteria_refs, ${input.verdict}, ${JSON.stringify(input.evidenceRef)}::jsonb
        FROM cowork_requests r WHERE r.id = ${input.requestId}::uuid AND r.workspace_id = ${workspaceId}::uuid
          AND r.project_id = ${projectId}::uuid AND r.kind = 'review'`);
    },
    /** Every verdict on one task, newest first, bounded. A verdict is current while its target still is. */
    async verdicts(workspaceId: string, projectId: string, taskId: string, options: { limit?: number; requestId?: string } = {}) {
      const verdicts = await tx.execute<Record<string, unknown>>(sql`
        SELECT v.request_id, v.verdict, v.target, v.criteria_refs, v.evidence_ref, v.reviewer_connection_id,
          ${name('v.reviewer_connection_id')} AS reviewer_name, v.author_connection_id, ${name('v.author_connection_id')} AS author_name,
          ${readableReferenceSet(sql`jsonb_build_array(v.target)`, sql`v.workspace_id`, sql`v.project_id`)} AS current,
          v.created_at::text AS created_at
        FROM cowork_review_verdicts v WHERE v.workspace_id = ${workspaceId}::uuid AND v.project_id = ${projectId}::uuid
          AND v.work_id = ${taskId}::uuid ${options.requestId ? sql`AND v.request_id = ${options.requestId}::uuid` : sql``}
        ORDER BY v.created_at DESC, v.request_id DESC LIMIT ${Math.min(options.limit ?? 50, 50)}`);
      return verdicts.rows.map((row): CoWorkTaskVerdictRow => ({ requestId: String(row.request_id),
        verdict: row.verdict as CoWorkReviewVerdict, target: row.target as CoWorkSourceRef,
        criteriaRefs: row.criteria_refs as CoWorkSourceRef[], evidenceRef: row.evidence_ref as CoWorkSourceRef,
        reviewerConnectionId: String(row.reviewer_connection_id), reviewerName: String(row.reviewer_name),
        authorConnectionId: String(row.author_connection_id), authorName: String(row.author_name),
        current: row.current === true, createdAt: String(row.created_at) }));
    },
  };
}
