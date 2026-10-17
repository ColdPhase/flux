import { sql } from 'drizzle-orm';
import type { CoWorkSourceRef } from '@flux/contracts';
import { readableReferenceSet } from './cowork-recovery.js';
import type { DbExecutor } from './push.js';

// Review verdicts and the task's coordination records (#153 AC-4, #400 AC-4/AC-5). Storage only: the server
// composition has already authorized the caller and taken the request locks. No content is copied here.
export type CoWorkReviewVerdict = 'passed' | 'changes_requested';
export interface CoWorkVerdictInput { requestId: string; verdict: CoWorkReviewVerdict; evidenceRef: CoWorkSourceRef;
  reviewerConnectionId: string; reviewerOwnerId: string }
/** One request as people may see it: who asked whom for what, on which exact target, and where it stands. */
export interface CoWorkTaskRequestRow { id: string; kind: string; state: string; reason: string | null; target: CoWorkSourceRef;
  senderConnectionId: string; senderName: string; recipientConnectionId: string; recipientName: string; createdAt: string;
  updatedAt: string; responseRef: CoWorkSourceRef | null }
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
    /** Every request and verdict on one task, newest first, bounded. A verdict is current while its target still is. */
    async task(workspaceId: string, projectId: string, taskId: string, limit = 50) {
      const requests = await tx.execute<Record<string, unknown>>(sql`
        SELECT r.id, r.kind, CASE WHEN r.state IN ('queued', 'deferred', 'claimed') AND r.expires_at <= clock_timestamp()
            THEN 'expired' ELSE r.state END AS state, r.reason, r.target, r.response_ref,
          r.sender_connection_id, ${name('r.sender_connection_id')} AS sender_name,
          r.recipient_connection_id, ${name('r.recipient_connection_id')} AS recipient_name,
          r.created_at::text AS created_at, r.updated_at::text AS updated_at
        FROM cowork_requests r WHERE r.workspace_id = ${workspaceId}::uuid AND r.project_id = ${projectId}::uuid
          AND r.work_id = ${taskId}::uuid ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit}`);
      const verdicts = await tx.execute<Record<string, unknown>>(sql`
        SELECT v.request_id, v.verdict, v.target, v.criteria_refs, v.evidence_ref, v.reviewer_connection_id,
          ${name('v.reviewer_connection_id')} AS reviewer_name, v.author_connection_id, ${name('v.author_connection_id')} AS author_name,
          ${readableReferenceSet(sql`jsonb_build_array(v.target)`, sql`v.workspace_id`, sql`v.project_id`)} AS current,
          v.created_at::text AS created_at
        FROM cowork_review_verdicts v WHERE v.workspace_id = ${workspaceId}::uuid AND v.project_id = ${projectId}::uuid
          AND v.work_id = ${taskId}::uuid ORDER BY v.created_at DESC, v.request_id DESC LIMIT ${limit}`);
      return {
        requests: requests.rows.map((row): CoWorkTaskRequestRow => ({ id: String(row.id), kind: String(row.kind), state: String(row.state),
          reason: (row.reason as string | null) ?? null, target: row.target as CoWorkSourceRef,
          responseRef: (row.response_ref as CoWorkSourceRef | null) ?? null,
          senderConnectionId: String(row.sender_connection_id), senderName: String(row.sender_name),
          recipientConnectionId: String(row.recipient_connection_id), recipientName: String(row.recipient_name),
          createdAt: String(row.created_at), updatedAt: String(row.updated_at) })),
        verdicts: verdicts.rows.map((row): CoWorkTaskVerdictRow => ({ requestId: String(row.request_id),
          verdict: row.verdict as CoWorkReviewVerdict, target: row.target as CoWorkSourceRef,
          criteriaRefs: row.criteria_refs as CoWorkSourceRef[], evidenceRef: row.evidence_ref as CoWorkSourceRef,
          reviewerConnectionId: String(row.reviewer_connection_id), reviewerName: String(row.reviewer_name),
          authorConnectionId: String(row.author_connection_id), authorName: String(row.author_name),
          current: row.current === true, createdAt: String(row.created_at) })),
      };
    },
  };
}
