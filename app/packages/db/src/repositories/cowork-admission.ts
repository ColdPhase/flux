import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CoWorkSourceRef } from '@flux/contracts';
import * as schema from '../schema.js';
import type { CoWorkTaskLockInput } from './cowork.js';
import { readableReferenceSet } from './cowork-recovery.js';
import type { DbExecutor } from './push.js';

// Live request admission (#153). Storage only: the server composition has already run #152
// preparation (current bearer/runtime/grant/command ledger) in this same outer transaction.
// No grant, receipt, stream event or model invocation is written here.
const units = schema.coworkUnits, slots = schema.coworkConnectionSlots, requests = schema.coworkRequests;
const lineages = schema.coworkRequestLineages;
type UnitRow = typeof units.$inferSelect;
export interface CoWorkAdmissionScope {
  workspaceId: string;
  projectId: string;
  senderConnectionId: string;
  senderUnitId: string;
  recipientConnectionId: string;
  recipientUnitId: string;
  parentRequestId: string | null;
}
function unit(row: UnitRow) {
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, taskId: row.taskId,
    lineageTaskId: row.lineageTaskId, runId: row.runId, assignmentConnectionId: row.assignmentConnectionId,
    role: row.role, state: row.state, version: row.version, generation: row.generation, checkpointId: row.checkpointId,
    lease: row.leaseId ? { id: row.leaseId, runtimeSessionId: row.leaseSessionId!, expiresAt: row.leaseExpiresAt! } : null };
}
export type CoWorkAdmissionUnit = ReturnType<typeof unit>;
const clock = sql<Date>`clock_timestamp()`.mapWith((value: Date | string) => new Date(value instanceof Date ? value.getTime() : value));

export function coworkAdmissionRows(tx: DbExecutor) {
  return {
    /**
     * Sorted sender+recipient slots -> caller's graph locks/dependencies -> complete sorted task set ->
     * sorted unit rows. The recipient slot stays held through the caller's commit, so request timestamps
     * for one recipient become visible in order (recovery cannot pass a row that commits later).
     * Returns null when the sender unit is not this connection's unit in this project.
     */
    async lock(scope: CoWorkAdmissionScope, prepareTasks: (units: readonly CoWorkTaskLockInput[]) => Promise<readonly string[]>) {
      const connections = [...new Set([scope.senderConnectionId, scope.recipientConnectionId])].sort();
      // Unknown or foreign-workspace recipients get no slot row (and no FK failure); storage refuses them later.
      await tx.execute(sql`INSERT INTO cowork_connection_slots(connection_id, workspace_id)
        SELECT id, workspace_id FROM agent_connections WHERE workspace_id = ${scope.workspaceId}
          AND id IN (${sql.join(connections.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id
        ON CONFLICT DO NOTHING`);
      await tx.select().from(slots).where(and(eq(slots.workspaceId, scope.workspaceId), inArray(slots.connectionId, connections)))
        .orderBy(asc(slots.connectionId)).for('update');
      const inProject = and(eq(units.workspaceId, scope.workspaceId), eq(units.projectId, scope.projectId));
      const [sender] = await tx.select().from(units).where(and(inProject, eq(units.id, scope.senderUnitId),
        eq(units.assignmentConnectionId, scope.senderConnectionId)));
      if (!sender) return null;
      const [recipient] = await tx.select().from(units).where(and(inProject, eq(units.id, scope.recipientUnitId)));
      const [parent] = scope.parentRequestId ? await tx.select({ taskId: requests.taskId, rootTaskId: lineages.taskId })
        .from(requests).innerJoin(lineages, eq(lineages.id, requests.lineageId)).where(and(eq(requests.id, scope.parentRequestId),
          eq(requests.workspaceId, scope.workspaceId), eq(requests.projectId, scope.projectId))) : [];
      const involved = [sender, ...(recipient && recipient.id !== sender.id ? [recipient] : [])];
      const additional = await prepareTasks(involved.map((row) => ({ id: row.id, taskId: row.taskId,
        projectId: row.projectId, lineageTaskId: row.lineageTaskId })));
      const taskIds = [...new Set([...involved.flatMap((row) => [row.taskId, row.lineageTaskId]),
        ...(parent ? [parent.taskId, parent.rootTaskId] : []), ...additional])].sort();
      const tasks = await tx.select({ id: schema.projectWorkItems.id }).from(schema.projectWorkItems)
        .where(and(eq(schema.projectWorkItems.workspaceId, scope.workspaceId), inArray(schema.projectWorkItems.id, taskIds)))
        .orderBy(asc(schema.projectWorkItems.id)).for('update');
      if (tasks.length !== taskIds.length) throw new Error('The complete native task lock set is unavailable');
      const locked = await tx.select().from(units).where(and(inProject, inArray(units.id, involved.map((row) => row.id))))
        .orderBy(asc(units.id)).for('update');
      const lockedSender = locked.find((row) => row.id === sender.id && row.assignmentConnectionId === scope.senderConnectionId);
      if (!lockedSender) return null;
      const lockedRecipient = locked.find((row) => row.id === scope.recipientUnitId) ?? null;
      const [recipientConnection] = await tx.select({ id: schema.agentConnections.id, ownerUserId: schema.agentConnections.ownerUserId,
        revokedAt: schema.agentConnections.revokedAt }).from(schema.agentConnections)
        .where(and(eq(schema.agentConnections.workspaceId, scope.workspaceId), eq(schema.agentConnections.id, scope.recipientConnectionId)));
      // Fresh wall time AFTER every lock wait; this fences the sender's lease.
      const [time] = await tx.select({ now: clock }).from(units).where(eq(units.id, lockedSender.id));
      return { sender: unit(lockedSender), recipient: lockedRecipient ? unit(lockedRecipient) : null, now: time!.now,
        recipientConnection: recipientConnection && !recipientConnection.revokedAt
          ? { id: recipientConnection.id, ownerUserId: recipientConnection.ownerUserId } : null };
    },
    /** True when every reference exists in this project at its exact recorded version. GitHub refs are never readable here. */
    async referencesReadable(workspaceId: string, projectId: string, references: readonly CoWorkSourceRef[]) {
      const result = await tx.execute<{ readable: boolean }>(sql`SELECT ${readableReferenceSet(sql`${JSON.stringify(references)}::jsonb`,
        sql`${workspaceId}::uuid`, sql`${projectId}::uuid`)} AS readable`);
      return result.rows[0]?.readable === true;
    },
    /** Canonical current request facts for the post-state hook and replay; content-free. */
    async request(workspaceId: string, projectId: string, id: string) {
      const [row] = await tx.select({ id: requests.id, senderConnectionId: requests.senderConnectionId, version: requests.version,
        state: requests.state, target: requests.target, sourceRefs: requests.sourceRefs, criteriaRefs: requests.criteriaRefs,
        lineageTaskId: lineages.taskId, runId: lineages.runId }).from(requests).innerJoin(lineages, eq(lineages.id, requests.lineageId))
        .where(and(eq(requests.id, id), eq(requests.workspaceId, workspaceId), eq(requests.projectId, projectId)));
      return row ?? null;
    },
    /** Current sender unit identity for the post-state hook; read under the retained unit lock. */
    async unit(workspaceId: string, projectId: string, id: string) {
      const [row] = await tx.select().from(units).where(and(eq(units.workspaceId, workspaceId), eq(units.projectId, projectId), eq(units.id, id)));
      return row ? unit(row) : null;
    },
  };
}
