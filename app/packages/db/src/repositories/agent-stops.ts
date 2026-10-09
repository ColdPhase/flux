import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for stopping an external agent's work on a task (#347 S13, migration 0065). Core decides who may
 * stop and which task is held; this stores the stop and ends the agent's unfinished co-work units the way a
 * revoked connection's are ended (state `stopped`, generation and version advance, lease cleared).
 */
const units = schema.coworkUnits;
const connections = schema.agentConnections;
const w = schema.projectWorkItems;

export interface HeldTaskRow {
  id: string;
  projectId: string;
  workspaceId: string;
  number: number;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'not_pursued';
  version: number;
  ownerAgentId: string | null;
  parked: boolean;
  createdByKind: 'human' | 'agent';
  createdById: string;
}
export interface StoppedAgentRow {
  id: string;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  agent: { id: string; name: string };
  stoppedBy: { id: string; name: string };
  stoppedAt: Date;
  unitsStopped: number;
}

export function agentStopRows(tx: DbExecutor) {
  return {
    /** The agent, if it belongs to the workspace. */
    async agent(workspaceId: string, agentId: string) {
      const [row] = await tx.select({ id: schema.agents.id, name: schema.agents.name, ownerUserId: schema.agents.ownerUserId })
        .from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, agentId)));
      return row ?? null;
    },
    /**
     * The agent's connection slots, locked in ID order. Co-work claims lock slots before tasks, so a stop takes them
     * first too and the two can never wait on each other.
     */
    async lockSlots(workspaceId: string, agentId: string) {
      await tx.execute(sql`INSERT INTO cowork_connection_slots(connection_id, workspace_id)
        SELECT id, workspace_id FROM agent_connections WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId} ORDER BY id
        ON CONFLICT DO NOTHING`);
      await tx.execute(sql`SELECT 1 FROM cowork_connection_slots s JOIN agent_connections c ON c.id = s.connection_id
        WHERE c.workspace_id = ${workspaceId} AND c.agent_id = ${agentId} ORDER BY s.connection_id FOR UPDATE OF s`);
    },
    async task(projectId: string, taskId: string): Promise<HeldTaskRow | null> {
      const [row] = await tx.select({ id: w.id, projectId: w.projectId, workspaceId: w.workspaceId, number: w.number, title: w.title,
        status: w.status, version: w.version, ownerAgentId: w.ownerAgentId, parked: sql<boolean>`${w.parkedAt} IS NOT NULL`,
        createdByKind: w.createdByKind, createdById: w.createdById })
        .from(w).where(and(eq(w.projectId, projectId), eq(w.id, taskId)));
      return row ?? null;
    },
    /** Every unfinished unit of this agent's connections on the task becomes stopped; the number that did. */
    async stopUnits(workspaceId: string, projectId: string, taskId: string, agentId: string): Promise<number> {
      const mine = tx.select({ id: connections.id }).from(connections)
        .where(and(eq(connections.workspaceId, workspaceId), eq(connections.agentId, agentId)));
      const rows = await tx.update(units).set({ state: 'stopped', generation: sql`${units.generation} + 1`, version: sql`${units.version} + 1`,
        leaseId: null, leaseSessionId: null, leaseExpiresAt: null, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(units.workspaceId, workspaceId), eq(units.projectId, projectId), eq(units.taskId, taskId),
          notInArray(units.state, ['completed', 'stopped']), inArray(units.assignmentConnectionId, mine)))
        .returning({ id: units.id });
      return rows.length;
    },
    async insert(row: { workspaceId: string; projectId: string; taskId: string; agentId: string; stoppedBy: string; unitsStopped: number }) {
      const id = randomUUID();
      await tx.insert(schema.agentStops).values({ id, ...row });
      return id;
    },
    async ownedWorking(userId: string, limit: number) {
      const rows = await tx.select({ agentId: schema.agents.id, agentName: schema.agents.name, taskId: w.id, projectId: w.projectId, projectName: schema.projects.name,
        number: w.number, title: w.title }).from(w)
        .innerJoin(schema.agents, eq(schema.agents.id, w.ownerAgentId)).innerJoin(schema.projects, eq(schema.projects.id, w.projectId))
        .where(and(eq(schema.agents.ownerUserId, userId), isNull(schema.agents.revokedAt), eq(w.status, 'in_progress'), isNull(w.parkedAt)))
        .orderBy(desc(w.updatedAt), desc(w.id)).limit(limit);
      // Online: an unrevoked connection of the agent has a session that is unexpired, on its binding's current generation, of an enabled client.
      const live = new Set<string>();
      const agentIds = [...new Set(rows.map((row) => row.agentId))];
      if (agentIds.length) {
        const sessions = tx.select({ agentId: connections.agentId }).from(schema.agentRuntimeSessions)
          .innerJoin(connections, eq(connections.id, schema.agentRuntimeSessions.connectionId))
          .innerJoin(schema.agentOauthBindings, and(eq(schema.agentOauthBindings.id, schema.agentRuntimeSessions.bindingId),
            eq(schema.agentOauthBindings.generation, schema.agentRuntimeSessions.bindingGeneration)))
          .innerJoin(schema.oauthClient, and(eq(schema.oauthClient.clientId, schema.agentOauthBindings.clientId),
            or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled))))
          .where(and(inArray(connections.agentId, agentIds), isNull(connections.revokedAt), isNull(schema.agentRuntimeSessions.revokedAt),
            gt(schema.agentRuntimeSessions.expiresAt, sql`now()`)));
        for (const row of await sessions) live.add(row.agentId);
      }
      // Signed in: a client has ever opened a session for one of the agent's connections.
      const signed = new Set<string>();
      if (agentIds.length) {
        for (const row of await tx.selectDistinct({ agentId: connections.agentId }).from(schema.agentRuntimeSessions)
          .innerJoin(connections, eq(connections.id, schema.agentRuntimeSessions.connectionId))
          .where(inArray(connections.agentId, agentIds))) signed.add(row.agentId);
      }
      return rows.map((row) => ({ agent: { id: row.agentId, name: row.agentName },
        task: { id: row.taskId, projectId: row.projectId, projectName: row.projectName, number: row.number, title: row.title },
        online: live.has(row.agentId), signedIn: signed.has(row.agentId) }));
    },
    async get(id: string) { return (await this.list({ id }))[0] ?? null; },
    /** Newest first. */
    async list(scope: { projectId: string } | { id: string }, limit = 20): Promise<StoppedAgentRow[]> {
      const s = schema.agentStops;
      const rows = await tx.select({ id: s.id, taskId: s.taskId, taskNumber: w.number, taskTitle: w.title, agentId: s.agentId,
        agentName: schema.agents.name, stoppedById: s.stoppedBy, stoppedByName: schema.authUsers.name, stoppedAt: s.stoppedAt, unitsStopped: s.unitsStopped })
        .from(s).innerJoin(w, eq(w.id, s.taskId)).innerJoin(schema.agents, eq(schema.agents.id, s.agentId))
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, s.stoppedBy))
        .where('id' in scope ? eq(s.id, scope.id) : eq(s.projectId, scope.projectId)).orderBy(desc(s.stoppedAt), desc(s.id)).limit(limit);
      return rows.map((row) => ({ id: row.id, taskId: row.taskId, taskNumber: row.taskNumber, taskTitle: row.taskTitle,
        agent: { id: row.agentId, name: row.agentName }, stoppedBy: { id: row.stoppedById, name: row.stoppedByName },
        stoppedAt: row.stoppedAt, unitsStopped: row.unitsStopped }));
    },
  };
}
