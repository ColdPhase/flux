import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import { visibleDraftsSql, type AccessActor } from './access.js';
import type { DbExecutor } from './push.js';
import { openRow, openRows, sealOf, sealRow, type FieldSeal } from '../sealing.js';

/**
 * Draft rows for `packages/core/src/access/drafts.ts` (issues #46, #91). It satisfies core's `DraftRepository` port
 * structurally and makes no access decision: core evaluates the policy first, with the draft row locked `FOR UPDATE`
 * by the access reader, and checks the expected version before any of these writes.
 */

type DraftRow = typeof schema.drafts.$inferSelect;

export function draftRepository(db: DbExecutor) {
  const bump = sql`${schema.drafts.version} + 1`;
  const writeSeal = (workspaceId: string) => sealOf(db, workspaceId, { write: true });
  /**
   * F-030: in a sealed workspace `preserve_draft_version` writes nothing (0120), so each version is inserted here,
   * sealed with the version row's own identity `[draft id, version]`: no SQL copies a sealed value between tables.
   */
  async function keepVersion(seal: FieldSeal, row: DraftRow) {
    if (!seal.sealed) return;
    const v = sealRow('draft_versions', { draftId: row.id, version: row.version, title: row.title, body: row.body }, seal);
    await db.execute(sql`INSERT INTO draft_versions (draft_id, version, title, body, visibility, project_id)
      VALUES (${v.draftId}, ${v.version}, ${v.title}, ${v.body}, ${row.visibility}, ${row.projectId})`);
  }
  /** A written row as the caller knows it: opened, and its version kept for a sealed workspace. */
  async function written(seal: FieldSeal, stored: DraftRow) {
    const row = openRow('drafts', stored, seal);
    await keepVersion(seal, row);
    return row;
  }
  return {
    async insert(row: { id: string; workspaceId: string; projectId: string | null; title: string; body: string; createdBy: string;
      ownerUserId: string | null; ownerAgentId: string | null }) {
      const seal = await writeSeal(row.workspaceId);
      const [created] = await db.insert(schema.drafts).values(sealRow('drafts', { ...row, visibility: 'private' as const }, seal)).returning();
      return written(seal, created!);
    },

    /** One page of the drafts the actor can read (optionally in one project); the filter applies before count and page. */
    async listVisible(actor: AccessActor, projectId: string | undefined, page: { limit: number; offset: number }) {
      // F-030 (AC-6): a locked encrypted workspace answers 423 even when the page would be empty.
      await sealOf(db, actor.workspaceId, { write: false });
      const conditions: SQL[] = [visibleDraftsSql(actor)];
      if (projectId !== undefined) conditions.push(eq(schema.drafts.projectId, projectId));
      const filter = and(...conditions);
      const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.drafts).where(filter);
      const rows = await openRows(db, 'drafts', await db.select().from(schema.drafts).where(filter)
        .orderBy(desc(schema.drafts.createdAt), desc(schema.drafts.id))
        .limit(page.limit).offset(page.offset));
      return { total: counted?.count ?? 0, rows };
    },

    async updateText(draftId: string, changes: { title?: string; body?: string }) {
      const [located] = await db.select({ workspaceId: schema.drafts.workspaceId }).from(schema.drafts).where(eq(schema.drafts.id, draftId));
      const seal = await writeSeal(located!.workspaceId);
      const [row] = await db.update(schema.drafts).set({ ...sealRow('drafts', changes, seal, { id: draftId }), version: bump, updatedAt: new Date() })
        .where(eq(schema.drafts.id, draftId)).returning();
      return written(seal, row!);
    },

    /** Share and move: a new project and audience, one version on. */
    async setAudience(draftId: string, audience: { projectId: string | null; visibility: DraftRow['visibility'] }) {
      const [row] = await db.update(schema.drafts).set({ projectId: audience.projectId, visibility: audience.visibility, version: bump, updatedAt: new Date() })
        .where(eq(schema.drafts.id, draftId)).returning();
      return written(await writeSeal(row!.workspaceId), row!);
    },
  };
}
