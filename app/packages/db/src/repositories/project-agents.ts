import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AgentOperation, ProjectAgentConnection, ProjectAgents } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Reader = { id: string; kind: 'human' };
type Action = 'project.read' | 'project.write';

/** The composition root supplies the existing #29 policy; this adapter never decides access itself. */
export interface ProjectAgentPolicy {
  /** Throws the policy's not-found/forbidden error unless the reader can read the project now. */
  authorizeRead(reader: Reader, projectId: string, tx: Transaction): Promise<void>;
  /** Whether this human or agent may perform `action` on the project now. */
  allows(principal: { id: string; kind: 'human' | 'agent' }, action: Action, projectId: string, tx: Transaction): Promise<boolean>;
}

/** Lease renewals are heartbeats: never shown as activity (#136 AC-1). */
const QUIET_OPERATIONS: AgentOperation[] = ['cowork.renew'];

/**
 * Agents view projection (UI116-2, #136): current connections selected for one project, with a
 * state derived only from server records. A configured or offline connection never looks busy,
 * and a connection MCP would refuse now never looks connected.
 */
export function projectAgentRepository(db: Database, policy: ProjectAgentPolicy) {
  return {
    list(reader: Reader, projectId: string): Promise<ProjectAgents> {
      return db.transaction(async (tx) => {
        await policy.authorizeRead(reader, projectId, tx);
        // One request answers each (principal, action, project) question once, however many connections share it.
        const decided = new Map<string, Promise<boolean>>();
        const allows = (principal: { id: string; kind: 'human' | 'agent' }, action: Action, project: string) => {
          const key = `${principal.kind}:${principal.id}:${action}:${project}`;
          if (!decided.has(key)) decided.set(key, policy.allows(principal, action, project, tx));
          return decided.get(key)!;
        };
        const candidates = await tx.select({ connection: schema.agentConnections, agentName: schema.agents.name, ownerName: schema.authUsers.name })
          .from(schema.agentConnectionProjects)
          .innerJoin(schema.agentConnections, and(eq(schema.agentConnections.id, schema.agentConnectionProjects.connectionId),
            isNull(schema.agentConnections.revokedAt)))
          .innerJoin(schema.agents, and(eq(schema.agents.id, schema.agentConnections.agentId),
            eq(schema.agents.ownerUserId, schema.agentConnections.ownerUserId), isNull(schema.agents.revokedAt)))
          .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.agentConnections.ownerUserId))
          .where(eq(schema.agentConnectionProjects.projectId, projectId))
          .orderBy(asc(schema.authUsers.name), asc(schema.agentConnections.createdAt), asc(schema.agentConnections.id));
        // A connection is listed only while both its agent and its owner can still read this project.
        const current = [];
        for (const row of candidates) {
          if (await allows({ kind: 'agent', id: row.connection.agentId }, 'project.read', projectId)
            && await allows({ kind: 'human', id: row.connection.ownerUserId }, 'project.read', projectId)) current.push(row);
        }
        if (!current.length) return { projectId, connections: [] };
        const ids = current.map((row) => row.connection.id);

        // Usable now = what MCP requires of the whole connection: the level its scopes need on every
        // selected project (see agent-connections.ts resolveCurrent). Otherwise it is unavailable.
        const selections = new Map<string, string[]>();
        for (const row of await tx.select({ connectionId: schema.agentConnectionProjects.connectionId, projectId: schema.agentConnectionProjects.projectId })
          .from(schema.agentConnectionProjects).where(inArray(schema.agentConnectionProjects.connectionId, ids))) {
          selections.set(row.connectionId, [...(selections.get(row.connectionId) ?? []), row.projectId]);
        }
        const usable = new Set<string>();
        for (const { connection } of current) {
          const action: Action = connection.scopes.some((scope) => scope !== 'flux.context.read') ? 'project.write' : 'project.read';
          let ok = true;
          for (const selected of selections.get(connection.id) ?? []) {
            if (!await allows({ kind: 'agent', id: connection.agentId }, action, selected)) { ok = false; break; }
          }
          if (ok) usable.add(connection.id);
        }

        // Authorized before = a token was issued for one of its bindings, or a client ever opened a session.
        // Choosing a connection on the consent page alone creates a binding, not an authorization.
        const bindings = await tx.select({ id: schema.agentOauthBindings.id, connectionId: schema.agentOauthBindings.connectionId })
          .from(schema.agentOauthBindings).where(inArray(schema.agentOauthBindings.connectionId, ids));
        const byReference = new Map<string, string>(ids.map((id) => [id, id]));
        for (const binding of bindings) byReference.set(`flux-grant:${binding.id}`, binding.connectionId);
        const references = [...byReference.keys()];
        const authorized = new Set<string>();
        for (const table of [schema.oauthAccessToken, schema.oauthRefreshToken]) {
          for (const row of await tx.selectDistinct({ reference: table.referenceId }).from(table).where(inArray(table.referenceId, references))) {
            if (row.reference) authorized.add(byReference.get(row.reference)!);
          }
        }
        for (const row of await tx.selectDistinct({ connectionId: schema.agentRuntimeSessions.connectionId })
          .from(schema.agentRuntimeSessions).where(inArray(schema.agentRuntimeSessions.connectionId, ids))) authorized.add(row.connectionId);

        // An open session: unrevoked, unexpired, on the binding's current generation, of an enabled client.
        const sessions = new Map<string, { startedAt: Date; expiresAt: Date }>();
        for (const row of await tx.selectDistinctOn([schema.agentRuntimeSessions.connectionId], { connectionId: schema.agentRuntimeSessions.connectionId,
          startedAt: schema.agentRuntimeSessions.createdAt, expiresAt: schema.agentRuntimeSessions.expiresAt })
          .from(schema.agentRuntimeSessions)
          .innerJoin(schema.agentOauthBindings, and(eq(schema.agentOauthBindings.id, schema.agentRuntimeSessions.bindingId),
            eq(schema.agentOauthBindings.generation, schema.agentRuntimeSessions.bindingGeneration)))
          .innerJoin(schema.oauthClient, and(eq(schema.oauthClient.clientId, schema.agentOauthBindings.clientId),
            or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled))))
          .where(and(inArray(schema.agentRuntimeSessions.connectionId, ids), isNull(schema.agentRuntimeSessions.revokedAt),
            gt(schema.agentRuntimeSessions.expiresAt, sql`now()`)))
          .orderBy(schema.agentRuntimeSessions.connectionId, desc(schema.agentRuntimeSessions.createdAt))) sessions.set(row.connectionId, row);

        const activity = new Map<string, { operation: AgentOperation; at: Date }>();
        for (const row of await tx.selectDistinctOn([schema.agentCommandReceipts.connectionId], { connectionId: schema.agentCommandReceipts.connectionId,
          operation: schema.agentCommandReceipts.operation, at: schema.agentCommandReceipts.completedAt })
          .from(schema.agentCommandReceipts)
          .where(and(eq(schema.agentCommandReceipts.projectId, projectId), inArray(schema.agentCommandReceipts.connectionId, ids),
            ...QUIET_OPERATIONS.map((operation) => ne(schema.agentCommandReceipts.operation, operation))))
          .orderBy(schema.agentCommandReceipts.connectionId, desc(schema.agentCommandReceipts.completedAt))) activity.set(row.connectionId, row);

        const connections = current.map(({ connection, agentName, ownerName }): ProjectAgentConnection => {
          const session = usable.has(connection.id) ? sessions.get(connection.id) : undefined;
          const last = activity.get(connection.id);
          return {
            id: connection.id, name: connection.name, clientDesignation: connection.clientDesignation,
            owner: { id: connection.ownerUserId, name: ownerName }, agent: { id: connection.agentId, name: agentName },
            own: connection.ownerUserId === reader.id,
            state: !usable.has(connection.id) ? 'unavailable' : session ? 'session_open' : authorized.has(connection.id) ? 'offline' : 'not_signed_in',
            session: session ? { startedAt: session.startedAt.toISOString(), expiresAt: session.expiresAt.toISOString() } : null,
            lastActivity: last ? { operation: last.operation, at: last.at.toISOString() } : null,
          };
        });
        return { projectId, connections };
      });
    },
  };
}
