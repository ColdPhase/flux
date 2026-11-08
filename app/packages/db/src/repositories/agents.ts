import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import { isCompanyGuest, type AccessPrincipal } from './access.js';
import type { DbExecutor } from './push.js';

/**
 * Agent identity rows for `packages/core/src/access/agents.ts` (issues #46, #91). It satisfies core's
 * `AgentRepository` port structurally and makes no access decision; each method is the statement the use
 * case ran before.
 */

/**
 * Personal assistant identities are private discovery state; shared message attribution is separate (#522).
 * The condition over an agent id: the agent is not a person's assistant, or it is one that person's
 * connection is connected (a client's agent reaches what its owner reaches).
 */
export function visibleAgentIdentity(principal: AccessPrincipal, agentId: SQL = sql`${schema.agents.id}`): SQL {
  const assistant = schema.assistantSettings, connection = schema.agentConnections;
  return sql`(not exists (select 1 from ${assistant} where ${assistant.agentId} = ${agentId}
    and ${principal.kind === 'human' ? sql`${assistant.ownerUserId} <> ${principal.id}` : sql`true`})
    or exists (select 1 from ${connection}
      where ${connection.agentId} = ${agentId} and ${connection.computeSource} <> 'owner_assistant'
      and ${connection.revokedAt} is null))`;
}

export function agentRepository(db: DbExecutor) {
  return {
    async insert(row: { id: string; workspaceId: string; name: string; ownerUserId: string; createdBy: string }) {
      const [created] = await db.insert(schema.agents).values(row).returning();
      return created!;
    },

    /** Whether the person is a guest of the company, read `FOR SHARE` (AG-2): a guest makes no agent in any workspace. */
    isCompanyGuest(userId: string) {
      return isCompanyGuest(db, userId, { lock: true });
    },

    /** The workspace's agents this principal may see, oldest first. */
    listVisible(principal: AccessPrincipal, workspaceId: string) {
      return db.select().from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), visibleAgentIdentity(principal)))
        .orderBy(asc(schema.agents.createdAt), asc(schema.agents.id));
    },

    async revoke(agentId: string, revokedAt: Date) {
      const [row] = await db.update(schema.agents).set({ revokedAt, updatedAt: new Date() })
        .where(eq(schema.agents.id, agentId)).returning();
      return row!;
    },
  };
}
