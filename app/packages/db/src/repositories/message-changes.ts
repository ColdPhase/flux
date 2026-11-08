import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { openRows, sealFor } from '../sealing.js';

/**
 * What a person's Edit and Delete of their own message do to the rows (#1006). Persistence only: the use cases decide who may, with the
 * space or the direct message locked first, and call these inside that transaction.
 *
 * An edit overwrites the words and stamps `edited_at`; the earlier words are not kept. A delete replaces the words with a fixed marker and
 * stamps `removed_at`; the row keeps its id, place and sequence so replies, threads and links still make sense, and everything that carried
 * the words leaves with them: the message's own citations, its files, the notices that quoted it and (the migration's trigger) its search
 * row. Both seal what they write, so an encrypted workspace's rows stay envelopes (the marker too) and a locked one refuses (423).
 */
export const REMOVED_BY_AUTHOR_BODY = 'Message removed';

const m = schema.projectMessages;
const f = schema.projectFiles;
const r = schema.messageReferences;
const dm = schema.dmMessages;

/** A project message, opened, and the conversation it sits in. */
export type LockedProjectMessage = Omit<typeof m.$inferSelect, 'requestFingerprint'> & { space: string };

/**
 * The notices that carried a message's words to people go with it. A reply notice also quotes the opening message of its
 * conversation in its title, so deleting a root takes that conversation's reply notices too.
 */
async function forgetNotices(db: DbExecutor, source: { type: 'project' | 'dm'; id: string }, url: string, alsoRepliesTo?: string) {
  await db.execute(sql`DELETE FROM notifications WHERE source_type = ${source.type} AND source_id = ${source.id} AND url = ${url}`);
  if (alsoRepliesTo)
    await db.execute(sql`DELETE FROM notifications WHERE source_type = ${source.type} AND source_id = ${source.id} AND reason = 'reply' AND url LIKE ${`${alsoRepliesTo}#%`}`);
}

export function messageChangeRows(db: DbExecutor) {
  return {
    /**
     * The message, `FOR UPDATE`, only when it is in this conversation: an id from another conversation is not found, so the access
     * check the caller made for this conversation can never be borrowed for another one.
     */
    async lockProject(conversationId: string, messageId: string): Promise<LockedProjectMessage | null> {
      const [row] = await db.select().from(m).where(and(eq(m.id, messageId), eq(m.conversationId, conversationId))).for('update');
      if (!row) return null;
      const [conversation] = await db.select({ space: schema.projectConversations.space }).from(schema.projectConversations).where(eq(schema.projectConversations.id, conversationId));
      const [opened] = await openRows(db, 'project_messages', [row]);
      return { ...opened!, space: conversation?.space ?? 'people' };
    },

    /** Overwrites the words. Returns the new `edited_at`. */
    async editProject(message: Pick<LockedProjectMessage, 'id' | 'workspaceId'>, body: string): Promise<Date> {
      const sealed = await sealFor(db, 'project_messages', message.workspaceId, { body }, { id: message.id });
      const [updated] = await db.update(m).set({ body: sealed.body, editedAt: sql`now()` }).where(eq(m.id, message.id)).returning({ editedAt: m.editedAt });
      return updated!.editedAt!;
    },

    /** Takes the message back to its marker and everything that carried its words with it. Returns the new `removed_at`. */
    async removeProject(message: Pick<LockedProjectMessage, 'id' | 'workspaceId' | 'projectId' | 'conversationId' | 'sequence'>): Promise<Date> {
      await db.delete(r).where(eq(r.projectMessageId, message.id));
      const files = await db.delete(f).where(eq(f.messageId, message.id)).returning({ id: f.id });
      if (files.length) await db.insert(schema.fileGarbage).values(files.map(({ id }) => ({ id }))).onConflictDoNothing();
      const sealed = await sealFor(db, 'project_messages', message.workspaceId, { body: REMOVED_BY_AUTHOR_BODY }, { id: message.id });
      const [updated] = await db.update(m).set({ body: sealed.body, removedAt: sql`now()`, attachmentCount: 0, sourceMaterialId: null, sourceMaterialVersion: null })
        .where(eq(m.id, message.id)).returning({ removedAt: m.removedAt });
      const place = `/projects/${message.projectId}/conversations/${message.conversationId}`;
      await forgetNotices(db, { type: 'project', id: message.projectId }, `${place}#message-${message.id}`, message.sequence === 1 ? place : undefined);
      return updated!.removedAt!;
    },

    /** The message of this direct message, `FOR UPDATE`; an id of another direct message is not found. */
    async lockDm(dmId: string, messageId: string) {
      const [row] = await db.select().from(dm).where(and(eq(dm.id, messageId), eq(dm.dmId, dmId))).for('update');
      if (!row) return null;
      const [opened] = await openRows(db, 'dm_messages', [row]);
      return opened!;
    },

    async editDm(message: { id: string; workspaceId: string }, body: string): Promise<Date> {
      const sealed = await sealFor(db, 'dm_messages', message.workspaceId, { body }, { id: message.id });
      const [updated] = await db.update(dm).set({ body: sealed.body, editedAt: sql`now()` }).where(eq(dm.id, message.id)).returning({ editedAt: dm.editedAt });
      return updated!.editedAt!;
    },

    async removeDm(message: { id: string; workspaceId: string; dmId: string; authorId: string }): Promise<Date> {
      await db.delete(r).where(eq(r.dmMessageId, message.id));
      // A send retried under an Idempotency-Key stored the message in its answer for replay; the message id is the retry identity too,
      // so dropping the author's stored answers for sends only costs a repeat of the same send (which finds the marker).
      await db.execute(sql`DELETE FROM idempotency_keys WHERE workspace_id = ${message.workspaceId} AND principal = ${`human:${message.authorId}`}
        AND operation IN ('POST /api/v1/dms/:dmId/messages', 'POST /api/v1/dms/:dmId/threads/:rootId/replies')`);
      const sealed = await sealFor(db, 'dm_messages', message.workspaceId, { body: REMOVED_BY_AUTHOR_BODY }, { id: message.id });
      const [updated] = await db.update(dm).set({ body: sealed.body, removedAt: sql`now()` }).where(eq(dm.id, message.id)).returning({ removedAt: dm.removedAt });
      await forgetNotices(db, { type: 'dm', id: message.dmId }, `/dm/${message.dmId}#message-${message.id}`);
      return updated!.removedAt!;
    },
  };
}
