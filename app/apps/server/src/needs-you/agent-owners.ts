import { inArray } from 'drizzle-orm';
import type { NeedsYouItem } from '@flux/contracts';
import { schema, workRows, type Database } from '@flux/db';
import { projectAuthorOwners } from '../conversation/author-owners.js';

/**
 * An agent an item comes from carries its owner by name (v0.2.1 release gate: one label everywhere, "Assistant · Ola's agent", for every
 * reader). The owner is named on the boundary of a task row and a message's author (#339 AC-2): only while that person is a member of the
 * company and can read the item's space. An item without a space names no owner.
 */
export async function withAgentOwners(db: Database, items: NeedsYouItem[]): Promise<void> {
  const byProject = new Map<string, Set<string>>();
  for (const item of items) if (item.from?.kind === 'agent' && item.project)
    byProject.set(item.project.id, (byProject.get(item.project.id) ?? new Set()).add(item.from.id));
  if (!byProject.size) return;
  const spaces = await db.select({ id: schema.projects.id, workspaceId: schema.projects.workspaceId }).from(schema.projects)
    .where(inArray(schema.projects.id, [...byProject.keys()]));
  const owners = new Map<string, string>();
  for (const space of spaces) {
    for (const [agentId, owner] of await projectAuthorOwners(db, space.id, space.workspaceId, [...byProject.get(space.id)!].slice(0, 100)))
      owners.set(`${space.id}:${agentId}`, owner.id);
  }
  if (!owners.size) return;
  const names = await workRows(db).names([...new Set(owners.values())].map((id) => ({ kind: 'human' as const, id })));
  for (const item of items) {
    if (item.from?.kind !== 'agent' || !item.project) continue;
    const ownerId = owners.get(`${item.project.id}:${item.from.id}`);
    const name = ownerId ? names.get(`human:${ownerId}`) : undefined;
    if (ownerId && name) item.from.owner = { id: ownerId, name };
  }
}
