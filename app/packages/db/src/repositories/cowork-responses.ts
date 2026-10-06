import { and, eq, sql } from 'drizzle-orm';
import type { CoWorkSourceRef } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

// Request claim, response and supersession (#153). Storage only: the server composition has already run #152
// preparation and taken the recipient slot -> graph -> complete task set -> unit locks in this outer transaction.
// Every conditional update repeats the live unit fence and the request version/state, so a scope read before a
// lock wait can never win. No grant, receipt, stream event or model invocation is written here.
const requests = schema.coworkRequests;
interface Scope { workspaceId: string; projectId: string; connectionId: string; unitId: string }
interface Fence { requestId: string; expectedVersion: number; generation: number; leaseId: string; runtimeSessionId: string }
type Changed = { id: string; version: number; state: string };

function liveUnit(scope: Scope, fence: Fence) {
  return sql`unit.id = request.unit_id AND unit.id = ${scope.unitId}::uuid AND unit.workspace_id = ${scope.workspaceId}::uuid
    AND unit.project_id = ${scope.projectId}::uuid AND unit.assignment_connection_id = ${scope.connectionId}::uuid
    AND unit.state = 'claimed' AND unit.generation = ${fence.generation} AND unit.lease_id = ${fence.leaseId}::uuid
    AND unit.lease_session_id = ${fence.runtimeSessionId} AND unit.lease_expires_at > clock_timestamp()`;
}
function addressed(scope: Scope, fence: Fence) {
  return sql`request.id = ${fence.requestId}::uuid AND request.workspace_id = ${scope.workspaceId}::uuid
    AND request.project_id = ${scope.projectId}::uuid AND request.recipient_connection_id = ${scope.connectionId}::uuid
    AND request.unit_id = ${scope.unitId}::uuid AND request.version = ${fence.expectedVersion}
    AND request.expires_at > clock_timestamp()`;
}

export function coworkResponseRows(tx: DbExecutor) {
  return {
    /** Locks the request row last (after the unit rows); `expired`/`now` are fresh wall time after every wait. */
    async lockRequest(workspaceId: string, projectId: string, id: string) {
      const [row] = await tx.select({ id: requests.id, unitId: requests.unitId, recipientConnectionId: requests.recipientConnectionId,
        state: requests.state, version: requests.version, claimedGeneration: requests.claimedGeneration,
        expired: sql<boolean>`${requests.expiresAt} <= clock_timestamp()`,
        now: sql<Date>`clock_timestamp()`.mapWith((value: Date | string) => new Date(value instanceof Date ? value.getTime() : value)) })
        .from(requests)
        .where(and(eq(requests.id, id), eq(requests.workspaceId, workspaceId), eq(requests.projectId, projectId))).for('update');
      return row ?? null;
    },
    /** Queued/deferred, or claimed under an older generation -> claimed under the live one. Null if any fence changed. */
    async claim(scope: Scope, fence: Fence): Promise<Changed | null> {
      const result = await tx.execute<Changed>(sql`
        UPDATE cowork_requests request SET state = 'claimed', claimed_generation = unit.generation, version = request.version + 1,
          reason = NULL, next_boundary = NULL, dependency_ref = NULL, updated_at = clock_timestamp()
        FROM cowork_units unit
        WHERE ${addressed(scope, fence)} AND ${liveUnit(scope, fence)}
          AND (request.state IN ('queued', 'deferred')
            OR (request.state = 'claimed' AND request.claimed_generation IS DISTINCT FROM unit.generation))
        RETURNING request.id, request.version, request.state`);
      return result.rows[0] ?? null;
    },
    /** Claimed under the live generation -> resolved with its exact response, or declined with a bounded reason. */
    async respond(scope: Scope, fence: Fence, outcome: { state: 'resolved'; responseRef: CoWorkSourceRef } | { state: 'declined'; reason: string }) {
      const result = await tx.execute<Changed>(sql`
        UPDATE cowork_requests request SET state = ${outcome.state}, version = request.version + 1, updated_at = clock_timestamp(),
          response_ref = ${outcome.state === 'resolved' ? JSON.stringify(outcome.responseRef) : null}::jsonb,
          reason = ${outcome.state === 'declined' ? outcome.reason : null}
        FROM cowork_units unit
        WHERE ${addressed(scope, fence)} AND ${liveUnit(scope, fence)}
          AND request.state = 'claimed' AND request.claimed_generation = unit.generation
        RETURNING request.id, request.version, request.state`);
      return result.rows[0] ?? null;
    },
    /**
     * A newly created request replaces every earlier UNCLAIMED request with the same lineage, sender connection,
     * recipient unit and kind. Claimed requests keep their history; budget is never refunded.
     */
    async supersede(createdRequestId: string): Promise<string[]> {
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE cowork_requests prior SET state = 'superseded', reason = 'newer_request', version = prior.version + 1,
          updated_at = clock_timestamp()
        FROM cowork_requests created
        WHERE created.id = ${createdRequestId}::uuid AND prior.id <> created.id AND prior.lineage_id = created.lineage_id
          AND prior.sender_connection_id = created.sender_connection_id AND prior.unit_id = created.unit_id
          AND prior.kind = created.kind AND prior.state IN ('queued', 'deferred') AND prior.created_at <= created.created_at
        RETURNING prior.id`);
      return result.rows.map((row) => row.id).sort();
    },
    /** Canonical current request facts for the post-state hook and replay; content-free. */
    async request(workspaceId: string, projectId: string, id: string) {
      const [row] = await tx.select({ id: requests.id, unitId: requests.unitId, recipientConnectionId: requests.recipientConnectionId,
        version: requests.version, state: requests.state, claimedGeneration: requests.claimedGeneration, responseRef: requests.responseRef,
        target: requests.target, sourceRefs: requests.sourceRefs, criteriaRefs: requests.criteriaRefs }).from(requests)
        .where(and(eq(requests.id, id), eq(requests.workspaceId, workspaceId), eq(requests.projectId, projectId)));
      return row ?? null;
    },
  };
}
