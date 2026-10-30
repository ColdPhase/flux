import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { openRow, sealOf } from '../sealing.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for draft.summarize.v1 results (issues #46, #87). It satisfies core's
 * `DraftResultRepository` port structurally; core owns authorization, the transactions and the
 * word count. Bind it to the transaction a step runs in.
 */
const r = schema.draftResults;

export type DraftResultRow = typeof r.$inferSelect;

export function draftResultRepository(db: DbExecutor) {
  return {
    async insert(result: { id: string; workspaceId: string; draftId: string; principalKind: 'human' | 'agent'; principalId: string }): Promise<void> {
      await db.insert(r).values(result);
    },
    async setJobId(id: string, jobId: string): Promise<DraftResultRow> {
      const [row] = await db.update(r).set({ jobId }).where(eq(r.id, id)).returning();
      return row!;
    },
    /** The draft's newest results first. */
    async list(draftId: string, limit: number): Promise<DraftResultRow[]> {
      return db.select().from(r).where(eq(r.draftId, draftId)).orderBy(desc(r.createdAt), desc(r.id)).limit(limit);
    },
    async get(draftId: string, resultId: string): Promise<DraftResultRow | null> {
      const [row] = await db.select().from(r).where(and(eq(r.id, resultId), eq(r.draftId, draftId)));
      return row ?? null;
    },
    /** Marks a queued or running result running; null when it is missing or already finished. */
    async claim(resultId: string): Promise<DraftResultRow | null> {
      const [row] = await db.update(r).set({ status: 'running', updatedAt: new Date() })
        .where(and(eq(r.id, resultId), inArray(r.status, ['queued', 'running']))).returning();
      return row ?? null;
    },
    async markDenied(resultId: string, stage: 'before_read' | 'before_commit'): Promise<void> {
      await db.update(r).set({ status: 'denied', deniedAtStage: stage, updatedAt: new Date(), completedAt: new Date() }).where(eq(r.id, resultId));
    },
    /** Completes a running result; false when it is no longer running. */
    async complete(resultId: string, wordCount: number, draftVersion: number): Promise<boolean> {
      const updated = await db.update(r)
        .set({ status: 'completed', wordCount, draftVersion, updatedAt: new Date(), completedAt: new Date() })
        .where(and(eq(r.id, resultId), eq(r.status, 'running'))).returning({ id: r.id });
      return updated.length > 0;
    },
    /** F-030 (#655 integrated review P2-2): an encrypted workspace's body is opened through its seal (423 while locked). */
    async readDraftBody(draftId: string): Promise<{ body: string; version: number } | null> {
      const [draft] = await db.select({ id: schema.drafts.id, workspaceId: schema.drafts.workspaceId, body: schema.drafts.body, version: schema.drafts.version })
        .from(schema.drafts).where(eq(schema.drafts.id, draftId));
      if (!draft) return null;
      const opened = openRow('drafts', draft, await sealOf(db, draft.workspaceId, { write: false }));
      return { body: opened.body, version: opened.version };
    },
    /** A summary of a locked encrypted workspace's draft waits (ids only) for `workspace-encryption.resume.v1`. */
    async recordWait(resultId: string, workspaceId: string) {
      await db.execute(sql`INSERT INTO sealed_job_waits (id, workspace_id, queue, payload)
        VALUES (gen_random_uuid(), ${workspaceId}::uuid, 'draft.summarize.v1', ${JSON.stringify({ resultId })}::jsonb)`);
    },
  };
}
