import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
type ActorRef = { kind: 'human' | 'agent'; id: string };
import type { MessageFile } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

const f = schema.projectFiles;
function wire(row: typeof f.$inferSelect) {
  return { ...row, uploader: row.uploaderId !== null ? { kind: 'human' as const, id: row.uploaderId }
    : { kind: 'agent' as const, id: row.uploaderAgentId! } };
}
const uploaderFilter = (actor: ActorRef) => actor.kind === 'human' ? eq(f.uploaderId, actor.id) : eq(f.uploaderAgentId, actor.id);

/** Persistence only. Admission, publication and cleanup use the same caller-owned transaction. */
export function fileRows(db: DbExecutor) {
  return {
    async lockUploader(projectId: string, uploader: ActorRef) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`files:${projectId.toLowerCase()}:${uploader.kind}:${uploader.kind === 'agent' ? uploader.id.toLowerCase() : uploader.id}`}))`);
    },
    async activeReplay(fileId: string, now: Date) {
      const [row] = await db.select({ id: f.id }).from(f).where(and(eq(f.replayOf, fileId), sql`${f.expiresAt} > ${now}`));
      return !!row;
    },
    async findUpload(projectId: string, uploader: ActorRef, uploadId: string) {
      const [row] = await db.select().from(f).where(and(eq(f.projectId, projectId), uploaderFilter(uploader), eq(f.uploadId, uploadId)));
      return row ? wire(row) : null;
    },
    async stagedBytes(projectId: string, uploader: ActorRef, now: Date) {
      const [row] = await db.select({ bytes: sql<number>`COALESCE(SUM(CASE WHEN ${f.state} = 'receiving' THEN ${f.reservedBytes} ELSE ${f.size} END), 0)::int` })
        .from(f).where(and(eq(f.projectId, projectId), uploaderFilter(uploader), isNull(f.publishedAt), sql`${f.expiresAt} > ${now}`));
      return row?.bytes ?? 0;
    },
    async reserve(input: { id: string; workspaceId: string; projectId: string; uploader: ActorRef; uploadId: string; name: string; reservedBytes: number; expiresAt: Date; replayOf?: string }) {
      const { uploader, ...fields } = input;
      const [row] = await db.insert(f).values({ ...fields, state: 'receiving',
        uploaderId: uploader.kind === 'human' ? uploader.id : null, uploaderAgentId: uploader.kind === 'agent' ? uploader.id : null }).returning();
      return wire(row!);
    },
    async findFile(id: string) {
      const [row] = await db.select().from(f).where(eq(f.id, id));
      return row ? wire(row) : null;
    },
    async markReady(id: string, input: { size: number; sha256: string; readyAt: Date; expiresAt: Date }) {
      const rows = await db.update(f).set({ ...input, state: 'ready' }).where(and(eq(f.id, id), eq(f.state, 'receiving'),
        isNull(f.publishedAt), sql`${f.expiresAt} > ${input.readyAt}`)).returning({ id: f.id });
      return rows.length === 1;
    },
    async removeUnpublished(id: string) {
      const removed = await db.delete(f).where(and(eq(f.id, id), isNull(f.publishedAt))).returning({ id: f.id });
      if (removed.length) await db.insert(schema.fileGarbage).values({ id }).onConflictDoNothing();
      return removed.length === 1;
    },
    async pendingGarbage(limit: number) {
      return (await db.select({ id: schema.fileGarbage.id }).from(schema.fileGarbage)
        .orderBy(asc(schema.fileGarbage.createdAt), asc(schema.fileGarbage.id)).limit(limit)).map((row) => row.id);
    },
    async forgetGarbage(ids: readonly string[]) {
      if (ids.length) await db.delete(schema.fileGarbage).where(inArray(schema.fileGarbage.id, [...ids]));
    },
    async lockFiles(ids: readonly string[]) {
      if (!ids.length) return [];
      return (await db.select().from(f).where(inArray(f.id, [...ids])).orderBy(asc(f.id)).for('update')).map(wire);
    },
    async expired(now: Date, limit: number) {
      return (await db.select().from(f).where(and(isNull(f.publishedAt), lte(f.expiresAt, now)))
        .orderBy(asc(f.expiresAt), asc(f.id)).limit(limit)).map(wire);
    },
    /** #252: publishes a ready, unpublished file as the image of one map thought; false when it is not both. */
    async publishToThought(id: string, thoughtId: string, publishedAt: Date) {
      const rows = await db.update(f).set({ thoughtId, publishedAt, expiresAt: null })
        .where(and(eq(f.id, id), eq(f.state, 'ready'), isNull(f.publishedAt))).returning({ id: f.id });
      return rows.length === 1;
    },
    /** The images of these thoughts in one project, by thought id. */
    async thoughtFiles(projectId: string, thoughtIds: readonly string[]) {
      const files = new Map<string, MessageFile>();
      for (let start = 0; start < thoughtIds.length; start += MESSAGE_ID_BATCH) {
        for (const row of await db.select({ id: f.id, name: f.name, size: f.size, thoughtId: f.thoughtId }).from(f)
          .where(and(eq(f.projectId, projectId), inArray(f.thoughtId, thoughtIds.slice(start, start + MESSAGE_ID_BATCH)))))
          files.set(row.thoughtId!, { id: row.id, name: row.name, size: row.size! });
      }
      return files;
    },
    async messageFiles(ids: readonly string[]) {
      const grouped = new Map<string, MessageFile[]>();
      // Bounded batches: PostgreSQL accepts at most 65,535 bind parameters in one statement.
      for (let start = 0; start < ids.length; start += MESSAGE_ID_BATCH) {
        groupMessageFiles(grouped, await db.select().from(f).where(inArray(f.messageId, ids.slice(start, start + MESSAGE_ID_BATCH)))
          .orderBy(asc(f.messageId), asc(f.position)));
      }
      return grouped;
    },
    /** Every published file of a project's messages, for export: one query whatever the message count. */
    async projectMessageFiles(projectId: string) {
      return groupMessageFiles(new Map(), await db.select().from(f).where(and(eq(f.projectId, projectId), isNotNull(f.messageId)))
        .orderBy(asc(f.messageId), asc(f.position)));
    },
  };
}

const MESSAGE_ID_BATCH = 10_000;

function groupMessageFiles(grouped: Map<string, MessageFile[]>, rows: readonly (typeof f.$inferSelect)[]) {
  for (const row of rows) {
    const list = grouped.get(row.messageId!) ?? [];
    list.push({ id: row.id, name: row.name, size: row.size! });
    grouped.set(row.messageId!, list);
  }
  return grouped;
}
