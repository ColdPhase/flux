import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { CoWorkTaskLockInput } from './cowork.js';
import type { DbExecutor } from './push.js';

// Authorized unit creation (#153). Storage only: the server composition has already run #152 preparation
// (current bearer/runtime/grant/command ledger) in this same outer transaction. No grant, receipt, request
// lineage, request, claim, stream event or model invocation is written here.
const units = schema.coworkUnits, slots = schema.coworkConnectionSlots, connections = schema.agentConnections;
type UnitRow = typeof units.$inferSelect;
export interface CoWorkUnitCreationScope {
  workspaceId: string;
  projectId: string;
  creatorConnectionId: string;
  assigneeConnectionId: string;
  /** The native task the command targets; prepare has already checked it belongs to this project. */
  taskId: string;
  parentUnitId: string | null;
  /** The server-derived run a root would open; ignored for a child, which inherits its parent's run. */
  rootRunId: string;
  unitKey: string;
}
function unit(row: UnitRow) {
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, taskId: row.taskId,
    lineageTaskId: row.lineageTaskId, runId: row.runId, unitKey: row.unitKey, role: row.role,
    assignmentConnectionId: row.assignmentConnectionId, state: row.state, version: row.version, generation: row.generation,
    lease: row.leaseId ? { id: row.leaseId, runtimeSessionId: row.leaseSessionId!, expiresAt: row.leaseExpiresAt! } : null };
}
export type CoWorkCreatedUnitRecord = ReturnType<typeof unit>;
const clock = sql<Date>`clock_timestamp()`.mapWith((value: Date | string) => new Date(value instanceof Date ? value.getTime() : value));

export function coworkUnitCreationRows(tx: DbExecutor) {
  const inProject = (scope: { workspaceId: string; projectId: string }) =>
    and(eq(units.workspaceId, scope.workspaceId), eq(units.projectId, scope.projectId));
  return {
    /**
     * Assignee connection row (FOR SHARE) -> sorted creator/assignee slots -> caller's graph locks/dependencies ->
     * complete sorted task set -> parent unit row. The share lock serializes with revocation/deletion of the
     * assignee: a revocation that commits first refuses this creation; one that waits stops the new unit.
     * Everything returned is read after those waits; `now` is fresh wall time after the last of them.
     */
    async lock(scope: CoWorkUnitCreationScope, prepareTasks: (units: readonly CoWorkTaskLockInput[]) => Promise<readonly string[]>) {
      const [assignee] = await tx.select({ id: connections.id, ownerUserId: connections.ownerUserId, revokedAt: connections.revokedAt,
        scopes: connections.scopes }).from(connections)
        .where(and(eq(connections.workspaceId, scope.workspaceId), eq(connections.id, scope.assigneeConnectionId))).for('share');
      const slotted = [...new Set([scope.creatorConnectionId, ...(assignee ? [assignee.id] : [])])].sort();
      await tx.execute(sql`INSERT INTO cowork_connection_slots(connection_id, workspace_id)
        SELECT id, workspace_id FROM agent_connections WHERE workspace_id = ${scope.workspaceId}
          AND id IN (${sql.join(slotted.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id
        ON CONFLICT DO NOTHING`);
      await tx.select().from(slots).where(and(eq(slots.workspaceId, scope.workspaceId), inArray(slots.connectionId, slotted)))
        .orderBy(asc(slots.connectionId)).for('update');
      const [parent] = scope.parentUnitId ? await tx.select().from(units).where(and(inProject(scope),
        eq(units.id, scope.parentUnitId), eq(units.assignmentConnectionId, scope.creatorConnectionId))) : [];
      const inputs: CoWorkTaskLockInput[] = [{ id: parent?.id ?? scope.taskId, taskId: scope.taskId, projectId: scope.projectId,
        lineageTaskId: parent?.lineageTaskId ?? scope.taskId }];
      if (parent && parent.taskId !== scope.taskId)
        inputs.push({ id: parent.id, taskId: parent.taskId, projectId: parent.projectId, lineageTaskId: parent.lineageTaskId });
      const additional = await prepareTasks(inputs);
      const taskIds = [...new Set([...inputs.flatMap((input) => [input.taskId, input.lineageTaskId]), ...additional])].sort();
      const tasks = await tx.select({ id: schema.projectWorkItems.id }).from(schema.projectWorkItems)
        .where(and(eq(schema.projectWorkItems.workspaceId, scope.workspaceId), inArray(schema.projectWorkItems.id, taskIds)))
        .orderBy(asc(schema.projectWorkItems.id)).for('update');
      if (tasks.length !== taskIds.length) throw new Error('The complete native task lock set is unavailable');
      const [lockedParent] = parent ? await tx.select().from(units).where(and(inProject(scope), eq(units.id, parent.id),
        eq(units.assignmentConnectionId, scope.creatorConnectionId))).for('update') : [];
      const [task] = await tx.select({ id: schema.projectWorkItems.id, version: schema.projectWorkItems.version,
        status: schema.projectWorkItems.status }).from(schema.projectWorkItems).where(and(
        eq(schema.projectWorkItems.workspaceId, scope.workspaceId), eq(schema.projectWorkItems.projectId, scope.projectId),
        eq(schema.projectWorkItems.id, scope.taskId)));
      // Every unit of a run and every open unit of a task change only under their task row lock, held above.
      const lineageTaskId = lockedParent?.lineageTaskId ?? scope.taskId, runId = lockedParent?.runId ?? scope.rootRunId;
      const runUnits = await tx.select({ id: units.id, role: units.role, assignmentConnectionId: units.assignmentConnectionId,
        ownerUserId: connections.ownerUserId }).from(units)
        .leftJoin(connections, and(eq(connections.workspaceId, units.workspaceId), eq(connections.id, units.assignmentConnectionId)))
        .where(and(inProject(scope), eq(units.lineageTaskId, lineageTaskId), eq(units.runId, runId))).orderBy(asc(units.id));
      const openTaskUnits = await tx.select({ id: units.id, role: units.role }).from(units)
        .where(and(inProject(scope), eq(units.taskId, scope.taskId), inArray(units.state, ['pending', 'claimed', 'paused'])))
        .orderBy(asc(units.id));
      const [existing] = await tx.select().from(units).where(and(inProject(scope), eq(units.taskId, scope.taskId),
        eq(units.runId, runId), eq(units.unitKey, scope.unitKey)));
      const [selected] = assignee ? await tx.select({ projectId: schema.agentConnectionProjects.projectId })
        .from(schema.agentConnectionProjects).where(and(eq(schema.agentConnectionProjects.workspaceId, scope.workspaceId),
          eq(schema.agentConnectionProjects.connectionId, assignee.id), eq(schema.agentConnectionProjects.projectId, scope.projectId))) : [];
      // Fresh wall time AFTER every lock wait; this fences the parent's lease.
      const [time] = await tx.select({ now: clock }).from(schema.projectWorkItems).where(eq(schema.projectWorkItems.id, scope.taskId));
      return {
        task: task ?? null,
        parent: lockedParent ? unit(lockedParent) : null,
        assignee: assignee && !assignee.revokedAt && assignee.scopes.includes('flux.action.execute') && selected
          ? { id: assignee.id, ownerUserId: assignee.ownerUserId } : null,
        existing: existing ? unit(existing) : null,
        runUnits, openTaskUnits, now: time!.now,
      };
    },
    /** Insert under the retained locks; null only if the exact intent appeared without them (caller refuses). */
    async insert(scope: { workspaceId: string; projectId: string }, input: { taskId: string; lineageTaskId: string; runId: string;
      unitKey: string; role: CoWorkCreatedUnitRecord['role']; assignmentConnectionId: string }) {
      const [row] = await tx.insert(units).values({ id: randomUUID(), workspaceId: scope.workspaceId, projectId: scope.projectId,
        taskId: input.taskId, lineageTaskId: input.lineageTaskId, runId: input.runId, unitKey: input.unitKey, role: input.role,
        assignmentConnectionId: input.assignmentConnectionId })
        .onConflictDoNothing({ target: [units.workspaceId, units.projectId, units.taskId, units.runId, units.unitKey] }).returning();
      return row ? unit(row) : null;
    },
    /** Canonical current unit for the post-state hook and replay; content-free. */
    async unit(workspaceId: string, projectId: string, id: string) {
      const [row] = await tx.select().from(units).where(and(eq(units.workspaceId, workspaceId), eq(units.projectId, projectId), eq(units.id, id)));
      return row ? unit(row) : null;
    },
  };
}
