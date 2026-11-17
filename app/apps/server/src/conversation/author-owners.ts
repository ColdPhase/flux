import { removedName, withoutInvisibleFormat, type AgentProjectOwner } from '@flux/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, accessReader, type Executor } from '@flux/db';
import { evaluateProject } from '@flux/core';

/** The principal with its current scoped owner; humans and agents without a visible owner are returned unchanged. */
export function scopedPrincipal<P extends { kind: 'human' | 'agent'; id: string }>(who: P, owners: ReadonlyMap<string, AgentProjectOwner>): P {
  const projectOwner = who.kind === 'agent' ? owners.get(who.id) : undefined;
  return projectOwner ? { ...who, projectOwner } : who;
}

/**
 * Only the actual bounded history's authors, without treating a past author as a current reader. An agent whose owner left the space's
 * company or was removed from it, and has not come back, carries that owner with `removedName` (founder decision, Hubert, 2026-11-17, #1424):
 * "Planner · Stefan Kowal (removed)'s agent", as the owner's own messages in the space name them. An owner still in the company who cannot
 * read the space is not given.
 */
export async function projectAuthorOwners(db: Executor, projectId: string, workspaceId: string, authorIds: readonly string[]): Promise<ReadonlyMap<string, AgentProjectOwner>> {
  const ids = [...new Set(authorIds)];
  if (ids.length > 101) throw new Error('Agent author projection exceeds the bounded message window');
  const owners = new Map<string, AgentProjectOwner>();
  if (!ids.length) return owners;
  // The same removal rule as `namesIn` and `formerMembers`: removed from this workspace or from the company an encrypted space belongs to.
  const removed = sql<boolean>`EXISTS (SELECT 1 FROM workspaces w JOIN workspace_removed_people r ON r.workspace_id = w.id OR r.workspace_id = w.company_workspace_id
    WHERE w.id = ${workspaceId}::uuid AND r.user_id = "agents"."owner_user_id")`;
  const agents = await db.select({ id: schema.agents.id, ownerUserId: schema.agents.ownerUserId, memberId: schema.workspaceMembers.userId,
    ownerName: schema.authUsers.name, removed })
    .from(schema.agents)
    .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.agents.ownerUserId))
    .leftJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, workspaceId),
      eq(schema.workspaceMembers.userId, schema.agents.ownerUserId)))
    .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, ids)));
  const visible = new Map<string, boolean>();
  for (const agent of agents) {
    if (agent.memberId === null) {
      if (agent.removed) owners.set(agent.id, { kind: 'human', id: agent.ownerUserId, removedName: withoutInvisibleFormat(agent.ownerName) });
      continue;
    }
    // Exactly the human candidate boundary of listProjectPeople, followed by the same policy.
    if (!visible.has(agent.ownerUserId)) visible.set(agent.ownerUserId,
      (await evaluateProject({ kind: 'human', id: agent.ownerUserId }, 'project.read', projectId, accessReader(db))).allowed);
    if (visible.get(agent.ownerUserId)) owners.set(agent.id, { kind: 'human', id: agent.ownerUserId });
  }
  return owners;
}

/**
 * The owner's name each agent of `agentIds` is labelled with in this space, by the rule of `projectAuthorOwners`: the owner by name while
 * they can read the space, "Stefan Kowal (removed)" once they left the company or were removed (founder decision, Hubert, 2026-11-17, #1424),
 * and no entry for an owner the space's readers cannot be told ("Planner · a former member's agent"). For the labels that are text: Search,
 * notices and Home's lines (`agentWords`).
 */
export async function agentOwnerNamesIn(db: Executor, projectId: string, workspaceId: string, agentIds: readonly string[]): Promise<Map<string, string>> {
  const owners = await projectAuthorOwners(db, projectId, workspaceId, agentIds);
  const told = [...new Set([...owners.values()].filter((owner) => owner.removedName === undefined).map((owner) => owner.id))];
  const plain = new Map(told.length ? (await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers)
    .where(inArray(schema.authUsers.id, told))).map((row) => [row.id, withoutInvisibleFormat(row.name)]) : []);
  const names = new Map<string, string>();
  for (const [agentId, owner] of owners) {
    const name = owner.removedName !== undefined ? removedName(owner.removedName) : plain.get(owner.id);
    if (name) names.set(agentId, name);
  }
  return names;
}
