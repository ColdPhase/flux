import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { CoWorkSourceRef } from '@flux/contracts';
import * as schema from '../schema.js';
import type { CoWorkTaskLockInput } from './cowork.js';
import type { DbExecutor } from './push.js';
import { taskUseRows } from './task-use.js';

// The holder's unit completion and transfer (#153). Storage only: the server composition has already run #152
// preparation (current bearer/runtime/grant/command ledger) in this same outer transaction. No grant, receipt,
// request, claim, stream event or model invocation is written here.
const units = schema.coworkUnits, slots = schema.coworkConnectionSlots, connections = schema.agentConnections;
const requests = schema.coworkRequests;
type UnitRow = typeof units.$inferSelect;
export interface CoWorkUnitTransitionScope {
  workspaceId: string;
  projectId: string;
  /** The acting connection: the holder for a new transition, the original actor for a replay. */
  holderConnectionId: string;
  unitId: string;
  /** Transfer only: the connection the unit is handed to. */
  assigneeConnectionId: string | null;
}
/** The holder's exact live claim, repeated in the conditional update's `WHERE` clause. */
export interface CoWorkUnitTransitionFence {
  expectedVersion: number;
  generation: number;
  leaseId: string;
  runtimeSessionId: string;
}
function unit(row: UnitRow) {
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, taskId: row.taskId,
    lineageTaskId: row.lineageTaskId, runId: row.runId, unitKey: row.unitKey, role: row.role,
    assignmentConnectionId: row.assignmentConnectionId, state: row.state, version: row.version, generation: row.generation,
    checkpointId: row.checkpointId, outcomeRef: row.outcomeRef ?? null,
    lease: row.leaseId ? { id: row.leaseId, runtimeSessionId: row.leaseSessionId!, expiresAt: row.leaseExpiresAt! } : null };
}
export type CoWorkTransitionUnitRecord = ReturnType<typeof unit>;
/** Requests addressed to the unit that can still be claimed or answered. An expired request no longer can. */
function openRequestsOf(unitId: SQL) {
  return sql`SELECT 1 FROM cowork_requests open_request WHERE open_request.unit_id = ${unitId}
    AND open_request.state IN ('queued', 'deferred', 'claimed') AND open_request.expires_at > clock_timestamp()`;
}

export function coworkUnitTransitionRows(tx: DbExecutor) {
  /** Fresh database wall time, never transaction-start `now()` or a client timestamp. */
  const fresh = async () => {
    const value = (await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now;
    return new Date(value instanceof Date ? value.getTime() : value);
  };
  const inProject = (scope: { workspaceId: string; projectId: string }) =>
    and(eq(units.workspaceId, scope.workspaceId), eq(units.projectId, scope.projectId));
  /** The conditional write repeats the holder fence, the version and the open-request rule. */
  const held = (scope: CoWorkUnitTransitionScope, fence: CoWorkUnitTransitionFence) => and(inProject(scope),
    eq(units.id, scope.unitId), eq(units.assignmentConnectionId, scope.holderConnectionId), eq(units.state, 'claimed'),
    eq(units.version, fence.expectedVersion), eq(units.generation, fence.generation), eq(units.leaseId, fence.leaseId),
    eq(units.leaseSessionId, fence.runtimeSessionId), sql`${units.leaseExpiresAt} > clock_timestamp()`,
    sql`NOT EXISTS (${openRequestsOf(sql`${units.id}`)})`);
  return {
    /**
     * Assignee connection row (FOR SHARE, transfer only) -> sorted holder/assignee slots -> caller's graph
     * locks/dependencies -> complete sorted task set -> the unit row. The unit is located by its ID in this project
     * whatever its assignment, so a former holder can still observe its transfer receipt. The share lock serializes
     * with revocation/deletion of the assignee: a revocation that commits first refuses the transfer; one that waits
     * stops the transferred unit. Everything returned is read after those waits; `now` is fresh wall time after them.
     */
    async lock(scope: CoWorkUnitTransitionScope, prepareTasks: (units: readonly CoWorkTaskLockInput[]) => Promise<readonly string[]>) {
      const [assignee] = scope.assigneeConnectionId ? await tx.select({ id: connections.id, ownerUserId: connections.ownerUserId,
        revokedAt: connections.revokedAt, scopes: connections.scopes }).from(connections)
        .where(and(eq(connections.workspaceId, scope.workspaceId), eq(connections.id, scope.assigneeConnectionId))).for('share') : [];
      const slotted = [...new Set([scope.holderConnectionId, ...(assignee ? [assignee.id] : [])])].sort();
      await tx.execute(sql`INSERT INTO cowork_connection_slots(connection_id, workspace_id)
        SELECT id, workspace_id FROM agent_connections WHERE workspace_id = ${scope.workspaceId}
          AND id IN (${sql.join(slotted.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id
        ON CONFLICT DO NOTHING`);
      await tx.select().from(slots).where(and(eq(slots.workspaceId, scope.workspaceId), inArray(slots.connectionId, slotted)))
        .orderBy(asc(slots.connectionId)).for('update');
      // The unit's task and lineage are immutable; read them before any task lock, then lock the complete set.
      const [located] = await tx.select().from(units).where(and(inProject(scope), eq(units.id, scope.unitId)));
      if (!located) return { unit: null, openRequests: 0, assignee: null, runUnits: [], now: await fresh(), taskFence: null };
      const inputs: CoWorkTaskLockInput[] = [{ id: located.id, taskId: located.taskId, projectId: located.projectId,
        lineageTaskId: located.lineageTaskId }];
      const additional = await prepareTasks(inputs);
      const taskIds = [...new Set([located.taskId, located.lineageTaskId, ...additional])].sort();
      // #238: the one sorted task pass is the shared use fence; it refuses a missing or creation-undone task.
      const taskFence = await taskUseRows(tx).lockPrepared(taskIds);
      const [locked] = await tx.select().from(units).where(and(inProject(scope), eq(units.id, scope.unitId))).for('update');
      if (!locked) return { unit: null, openRequests: 0, assignee: null, runUnits: [], now: await fresh(), taskFence };
      // Every unit of a run changes only under its task row lock, held above.
      const runUnits = await tx.select({ id: units.id, role: units.role, assignmentConnectionId: units.assignmentConnectionId,
        ownerUserId: connections.ownerUserId }).from(units)
        .leftJoin(connections, and(eq(connections.workspaceId, units.workspaceId), eq(connections.id, units.assignmentConnectionId)))
        .where(and(inProject(scope), eq(units.lineageTaskId, locked.lineageTaskId), eq(units.runId, locked.runId))).orderBy(asc(units.id));
      const [selected] = assignee ? await tx.select({ projectId: schema.agentConnectionProjects.projectId })
        .from(schema.agentConnectionProjects).where(and(eq(schema.agentConnectionProjects.workspaceId, scope.workspaceId),
          eq(schema.agentConnectionProjects.connectionId, assignee.id), eq(schema.agentConnectionProjects.projectId, scope.projectId))) : [];
      // Admissions and request claims for this unit hold its assignee's slot through commit, so the count is stable.
      const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(requests)
        .where(and(eq(requests.workspaceId, scope.workspaceId), eq(requests.projectId, scope.projectId), eq(requests.unitId, locked.id),
          inArray(requests.state, ['queued', 'deferred', 'claimed']), sql`${requests.expiresAt} > clock_timestamp()`));
      // Fresh wall time AFTER every lock wait; this fences the holder's lease.
      const now = await fresh();
      return {
        unit: unit(locked),
        openRequests: open?.n ?? 0,
        assignee: assignee && !assignee.revokedAt && assignee.scopes.includes('flux.action.execute') && selected
          ? { id: assignee.id, ownerUserId: assignee.ownerUserId } : null,
        runUnits, now, taskFence,
      };
    },
    /** Completed with its outcome under the live fence; null if the fence, version or open-request rule no longer holds. */
    async complete(scope: CoWorkUnitTransitionScope, fence: CoWorkUnitTransitionFence, outcome: CoWorkSourceRef) {
      const [row] = await tx.update(units).set({ state: 'completed', generation: sql`${units.generation} + 1`,
        version: sql`${units.version} + 1`, leaseId: null, leaseSessionId: null, leaseExpiresAt: null, outcomeRef: outcome,
        updatedAt: sql`clock_timestamp()` }).where(held(scope, fence)).returning();
      return row ? unit(row) : null;
    },
    /** Reassigned, pending, under the live fence to a still-live assignee; null if any of those no longer holds. */
    async transfer(scope: CoWorkUnitTransitionScope, fence: CoWorkUnitTransitionFence, assigneeConnectionId: string) {
      const [row] = await tx.update(units).set({ assignmentConnectionId: assigneeConnectionId, state: 'pending',
        generation: sql`${units.generation} + 1`, version: sql`${units.version} + 1`, leaseId: null, leaseSessionId: null,
        leaseExpiresAt: null, updatedAt: sql`clock_timestamp()` }).where(and(held(scope, fence), sql`EXISTS (
          SELECT 1 FROM agent_connections assignee WHERE assignee.id = ${assigneeConnectionId}::uuid
            AND assignee.workspace_id = ${scope.workspaceId}::uuid AND assignee.revoked_at IS NULL)`)).returning();
      return row ? unit(row) : null;
    },
    /** Canonical current unit for the post-state hook; content-free. */
    async unit(workspaceId: string, projectId: string, id: string) {
      const [row] = await tx.select().from(units).where(and(eq(units.workspaceId, workspaceId), eq(units.projectId, projectId), eq(units.id, id)));
      return row ? unit(row) : null;
    },
  };
}
