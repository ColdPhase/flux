import type { AgentProjectOwner } from '@flux/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@flux/db';
import { evaluateProject, type Executor } from '@flux/core';

/** Only the actual bounded history's authors, without treating a past author as a current reader. */
export async function projectAuthorOwners(db: Executor, projectId: string, workspaceId: string, authorIds: readonly string[]): Promise<ReadonlyMap<string, AgentProjectOwner>> {
  const ids = [...new Set(authorIds)];
  if (ids.length > 101) throw new Error('Agent author projection exceeds the bounded message window');
  const owners = new Map<string, AgentProjectOwner>();
  if (!ids.length) return owners;
  const agents = await db.select({ id: schema.agents.id, ownerUserId: schema.agents.ownerUserId, memberId: schema.workspaceMembers.userId })
    .from(schema.agents)
    .leftJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, workspaceId),
      eq(schema.workspaceMembers.userId, schema.agents.ownerUserId)))
    .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, ids)));
  const visible = new Map<string, boolean>();
  for (const agent of agents) {
    if (agent.ownerUserId === null) owners.set(agent.id, { kind: 'workspace' });
    else {
      // Exactly the human candidate boundary of listProjectPeople, followed by the same policy.
      if (agent.memberId === null) continue;
      if (!visible.has(agent.ownerUserId)) visible.set(agent.ownerUserId,
        (await evaluateProject({ kind: 'human', id: agent.ownerUserId }, 'project.read', projectId, db)).allowed);
      if (visible.get(agent.ownerUserId)) owners.set(agent.id, { kind: 'human', id: agent.ownerUserId });
    }
  }
  return owners;
}
