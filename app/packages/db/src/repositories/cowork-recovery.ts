import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { CoWorkInboxRecord } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type Address = { workspaceId: string; projectId: string; connectionId: string };
export interface CoWorkRecoveryPosition { createdAt: string; id: string }
const r = schema.coworkRequests, u = schema.coworkUnits;
function addressed(scope: Address) {
  return and(eq(r.workspaceId, scope.workspaceId), eq(r.projectId, scope.projectId), eq(r.recipientConnectionId, scope.connectionId));
}

/** Current canonical metadata only. Project policy is held by the server caller.
 * All references are filtered BEFORE pagination: hidden packets cannot affect
 * page size, visible continuations or counts. GitHub references stay unavailable
 * until the receiving owner's verified access/provenance adapter is composed.
 */
function readableReferences() {
  return readableReferenceSet(sql`jsonb_build_array(${r.target}) || ${r.sourceRefs} || ${r.criteriaRefs}
      || CASE WHEN ${r.dependencyRef} IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(${r.dependencyRef}) END
      || CASE WHEN ${r.responseRef} IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(${r.responseRef}) END`,
  sql`${r.workspaceId}`, sql`${r.projectId}`);
}
/** The same exact-version rule for any jsonb reference array, e.g. a request being admitted (#153). */
export function readableReferenceSet(references: SQL, workspaceId: SQL, projectId: SQL) {
  return sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      ${references}
    ) AS reference(value)
    WHERE NOT COALESCE(CASE reference.value->>'type'
      WHEN 'message' THEN EXISTS (SELECT 1 FROM project_messages object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId})
      WHEN 'result' THEN EXISTS (SELECT 1 FROM project_results object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId})
      WHEN 'work' THEN EXISTS (SELECT 1 FROM project_work_items object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId}
          AND object.version::text=reference.value->>'version')
      WHEN 'material' THEN EXISTS (SELECT 1 FROM project_materials object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId}
          AND object.current_version::text=reference.value->>'version')
      WHEN 'doc' THEN EXISTS (SELECT 1 FROM project_materials object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId}
          AND object.kind='doc' AND object.current_version::text=reference.value->>'version')
      WHEN 'thought' THEN EXISTS (SELECT 1 FROM sketch_thoughts object JOIN sketches map
        ON map.workspace_id=object.workspace_id AND map.id=object.sketch_id
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId}
          AND map.project_id=${projectId} AND map.scope='project' AND object.version::text=reference.value->>'version')
      ELSE false END, false)
  )`;
}

/** This adapter never authorizes a caller, claims work, acknowledges or resolves a request. */
export function coworkRecoveryRows(tx: DbExecutor) {
  return {
    async retained(scope: Address, position: CoWorkRecoveryPosition) {
      const [found] = await tx.select({ id: r.id }).from(r).where(and(addressed(scope), eq(r.id, position.id),
        sql`${r.createdAt} = ${position.createdAt}::timestamptz`));
      return Boolean(found);
    },
    async page(scope: Address, limit: number, after?: CoWorkRecoveryPosition) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid bounded recovery page');
      const rows = await tx.select({ request: r, state: u.state, generation: u.generation, assignment: u.assignmentConnectionId,
        cursorTime: sql<string>`${r.createdAt}::text`,
        leaseExpired: sql<boolean>`${u.leaseExpiresAt} IS NULL OR ${u.leaseExpiresAt} <= clock_timestamp()`,
        expired: sql<boolean>`${r.expiresAt} <= clock_timestamp()` }).from(r).innerJoin(u, eq(u.id, r.unitId))
        .where(and(addressed(scope), inArray(r.state, ['queued', 'deferred', 'claimed']), readableReferences(),
          after ? sql`(${r.createdAt}, ${r.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)` : undefined))
        .orderBy(asc(r.createdAt), asc(r.id)).limit(limit + 1);
      const visible = rows.slice(0, limit);
      const records: CoWorkInboxRecord[] = visible.map((row) => {
        const { fingerprint: _fingerprint, updatedAt: _updatedAt, ...request } = row.request;
        void _fingerprint; void _updatedAt;
        const lost = request.state === 'claimed' && (row.state !== 'claimed' || row.leaseExpired
          || row.generation !== request.claimedGeneration || row.assignment !== scope.connectionId);
        return { ...request, effectiveState: row.expired ? 'expired' : lost ? 'queued' : request.state,
          readinessReason: row.expired ? 'request_expired' : row.assignment !== scope.connectionId ? 'assignment_changed'
            : row.state === 'completed' || row.state === 'stopped' ? 'unit_closed' : lost ? 'claim_lost' : null };
      });
      const last = visible.at(-1);
      return { records, continuation: rows.length > limit && last ? { createdAt: last.cursorTime, id: last.request.id } : null };
    },
  };
}
