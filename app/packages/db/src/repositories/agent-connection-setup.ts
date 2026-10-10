import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AgentConnection, AgentConnectionSetupFacts } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;

/** Display facts for a connection already validated by the owner-management use case. Never reads token values. */
export function agentConnectionSetupRepository(db: Database) {
  return {
    get(connection: AgentConnection): Promise<AgentConnectionSetupFacts> {
      return db.transaction(async (tx) => {
        const bindings = await tx.select({ id: schema.agentOauthBindings.id, clientId: schema.agentOauthBindings.clientId })
          .from(schema.agentOauthBindings)
          .innerJoin(schema.oauthClient, and(eq(schema.oauthClient.clientId, schema.agentOauthBindings.clientId),
            or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled))))
          .where(and(eq(schema.agentOauthBindings.connectionId, connection.id),
            eq(schema.agentOauthBindings.ownerUserId, connection.ownerUserId)));
        const references = new Map(bindings.map((binding) => [`flux-grant:${binding.id}`, binding.clientId]));
        // Historic tokens used the connection itself as reference. Their client must also be enabled.
        let authorizationRecorded = false;
        for (const table of [schema.oauthAccessToken, schema.oauthRefreshToken]) {
          const rows = await tx.select({ referenceId: table.referenceId, clientId: table.clientId, scopes: table.scopes })
            .from(table).innerJoin(schema.oauthClient, and(eq(schema.oauthClient.clientId, table.clientId),
              or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled))))
            .where(and(eq(table.userId, connection.ownerUserId), inArray(table.referenceId, [connection.id, ...references.keys()]),
              isNull(table.revoked), gt(table.expiresAt, sql`now()`)));
          authorizationRecorded ||= rows.some((row) => row.referenceId
            && (row.referenceId === connection.id || references.get(row.referenceId) === row.clientId)
            && row.scopes.some((scope) => connection.scopes.includes(scope as typeof connection.scopes[number])));
        }
        const [session] = await tx.select({ startedAt: schema.agentRuntimeSessions.createdAt, expiresAt: schema.agentRuntimeSessions.expiresAt })
          .from(schema.agentRuntimeSessions)
          .innerJoin(schema.agentOauthBindings, and(eq(schema.agentOauthBindings.id, schema.agentRuntimeSessions.bindingId),
            eq(schema.agentOauthBindings.connectionId, connection.id), eq(schema.agentOauthBindings.ownerUserId, connection.ownerUserId),
            eq(schema.agentOauthBindings.generation, schema.agentRuntimeSessions.bindingGeneration)))
          .innerJoin(schema.oauthClient, and(eq(schema.oauthClient.clientId, schema.agentOauthBindings.clientId),
            or(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.disabled))))
          .where(and(eq(schema.agentRuntimeSessions.connectionId, connection.id),
            eq(schema.agentRuntimeSessions.ownerUserId, connection.ownerUserId), eq(schema.agentRuntimeSessions.agentId, connection.agentId),
            isNull(schema.agentRuntimeSessions.revokedAt), gt(schema.agentRuntimeSessions.expiresAt, sql`now()`)))
          .orderBy(desc(schema.agentRuntimeSessions.createdAt)).limit(1);
        return { authorizationRecorded, session: authorizationRecorded && session
          ? { startedAt: session.startedAt.toISOString(), expiresAt: session.expiresAt.toISOString() } : null, activation: 'pending' };
      });
    },
  };
}
