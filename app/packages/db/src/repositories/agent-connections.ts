import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { AgentConnection, AgentMcpPolicy, CreateAgentConnectionCommand } from '@flux/contracts';
// Structural adapter inputs avoid the current core/db build cycle; core owns the port.
type AgentOauthFlow = { fingerprint: string; clientId: string; scopes: readonly string[]; expiresAt: Date };
type AgentOauthGrant = { referenceId: string; clientId: string | null; connection: AgentConnection };
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { initializeAgentMcpPolicy, lockAgentMcpPolicy } from './agent-mcp-policy.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = typeof schema.agentConnections.$inferSelect;

export interface AgentConnectionPolicy {
  initialMcpPolicy(connection: AgentConnection): AgentMcpPolicy;
  authorizeProject(agentId: string, projectId: string, action: 'project.read' | 'project.write', tx: Transaction): Promise<string>;
}

function serialize(row: Row, selectedProjectIds: string[]): AgentConnection {
  return {
    id: row.id, workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: row.agentId,
    name: row.name, clientDesignation: row.clientDesignation,
    selectedProjectIds, scopes: [...row.scopes], computeSource: row.computeSource,
    revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

/** SQL and locking; the composition root supplies the existing #29 policy. */
export function agentConnectionRepository(db: Database, policy: AgentConnectionPolicy) {
  const projects = async (tx: Transaction, id: string) => (await tx.select({ id: schema.agentConnectionProjects.projectId })
    .from(schema.agentConnectionProjects).where(eq(schema.agentConnectionProjects.connectionId, id)))
    .map((row) => row.id);

  const resolveCurrent = async (tx: Transaction, ownerUserId: string, connectionId: string, mcp = false) => {
    const [row] = await tx.select().from(schema.agentConnections).where(and(
      eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId),
      isNull(schema.agentConnections.revokedAt))).for('share');
    if (!row) return null;
    const selectedProjectIds = await projects(tx, row.id);
    const connection = serialize(row, selectedProjectIds);
    if (mcp) {
      await initializeAgentMcpPolicy(tx, connection, policy.initialMcpPolicy);
      if (!await lockAgentMcpPolicy(tx, row.id)) return null;
    }
    const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(
      eq(schema.agents.id, row.agentId), eq(schema.agents.ownerUserId, ownerUserId),
      isNull(schema.agents.revokedAt))).for('share');
    if (!agent) return null;
    if (!selectedProjectIds.length) return null;
    if (!mcp) {
      const action = row.scopes.some((scope) => scope === 'flux.proposal.write' || scope === 'flux.action.execute') ? 'project.write' : 'project.read';
      for (const projectId of selectedProjectIds.sort()) {
        if (await policy.authorizeProject(row.agentId, projectId, action, tx) !== row.workspaceId) return null;
      }
    }
    return connection;
  };

  const resolveFlow = async (tx: Transaction, ownerUserId: string, sessionId: string, fingerprint: string): Promise<AgentOauthGrant | null> => {
    const [row] = await tx.select({ binding: schema.agentOauthBindings }).from(schema.agentOauthFlows)
      .innerJoin(schema.authSessions, and(eq(schema.authSessions.id, schema.agentOauthFlows.sessionId), eq(schema.authSessions.userId, ownerUserId),
        gt(schema.authSessions.expiresAt, new Date())))
      .innerJoin(schema.agentOauthBindings, eq(schema.agentOauthBindings.id, schema.agentOauthFlows.bindingId))
      .where(and(eq(schema.agentOauthFlows.ownerUserId, ownerUserId), eq(schema.agentOauthFlows.sessionId, sessionId),
        eq(schema.agentOauthFlows.fingerprint, fingerprint), gt(schema.agentOauthFlows.expiresAt, new Date()))).for('share');
    if (!row || row.binding.ownerUserId !== ownerUserId) return null;
    const connection = await resolveCurrent(tx, ownerUserId, row.binding.connectionId);
    return connection ? { referenceId: `flux-grant:${row.binding.id}`, clientId: row.binding.clientId, connection } : null;
  };

  const repository = {
    async create(ownerUserId: string, command: CreateAgentConnectionCommand): Promise<AgentConnection | 'AGENT_NOT_FOUND'> {
      return db.transaction(async (tx) => {
        const [agent] = await tx.select({ workspaceId: schema.agents.workspaceId }).from(schema.agents).where(and(
          eq(schema.agents.id, command.agentId), eq(schema.agents.ownerUserId, ownerUserId),
          isNull(schema.agents.revokedAt))).for('share');
        if (!agent) return 'AGENT_NOT_FOUND';
        const action = command.scopes.some((scope) => scope === 'flux.proposal.write' || scope === 'flux.action.execute') ? 'project.write' : 'project.read';
        for (const projectId of [...command.selectedProjectIds].sort()) {
          const workspaceId = await policy.authorizeProject(command.agentId, projectId, action, tx);
          if (workspaceId !== agent.workspaceId) return 'AGENT_NOT_FOUND';
        }
        const [created] = await tx.insert(schema.agentConnections).values({
          id: randomUUID(), workspaceId: agent.workspaceId, ownerUserId, agentId: command.agentId,
          scopes: command.scopes,
          name: command.name, clientDesignation: command.clientDesignation, computeSource: 'user_operated_external_client',
        }).returning();
        await tx.insert(schema.agentConnectionProjects).values(command.selectedProjectIds.map((projectId) => ({
          workspaceId: agent.workspaceId, connectionId: created!.id, projectId,
        })));
        const connection = serialize(created!, command.selectedProjectIds);
        await initializeAgentMcpPolicy(tx, connection, policy.initialMcpPolicy);
        return connection;
      });
    },

    list(ownerUserId: string): Promise<AgentConnection[]> {
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(schema.agentConnections)
          .where(eq(schema.agentConnections.ownerUserId, ownerUserId))
          .orderBy(desc(schema.agentConnections.createdAt), desc(schema.agentConnections.id));
        return Promise.all(rows.map(async (row) => serialize(row, await projects(tx, row.id))));
      });
    },

    revoke(ownerUserId: string, connectionId: string): Promise<boolean> {
      return db.transaction(async (tx) => (await tx.update(schema.agentConnections)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId),
          isNull(schema.agentConnections.revokedAt))).returning({ id: schema.agentConnections.id })).length > 0);
    },

    resolve(ownerUserId: string, connectionId: string): Promise<AgentConnection | null> {
      return db.transaction((tx) => resolveCurrent(tx, ownerUserId, connectionId));
    },

    async chooseFlow(ownerUserId: string, sessionId: string, connectionId: string, flow: AgentOauthFlow): Promise<'SELECTED' | 'CONNECTION_NOT_FOUND' | 'ALREADY_SELECTED'> {
      return db.transaction(async (tx) => {
        const [session] = await tx.select({ id: schema.authSessions.id }).from(schema.authSessions).where(and(
          eq(schema.authSessions.id, sessionId), eq(schema.authSessions.userId, ownerUserId),
          gt(schema.authSessions.expiresAt, new Date()))).for('share');
        const connection = session ? await resolveCurrent(tx, ownerUserId, connectionId) : null;
        if (!connection || flow.expiresAt <= new Date() || flow.scopes.some((scope) => scope !== 'offline_access' && !connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write' | 'flux.action.execute')))
          return 'CONNECTION_NOT_FOUND';
        const [client] = await tx.select({ id: schema.oauthClient.clientId }).from(schema.oauthClient)
          .where(and(eq(schema.oauthClient.clientId, flow.clientId), or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled)))).for('share');
        if (!client) return 'CONNECTION_NOT_FOUND';
        const key = and(eq(schema.agentOauthBindings.ownerUserId, ownerUserId), eq(schema.agentOauthBindings.connectionId, connectionId),
          eq(schema.agentOauthBindings.clientId, flow.clientId));
        await tx.insert(schema.agentOauthBindings).values({ id: randomUUID(), ownerUserId, connectionId, clientId: flow.clientId }).onConflictDoNothing();
        const [binding] = await tx.select().from(schema.agentOauthBindings).where(key);
        await tx.insert(schema.agentOauthFlows).values({ ownerUserId, sessionId, fingerprint: flow.fingerprint,
          bindingId: binding!.id, expiresAt: flow.expiresAt }).onConflictDoNothing();
        const [selected] = await tx.select().from(schema.agentOauthFlows).where(and(eq(schema.agentOauthFlows.ownerUserId, ownerUserId),
          eq(schema.agentOauthFlows.sessionId, sessionId), eq(schema.agentOauthFlows.fingerprint, flow.fingerprint))).for('share');
        return selected?.bindingId === binding!.id && selected.expiresAt > new Date() ? 'SELECTED' : 'ALREADY_SELECTED';
      });
    },

    flowForOauth(ownerUserId: string, sessionId: string, fingerprint: string): Promise<AgentOauthGrant | null> {
      return db.transaction((tx) => resolveFlow(tx, ownerUserId, sessionId, fingerprint));
    },

    consentForOauth(ownerUserId: string, sessionId: string, flow: AgentOauthFlow) {
      return db.transaction(async (tx) => {
        const grant = await resolveFlow(tx, ownerUserId, sessionId, flow.fingerprint);
        if (!grant || grant.clientId !== flow.clientId || flow.scopes.some((scope) => scope !== 'offline_access'
          && !grant.connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write' | 'flux.action.execute'))) return null;
        const [client] = await tx.select({ name: schema.oauthClient.name }).from(schema.oauthClient).where(and(
          eq(schema.oauthClient.clientId, flow.clientId), or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled)))).for('share');
        if (!client) return null;
        const [agent] = await tx.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, grant.connection.agentId));
        // resolveFlow holds the central policy's locks while these names are read.
        const selectedProjects = await tx.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects)
          .where(inArray(schema.projects.id, grant.connection.selectedProjectIds)).orderBy(schema.projects.id);
        return { clientName: client.name ?? flow.clientId, scopes: [...flow.scopes], connection: grant.connection,
          agentName: agent!.name, selectedProjects };
      });
    },

    async grantForOauth(ownerUserId: string, referenceId: string, mcp = false): Promise<AgentOauthGrant | null> {
      return db.transaction(async (tx) => {
        if (!referenceId.startsWith('flux-grant:')) {
          // Explicit old token format: never consulted by a new browser request.
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(referenceId)) return null;
          const connection = await resolveCurrent(tx, ownerUserId, referenceId, mcp);
          return connection ? { referenceId, clientId: null, connection } : null;
        }
        const bindingId = referenceId.slice('flux-grant:'.length);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bindingId)) return null;
        const [row] = await tx.select({ binding: schema.agentOauthBindings }).from(schema.agentOauthBindings)
          .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.agentOauthBindings.clientId))
          .where(and(eq(schema.agentOauthBindings.id, bindingId), eq(schema.agentOauthBindings.ownerUserId, ownerUserId),
            or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled)))).for('share');
        const binding = row?.binding;
        const connection = binding ? await resolveCurrent(tx, ownerUserId, binding.connectionId, mcp) : null;
        return binding && connection ? { referenceId, clientId: binding.clientId, connection } : null;
      });
    },

  };
  return { ...repository,
    /** Original identity/ceiling only; the caller must apply the live policy and actual project action. */
    grantForMcp: (ownerUserId: string, referenceId: string) => repository.grantForOauth(ownerUserId, referenceId, true),
  };
}
