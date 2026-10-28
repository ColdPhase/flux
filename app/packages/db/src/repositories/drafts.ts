import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import { visibleDraftsSql, type AccessActor } from './access.js';
import type { DbExecutor } from './push.js';

/**
 * Draft rows for `packages/core/src/access/drafts.ts` (issues #46, #91). It satisfies core's `DraftRepository` port
 * structurally and makes no access decision: core evaluates the policy first, with the draft row locked `FOR UPDATE`
 * by the access reader, and checks the expected version before any of these writes.
 */

type DraftRow = typeof schema.drafts.$inferSelect;

export function draftRepository(db: DbExecutor) {
  const bump = sql`${schema.drafts.version} + 1`;
  return {
    async insert(row: { id: string; workspaceId: string; projectId: string | null; title: string; body: string; createdBy: string;
      ownerUserId: string | null; ownerAgentId: string | null }) {
      const [created] = await db.insert(schema.drafts).values({ ...row, visibility: 'private' }).returning();
      return created!;
    },

    /** One page of the drafts the actor can read (optionally in one project); the filter applies before count and page. */
    async listVisible(actor: AccessActor, projectId: string | undefined, page: { limit: number; offset: number }) {
      const conditions: SQL[] = [visibleDraftsSql(actor)];
      if (projectId !== undefined) conditions.push(eq(schema.drafts.projectId, projectId));
      const filter = and(...conditions);
      const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.drafts).where(filter);
      const rows = await db.select().from(schema.drafts).where(filter)
        .orderBy(desc(schema.drafts.createdAt), desc(schema.drafts.id))
        .limit(page.limit).offset(page.offset);
      return { total: counted?.count ?? 0, rows };
    },

    async updateText(draftId: string, changes: { title?: string; body?: string }) {
      const [row] = await db.update(schema.drafts).set({ ...changes, version: bump, updatedAt: new Date() })
        .where(eq(schema.drafts.id, draftId)).returning();
      return row!;
    },

    /** Share and move: a new project and audience, one version on. */
    async setAudience(draftId: string, audience: { projectId: string | null; visibility: DraftRow['visibility'] }) {
      const [row] = await db.update(schema.drafts).set({ projectId: audience.projectId, visibility: audience.visibility, version: bump, updatedAt: new Date() })
        .where(eq(schema.drafts.id, draftId)).returning();
      return row!;
    },
  };
}
