import { inArray } from 'drizzle-orm';
import { removedName, type AgentProjectOwner, type NeedsYouItem } from '@flux/contracts';
import { schema, workRows, type Database } from '@flux/db';
import { projectAuthorOwners } from '../conversation/author-owners.js';

/**
 * An agent an item comes from carries its owner by name (v0.2.1 release gate: one label everywhere, "Assistant · Ola's agent", for every
 * reader). The owner is named on the boundary of a task row and a message's author (#339 AC-2): only while that person is a member of the
 * company and can read the item's space, or by "Stefan Kowal (removed)" once they left the company or were removed (#1424). An item without a
 * space names no owner.
 */
export async function withAgentOwners(db: Database, items: NeedsYouItem[]): Promise<void> {
  const byProject = new Map<string, Set<string>>();
  for (const item of items) if (item.from?.kind === 'agent' && item.project)
    byProject.set(item.project.id, (byProject.get(item.project.id) ?? new Set()).add(item.from.id));
  if (!byProject.size) return;
  const spaces = await db.select({ id: schema.projects.id, workspaceId: schema.projects.workspaceId }).from(schema.projects)
    .where(inArray(schema.projects.id, [...byProject.keys()]));
  const owners = new Map<string, AgentProjectOwner>();
  for (const space of spaces) {
    for (const [agentId, owner] of await projectAuthorOwners(db, space.id, space.workspaceId, [...byProject.get(space.id)!].slice(0, 100)))
      owners.set(`${space.id}:${agentId}`, owner);
  }
  if (!owners.size) return;
  const names = await workRows(db).names([...new Set([...owners.values()].map((owner) => owner.id))].map((id) => ({ kind: 'human' as const, id })));
  for (const item of items) {
    if (item.from?.kind !== 'agent' || !item.project) continue;
    const owner = owners.get(`${item.project.id}:${item.from.id}`);
    // An owner who left the company or was removed: "Assistant · Stefan Kowal (removed)'s agent" (#1424, 2026-11-17).
    const name = owner?.removedName !== undefined ? removedName(owner.removedName) : owner ? names.get(`human:${owner.id}`) : undefined;
    if (owner && name) item.from.owner = { id: owner.id, name };
  }
}
