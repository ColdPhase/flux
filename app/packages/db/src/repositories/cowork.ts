import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { taskUseRows } from './task-use.js';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

// Storage only; #152/current core policy authorizes before these transaction-bound locks.
// No standalone transaction, grant store, receipt ledger, stream event or model invocation.
const units = schema.coworkUnits;
const checkpoints = schema.coworkCheckpoints;
type UnitRow = typeof units.$inferSelect;
function unitRecord(row: UnitRow) {
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, taskId: row.taskId,
    assignmentConnectionId: row.assignmentConnectionId, role: row.role, state: row.state,
    version: row.version, generation: row.generation, checkpointId: row.checkpointId,
    lease: row.leaseId ? { id: row.leaseId, runtimeSessionId: row.leaseSessionId!, expiresAt: row.leaseExpiresAt! } : null };
}
type Unit = ReturnType<typeof unitRecord>;
interface SaveCommand {
  operation: 'claim' | 'renew' | 'release';
  expectedVersion: number;
  generation?: number;
  leaseId?: string;
  runtimeSessionId: string;
  leaseSeconds: number;
  maximumConnectionUnits: number;
}
interface StorageScope { workspaceId: string; projectId: string; connectionId: string; unitId: string }
export interface CoWorkTaskLockInput { id: string; taskId: string; projectId: string; lineageTaskId: string }
const clock = sql<Date>`clock_timestamp()`.mapWith((value: Date | string) => new Date(value instanceof Date ? value.getTime() : value));

export function coworkUnitRows(tx: DbExecutor) {
  return {
    /** Current content-free exact grant target. No runtime, claim or quota is created. */
    async grantTarget(scope: StorageScope, role: Unit['role']) {
      const [row] = await tx.select({ id: units.id }).from(units).where(and(eq(units.id, scope.unitId),
        eq(units.workspaceId, scope.workspaceId), eq(units.projectId, scope.projectId),
        eq(units.assignmentConnectionId, scope.connectionId), eq(units.role, role))).for('share');
      return !!row;
    },
    /** Claim eligibility (#153): the unit's task, already locked by the caller's complete task pass. Takes no lock. */
    async claimTask(workspaceId: string, taskId: string) {
      const table = schema.projectWorkItems;
      const [row] = await tx.select({ id: table.id, projectId: table.projectId, status: table.status }).from(table)
        .where(and(eq(table.workspaceId, workspaceId), eq(table.id, taskId)));
      return row ?? null;
    },
    /** True when every material still exists in this project, whatever its version. A plain read: no late material lock. */
    async materialsPresent(workspaceId: string, projectId: string, materialIds: readonly string[]) {
      const ids = [...new Set(materialIds)];
      if (!ids.length) return true;
      const rows = await tx.select({ id: schema.projectMaterials.id }).from(schema.projectMaterials).where(and(
        eq(schema.projectMaterials.workspaceId, workspaceId), eq(schema.projectMaterials.projectId, projectId),
        inArray(schema.projectMaterials.id, ids)));
      return rows.length === ids.length;
    },
    /** One checkpoint of this unit, for a caller that already passed the claim composition's source checks. */
    async unitCheckpoint(scope: { projectId: string; unitId: string }, id: string) {
      const [row] = await tx.select().from(checkpoints).where(and(eq(checkpoints.id, id),
        eq(checkpoints.projectId, scope.projectId), eq(checkpoints.unitId, scope.unitId)));
      return row ?? null;
    },
    /** The caller holds current authorization/command locks in this same outer transaction. */
    async lock(scope: StorageScope, prepareTasks?: (units: readonly CoWorkTaskLockInput[]) => Promise<readonly string[]>) {
      await tx.insert(schema.coworkConnectionSlots).values({ workspaceId: scope.workspaceId, connectionId: scope.connectionId })
        .onConflictDoNothing();
      await tx.select().from(schema.coworkConnectionSlots).where(and(
        eq(schema.coworkConnectionSlots.workspaceId, scope.workspaceId), eq(schema.coworkConnectionSlots.connectionId, scope.connectionId),
      )).for('update');
      const own = and(eq(units.workspaceId, scope.workspaceId), eq(units.assignmentConnectionId, scope.connectionId));
      const [located] = await tx.select().from(units).where(and(own, eq(units.projectId, scope.projectId), eq(units.id, scope.unitId)));
      if (!located) return null;
      // Existing claims can belong to other tasks/projects. Gather all their task identities
      // before taking any task lock, then lock the complete set and finally the unit rows.
      const relevant = await tx.select({ id: units.id, taskId: units.taskId, projectId: units.projectId, lineageTaskId: units.lineageTaskId }).from(units)
        .where(and(own, or(eq(units.state, 'claimed'), eq(units.id, scope.unitId))));
      // The server's mandatory production policy locks every relevant project graph
      // and discovers dependencies here, before the first native task row lock.
      const additionalTasks = prepareTasks ? await prepareTasks(relevant) : [];
      const taskIds = [...new Set([...relevant.flatMap((row) => [row.taskId, row.lineageTaskId]), ...additionalTasks])].sort();
      const taskFence = prepareTasks ? await taskUseRows(tx).lockPrepared(taskIds) : await taskUseRows(tx).prepare(taskIds);
      const locked = await tx.select().from(units).where(and(own, inArray(units.id, relevant.map((row) => row.id))))
        .orderBy(asc(units.id)).for('update');
      const target = locked.find((row) => row.id === scope.unitId && row.projectId === scope.projectId);
      if (!target) return null;
      const [time] = await tx.select({ now: clock }).from(units).where(eq(units.id, target.id));
      const now = time!.now;
      const activeConnectionUnits = locked.filter((row) => row.id !== target.id && row.state === 'claimed'
        && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime()).length;
      return {
        unit: unitRecord(target), now, activeConnectionUnits, taskFence,
        /** Canonical reread under the retained unit lock; no new upstream lock acquisition. */
        async current(): Promise<Unit | null> {
          const [row] = await tx.select().from(units).where(and(own, eq(units.id, target.id), eq(units.projectId, scope.projectId)));
          return row ? unitRecord(row) : null;
        },
        /** Actual conditional persisted row, or null if the original fence/lease/capacity is lost. */
        async save(next: Unit, command: SaveCommand): Promise<Unit | null> {
          if (!Number.isSafeInteger(command.leaseSeconds) || command.leaseSeconds < 1 || command.leaseSeconds > 300
            || !Number.isSafeInteger(command.maximumConnectionUnits) || command.maximumConnectionUnits < 1)
            throw new Error('Invalid authorized lease/capacity');
          const operation = command.operation;
          const expectedGeneration = target.generation + (operation === 'renew' ? 0 : 1);
          if (next.id !== target.id || next.workspaceId !== target.workspaceId || next.projectId !== target.projectId
            || next.assignmentConnectionId !== target.assignmentConnectionId || next.role !== target.role
            || next.generation !== expectedGeneration || next.version !== target.version + 1
            || next.state !== (operation === 'release' ? 'paused' : 'claimed')
            || (operation === 'release' ? !next.checkpointId : next.checkpointId !== target.checkpointId)
            || (operation === 'release' ? next.lease !== null : !next.lease || next.lease.runtimeSessionId !== command.runtimeSessionId)
            || (operation === 'renew' && next.lease?.id !== target.leaseId))
            throw new Error('Invalid proposed claim transition');
          const base = and(own, eq(units.id, target.id), eq(units.projectId, scope.projectId),
            eq(units.version, command.expectedVersion), eq(units.generation, target.generation));
          const fence = operation === 'claim'
            ? and(or(eq(units.state, 'pending'), eq(units.state, 'paused'),
              and(eq(units.state, 'claimed'), sql`${units.leaseExpiresAt} <= clock_timestamp()`)),
              sql`(SELECT count(*) FROM cowork_units occupied WHERE occupied.assignment_connection_id = ${scope.connectionId}
                AND occupied.id <> ${target.id} AND occupied.state = 'claimed'
                AND occupied.lease_expires_at > clock_timestamp()) < ${command.maximumConnectionUnits}`)
            : and(eq(units.state, 'claimed'), eq(units.generation, command.generation ?? -1),
              eq(units.leaseId, command.leaseId ?? '00000000-0000-0000-0000-000000000000'),
              eq(units.leaseSessionId, command.runtimeSessionId), sql`${units.leaseExpiresAt} > clock_timestamp()`);
          const checkpointFence = operation === 'release' ? sql`EXISTS (
            SELECT 1 FROM cowork_checkpoints checkpoint WHERE checkpoint.id = ${next.checkpointId}::uuid
              AND checkpoint.unit_id = ${target.id} AND checkpoint.workspace_id = ${scope.workspaceId}
              AND checkpoint.project_id = ${scope.projectId} AND checkpoint.connection_id = ${scope.connectionId}
              AND checkpoint.generation = ${target.generation} AND checkpoint.runtime_session_id = ${command.runtimeSessionId}
          )` : sql`true`;
          const [saved] = await tx.update(units).set({ state: next.state, generation: next.generation, version: next.version,
            checkpointId: next.checkpointId, leaseId: next.lease?.id ?? null,
            leaseSessionId: next.lease?.runtimeSessionId ?? null,
            leaseExpiresAt: operation === 'release' ? null : sql`clock_timestamp() + (${command.leaseSeconds} * interval '1 second')`,
            updatedAt: sql`clock_timestamp()` }).where(and(base, fence, checkpointFence)).returning();
          if (saved) await taskFence.mark();
          return saved ? unitRecord(saved) : null;
        },
        /** Metadata lookup only; the composition root also checks each checkpoint source now. */
        async checkpoint(id: string) {
          const [row] = await tx.select().from(checkpoints).where(and(eq(checkpoints.id, id),
            eq(checkpoints.workspaceId, scope.workspaceId), eq(checkpoints.projectId, scope.projectId), eq(checkpoints.unitId, target.id)));
          return row ?? null;
        },
        /** Insert under the current live fence; a failed enclosing completion rolls it back. */
        async insertCheckpoint(input: { id: string; generation: number; leaseId: string; runtimeSessionId: string; progress: Record<string, unknown> }) {
          const result = await tx.execute<{ id: string }>(sql`
            INSERT INTO cowork_checkpoints(id, workspace_id, project_id, unit_id, connection_id, runtime_session_id, generation, progress)
            SELECT ${input.id}::uuid, ${scope.workspaceId}::uuid, ${scope.projectId}::uuid, ${target.id}::uuid,
              ${scope.connectionId}::uuid, ${input.runtimeSessionId}, ${input.generation}, ${JSON.stringify(input.progress)}::jsonb
            FROM cowork_units current_unit WHERE current_unit.id = ${target.id} AND current_unit.workspace_id = ${scope.workspaceId}
              AND current_unit.project_id = ${scope.projectId} AND current_unit.assignment_connection_id = ${scope.connectionId}
              AND current_unit.state = 'claimed' AND current_unit.generation = ${input.generation}
              AND current_unit.lease_id = ${input.leaseId} AND current_unit.lease_session_id = ${input.runtimeSessionId}
              AND current_unit.lease_expires_at > clock_timestamp()
            RETURNING id`);
          if (result.rows.length) await taskFence.mark();
          return result.rows[0]?.id ?? null;
        },
      };
    },
  };
}
