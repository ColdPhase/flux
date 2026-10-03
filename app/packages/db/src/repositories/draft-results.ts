import { and, desc, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema.js';
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
    async readDraftBody(draftId: string): Promise<{ body: string; version: number } | null> {
      const [draft] = await db.select({ body: schema.drafts.body, version: schema.drafts.version }).from(schema.drafts).where(eq(schema.drafts.id, draftId));
      return draft ?? null;
    },
  };
}
