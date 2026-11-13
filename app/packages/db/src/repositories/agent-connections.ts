import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { withoutInvisibleFormat, type AgentConnection, type ExternalClientDesignation } from '@flux/contracts';
// Structural adapter output avoids the current core/db build cycle; core owns the port.
type AgentOauthGrant = { referenceId: string; clientId: string | null; connection: AgentConnection };
import * as schema from '../schema.js';
import { companyGuestSql, isCompanyGuest } from './access.js';
import { idpStandingRepository } from './idp-standing.js';
import { settleWaitingNotices } from './assistant-changes.js';
import type { createDatabase } from '../index.js';
import type { DbExecutor } from './push.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = typeof schema.agentConnections.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT_PREFIX = 'flux-grant:';

/** A connection as the API shows it. There is no scope and no project list: a client acts with its owner's rights (F-036 AG-3, #859). */
export function serializeConnection(row: Row): AgentConnection {
  return {
    id: row.id, workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: row.agentId,
    name: row.name, clientDesignation: row.clientDesignation, computeSource: row.computeSource, mayDo: row.mayDo,
    revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The workspace of one owner's connection, or null: lets the MCP route tell a lost connection from a refused one before
 * anything else is read. Makes no access decision.
 */
export async function agentConnectionWorkspaceId(db: DbExecutor, connectionId: string, ownerUserId: string): Promise<string | null> {
  if (!UUID.test(connectionId)) return null;
  const [row] = await db.select({ workspaceId: schema.agentConnections.workspaceId }).from(schema.agentConnections)
    .where(and(eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId)));
  return row?.workspaceId ?? null;
}

/** The name an enabled OAuth client gives itself (unverified; a recognition aid only; empty when it gives none), or null when no enabled client has this id (#763 AG-6). */
export async function oauthClientName(db: DbExecutor, clientId: string): Promise<string | null> {
  const [client] = await db.select({ name: schema.oauthClient.name }).from(schema.oauthClient).where(and(
    eq(schema.oauthClient.clientId, clientId), or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled))));
  // An OAuth client names itself when it registers: what it calls itself is cleaned of direction controls and invisible characters (#1347).
  return client ? withoutInvisibleFormat(client.name ?? '') : null;
}

/** What a disconnected client had waiting for its owner can never be approved: no dead item stays in the Inbox. */
async function closeWaitingChanges(tx: Transaction, connectionIds: string[]) {
  const closed = await tx.update(schema.assistantChanges)
    .set({ state: 'refused', waitReason: null, refusal: 'Disconnected before you decided', version: sql`${schema.assistantChanges.version} + 1`, updatedAt: new Date() })
    .where(and(inArray(schema.assistantChanges.connectionId, connectionIds), isNull(schema.assistantChanges.runId), eq(schema.assistantChanges.state, 'waiting')))
    .returning({ ownerUserId: schema.assistantChanges.ownerUserId });
  // Nothing of the client waits any more, so neither does what told its owner about it (#1186).
  await settleWaitingNotices(tx as unknown as DbExecutor, closed.map((row) => row.ownerUserId));
}

/** SQL and locking. A connection is live while it is not revoked, its agent stands and its owner's account stands. */
export function agentConnectionRepository(db: Database) {
  /**
   * The live connection of this owner, or null: not revoked, its agent and its owner's account stand, and the owner is still a
   * non-guest member of the connection's company. Nothing here narrows what the client reaches: that is decided at each call by
   * the owner's rights and by the agent's "What it may do".
   */
  const resolveCurrent = async (tx: Transaction, ownerUserId: string, connectionId: string) => {
    const [row] = await tx.select().from(schema.agentConnections).where(and(
      eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId),
      isNull(schema.agentConnections.revokedAt))).for('share');
    if (!row) return null;
    // The owner's account must still stand at the identity provider (F-024 S4, #311). Nothing is revoked.
    if (await idpStandingRepository(tx).refuses(ownerUserId, { lock: true })) return null;
    const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(
      eq(schema.agents.id, row.agentId), eq(schema.agents.ownerUserId, ownerUserId),
      isNull(schema.agents.revokedAt))).for('share');
    if (!agent) return null;
    // C-22: a client lives only while its owner is a member of the company and not a guest of it. Someone removed or made a guest
    // gets no token, no refresh and no sign-in without a page, whatever the connection row still says. Nothing is revoked.
    // The company's membership row is read before the connection's own workspace's, the order a change to guest takes them in (#1003).
    const guestOfCompany = await isCompanyGuest(tx, ownerUserId, { lock: true });
    const [member] = await tx.select({ company: schema.workspaces.company }).from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId)).where(and(
        eq(schema.workspaceMembers.workspaceId, row.workspaceId), eq(schema.workspaceMembers.userId, ownerUserId),
        ne(schema.workspaceMembers.role, 'guest'))).for('share', { of: schema.workspaceMembers });
    if (!member) return null;
    // A role in the connection's own workspace is not the company's (an encrypted space is another workspace): a guest of the
    // company has no AI wherever else they are a member (AG-2, #978).
    if (guestOfCompany) return null;
    return serializeConnection(row);
  };

  const grantOfBinding = async (tx: Transaction, ownerUserId: string, binding: typeof schema.agentOauthBindings.$inferSelect): Promise<AgentOauthGrant | null> => {
    const connection = await resolveCurrent(tx, ownerUserId, binding.connectionId);
    return connection ? { referenceId: `${GRANT_PREFIX}${binding.id}`, clientId: binding.clientId, connection } : null;
  };

  /** The live binding this owner last made for this client, newest first; a revoked connection's binding is passed over. */
  const heldBinding = async (tx: Transaction, ownerUserId: string, clientId: string) => {
    const bindings = await tx.select().from(schema.agentOauthBindings)
      .where(and(eq(schema.agentOauthBindings.ownerUserId, ownerUserId), eq(schema.agentOauthBindings.clientId, clientId)))
      .orderBy(desc(schema.agentOauthBindings.createdAt), desc(schema.agentOauthBindings.id));
    for (const binding of bindings) {
      const grant = await grantOfBinding(tx, ownerUserId, binding);
      // The owner's assistant is never a client's connection: a sign-in is not carried onto it, whatever a binding says.
      if (grant && grant.connection.computeSource !== 'owner_assistant') return grant;
    }
    return null;
  };

  return {
    /** A guest of the company sees none of their clients and changes none: they are kept, hidden and refused until they are a member again (C-22, C-50). */
    list(ownerUserId: string): Promise<AgentConnection[]> {
      return db.transaction(async (tx) => (await tx.select().from(schema.agentConnections)
        .where(and(eq(schema.agentConnections.ownerUserId, ownerUserId), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`))
        .orderBy(desc(schema.agentConnections.createdAt), desc(schema.agentConnections.id))).map(serializeConnection));
    },

    /**
     * Disconnect. What this client had waiting for its owner can never be approved once the connection is gone, so the same
     * transaction closes it, and no dead item stays in the Inbox. The connection is locked first, as every change of the client is.
     */
    revoke(ownerUserId: string, connectionId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const revoked = await tx.update(schema.agentConnections)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId),
            isNull(schema.agentConnections.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`)).returning({ id: schema.agentConnections.id });
        if (!revoked.length) return false;
        await closeWaitingChanges(tx, [connectionId]);
        return true;
      });
    },

    /**
     * Disconnects every client of this person at once, for a password reset and for signing out everywhere (#989). Each live connection
     * is disconnected as the Disconnect button does it (the next sign-in of that client asks again on the consent page and gets the same
     * agent back, C-19/C-20), its runtime sessions end, and every OAuth refresh and access token of the person is revoked, so a refresh
     * token cannot mint a new access token and an access token that is still valid is refused at the next call. The owner's own assistant is
     * not a client and is left alone. Returns how many connections were disconnected.
     */
    disconnectClients(ownerUserId: string): Promise<number> {
      return db.transaction(async (tx) => {
        const now = new Date();
        const revoked = await tx.update(schema.agentConnections).set({ revokedAt: now, updatedAt: now })
          .where(and(eq(schema.agentConnections.ownerUserId, ownerUserId), isNull(schema.agentConnections.revokedAt),
            ne(schema.agentConnections.computeSource, 'owner_assistant'))).returning({ id: schema.agentConnections.id });
        const ids = revoked.map((row) => row.id);
        if (ids.length) {
          await closeWaitingChanges(tx, ids);
          await tx.update(schema.agentRuntimeSessions).set({ revokedAt: now })
            .where(and(inArray(schema.agentRuntimeSessions.connectionId, ids), isNull(schema.agentRuntimeSessions.revokedAt)));
        }
        await tx.update(schema.oauthRefreshToken).set({ revoked: now })
          .where(and(eq(schema.oauthRefreshToken.userId, ownerUserId), isNull(schema.oauthRefreshToken.revoked)));
        await tx.delete(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.userId, ownerUserId));
        return ids.length;
      });
    },

    /**
     * "What it may do" (F-036 AG-3). The row lock serializes it with every change the agent makes, which reads the
     * connection `FOR SHARE`, so a change decided after this commits uses the new choice.
     */
    setMayDo(ownerUserId: string, connectionId: string, mayDo: AgentConnection['mayDo']): Promise<AgentConnection | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx.update(schema.agentConnections).set({ mayDo, updatedAt: new Date() })
          .where(and(eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId),
            isNull(schema.agentConnections.revokedAt), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`)).returning();
        return row ? serializeConnection(row) : null;
      });
    },

    resolve(ownerUserId: string, connectionId: string): Promise<AgentConnection | null> {
      return db.transaction((tx) => resolveCurrent(tx, ownerUserId, connectionId));
    },

    /**
     * Lets one person's OAuth sign-in of one client be made at most once at a time: two consents of the same client by the same
     * person (two tabs) end in one connection, not two.
     */
    async lockClient(tx: Transaction, ownerUserId: string, clientId: string): Promise<void> {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flux-oauth-client:${ownerUserId}:${clientId}`}, 0))`);
    },

    /** The live connection this owner already has for this client, if any: a client that signs in again finds it (#312). */
    held(tx: Transaction, ownerUserId: string, clientId: string): Promise<AgentOauthGrant | null> {
      return heldBinding(tx, ownerUserId, clientId);
    },

    /** The connection's name only, for the consent screen of a client that already has one. */
    heldName(ownerUserId: string, clientId: string): Promise<string | null> {
      return db.transaction(async (tx) => (await heldBinding(tx, ownerUserId, clientId))?.connection.name ?? null);
    },

    /**
     * Where a company's agent for a first sign-in is made: the person's own company workspace (one per instance), or null when
     * the person is in none or is only a guest of it. A guest of the company gets none, whatever role another workspace (an
     * encrypted space) gives them there (C-22, AG-2, #978).
     */
    async personalWorkspaceId(tx: Transaction, ownerUserId: string): Promise<string | null> {
      if (await isCompanyGuest(tx, ownerUserId, { lock: true })) return null;
      const [member] = await tx.select({ workspaceId: schema.workspaceMembers.workspaceId }).from(schema.workspaceMembers)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
        .where(and(eq(schema.workspaceMembers.userId, ownerUserId), ne(schema.workspaceMembers.role, 'guest')))
        .orderBy(desc(schema.workspaces.company), asc(schema.workspaceMembers.createdAt), asc(schema.workspaceMembers.workspaceId)).limit(1);
      return member?.workspaceId ?? null;
    },

    /**
     * The agent an earlier connection of this client left behind (disconnected, its agent still the person's): signing in again
     * gives the same agent back, so what was assigned to it and what it did stay attributed to one identity.
     */
    async reusableAgent(tx: Transaction, ownerUserId: string, clientId: string, workspaceId: string): Promise<string | null> {
      const rows = await tx.select({ agentId: schema.agentConnections.agentId }).from(schema.agentOauthBindings)
        .innerJoin(schema.agentConnections, eq(schema.agentConnections.id, schema.agentOauthBindings.connectionId))
        .innerJoin(schema.agents, and(eq(schema.agents.id, schema.agentConnections.agentId), eq(schema.agents.ownerUserId, ownerUserId),
          eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.revokedAt)))
        .where(and(eq(schema.agentOauthBindings.ownerUserId, ownerUserId), eq(schema.agentOauthBindings.clientId, clientId),
          eq(schema.agentConnections.workspaceId, workspaceId), eq(schema.agentConnections.computeSource, 'user_operated_external_client')))
        .orderBy(desc(schema.agentOauthBindings.createdAt), desc(schema.agentOauthBindings.id));
      for (const { agentId } of rows) {
        const [live] = await tx.select({ id: schema.agentConnections.id }).from(schema.agentConnections)
          .where(and(eq(schema.agentConnections.agentId, agentId), isNull(schema.agentConnections.revokedAt))).limit(1);
        if (!live) return agentId;
      }
      return null;
    },

    /**
     * The one write of a sign-in: a connection of the person's own live agent for this client, and the binding the token's grant
     * reference points to. Runs in the caller's transaction, so the agent made for it and the connection stand or fall together.
     */
    async connect(tx: Transaction, ownerUserId: string, agent: { id: string; workspaceId: string },
      client: { clientId: string; name: string; clientDesignation: ExternalClientDesignation }): Promise<AgentOauthGrant | 'AGENT_NOT_FOUND' | 'CLIENT_NOT_FOUND'> {
      const [owned] = await tx.select({ workspaceId: schema.agents.workspaceId }).from(schema.agents).where(and(
        eq(schema.agents.id, agent.id), eq(schema.agents.workspaceId, agent.workspaceId), eq(schema.agents.ownerUserId, ownerUserId),
        isNull(schema.agents.revokedAt))).for('share');
      if (!owned) return 'AGENT_NOT_FOUND';
      const [known] = await tx.select({ id: schema.oauthClient.clientId }).from(schema.oauthClient).where(and(
        eq(schema.oauthClient.clientId, client.clientId), or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled)))).for('share');
      if (!known) return 'CLIENT_NOT_FOUND';
      const [created] = await tx.insert(schema.agentConnections).values({
        id: randomUUID(), workspaceId: owned.workspaceId, ownerUserId, agentId: agent.id,
        name: client.name, clientDesignation: client.clientDesignation, computeSource: 'user_operated_external_client',
      }).returning();
      const [binding] = await tx.insert(schema.agentOauthBindings).values({
        id: randomUUID(), ownerUserId, connectionId: created!.id, clientId: client.clientId }).returning();
      return { referenceId: `${GRANT_PREFIX}${binding!.id}`, clientId: client.clientId, connection: serializeConnection(created!) };
    },

    /**
     * A token's grant: the binding its reference names, while its client is enabled and its connection is live. Everything about
     * what the client may do is read again at each call; the grant only says who it is.
     */
    async grantForOauth(ownerUserId: string, referenceId: string): Promise<AgentOauthGrant | null> {
      return db.transaction(async (tx) => {
        if (!referenceId.startsWith(GRANT_PREFIX)) return null;
        const bindingId = referenceId.slice(GRANT_PREFIX.length);
        if (!UUID.test(bindingId)) return null;
        const [row] = await tx.select({ binding: schema.agentOauthBindings }).from(schema.agentOauthBindings)
          .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.agentOauthBindings.clientId))
          .where(and(eq(schema.agentOauthBindings.id, bindingId), eq(schema.agentOauthBindings.ownerUserId, ownerUserId),
            or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled)))).for('share');
        return row ? grantOfBinding(tx, ownerUserId, row.binding) : null;
      });
    },

    /** The grant of a server-owned run token (F-027 A2): no client signs in for it, so the connection itself is the reference. */
    async grantForRun(ownerUserId: string, connectionId: string): Promise<AgentOauthGrant | null> {
      return db.transaction(async (tx) => {
        if (!UUID.test(connectionId)) return null;
        const connection = await resolveCurrent(tx, ownerUserId, connectionId);
        return connection ? { referenceId: connectionId, clientId: null, connection } : null;
      });
    },
  };
}
