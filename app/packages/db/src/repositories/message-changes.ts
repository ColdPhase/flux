import { randomBytes } from 'node:crypto';
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
 *
 * "Ada · via Assistant" names the agent that wrote the words, so a message whose words are no longer those ends the mark: an edit and a
 * delete both clear `via`. A delete also replaces the request fingerprint (an unsalted SHA-256 of the sent words) with a random value, and
 * an edit or a delete drops the author's stored `Idempotency-Key` answers for direct-message sends, which hold the sent message.
 */
export const REMOVED_BY_AUTHOR_BODY = 'Message removed';

const m = schema.projectMessages;
const f = schema.projectFiles;
const r = schema.messageReferences;
const dm = schema.dmMessages;

/** A project message, opened. */
export type LockedProjectMessage = Omit<typeof m.$inferSelect, 'requestFingerprint'>;

/**
 * The notices that carried a message's words to people go with it. A reply notice also quotes the opening message of its
 * conversation in its title, so deleting a root takes that conversation's reply notices too.
 */
async function forgetNotices(db: DbExecutor, source: { type: 'project' | 'dm'; id: string }, url: string, alsoRepliesTo?: string) {
  await db.execute(sql`DELETE FROM notifications WHERE source_type = ${source.type} AND source_id = ${source.id} AND url = ${url}`);
  if (alsoRepliesTo)
    await db.execute(sql`DELETE FROM notifications WHERE source_type = ${source.type} AND source_id = ${source.id} AND reason = 'reply' AND url LIKE ${`${alsoRepliesTo}#%`}`);
}

/**
 * The author's stored answers to keyed direct-message sends hold the message as sent. A retry then runs the send again, which finds the
 * stored message: an edited one with its new words, a deleted one as the marker.
 */
async function forgetSendAnswers(db: DbExecutor, message: { workspaceId: string; authorId: string }) {
  await db.execute(sql`DELETE FROM idempotency_keys WHERE workspace_id = ${message.workspaceId} AND principal = ${`human:${message.authorId}`}
    AND operation IN ('POST /api/v1/dms/:dmId/messages', 'POST /api/v1/dms/:dmId/threads/:rootId/replies')`);
}

/**
 * A fingerprint that no words produce: the row keeps the column filled, but no longer a digest of what was written. A retry of the send
 * that stored a deleted message therefore cannot match it by its words; the three send paths find a deleted message by its `clientMessageId`
 * alone and answer the marker (#1052), so the outbox drops the send and the deleted words do not come back to the composer.
 */
const unlinkedFingerprint = () => randomBytes(32).toString('hex');

export function messageChangeRows(db: DbExecutor) {
  return {
    /**
     * The message, `FOR UPDATE`, only when it is in this conversation: an id from another conversation is not found, so the access
     * check the caller made for this conversation can never be borrowed for another one.
     */
    async lockProject(conversationId: string, messageId: string): Promise<LockedProjectMessage | null> {
      const [row] = await db.select().from(m).where(and(eq(m.id, messageId), eq(m.conversationId, conversationId))).for('update');
      if (!row) return null;
      const [opened] = await openRows(db, 'project_messages', [row]);
      return opened!;
    },

    /** Overwrites the words. Returns the new `edited_at`. */
    async editProject(message: Pick<LockedProjectMessage, 'id' | 'workspaceId'>, body: string): Promise<Date> {
      const sealed = await sealFor(db, 'project_messages', message.workspaceId, { body }, { id: message.id });
      const [updated] = await db.update(m).set({ body: sealed.body, editedAt: sql`now()`, via: null, viaColour: null }).where(eq(m.id, message.id)).returning({ editedAt: m.editedAt });
      return updated!.editedAt!;
    },

    /** Takes the message back to its marker and everything that carried its words with it. Returns the new `removed_at`. */
    async removeProject(message: Pick<LockedProjectMessage, 'id' | 'workspaceId' | 'projectId' | 'conversationId' | 'sequence'>): Promise<Date> {
      await db.delete(r).where(eq(r.projectMessageId, message.id));
      const files = await db.delete(f).where(eq(f.messageId, message.id)).returning({ id: f.id });
      if (files.length) await db.insert(schema.fileGarbage).values(files.map(({ id }) => ({ id }))).onConflictDoNothing();
      const sealed = await sealFor(db, 'project_messages', message.workspaceId, { body: REMOVED_BY_AUTHOR_BODY, requestFingerprint: unlinkedFingerprint() }, { id: message.id });
      const [updated] = await db.update(m).set({ body: sealed.body, requestFingerprint: sealed.requestFingerprint, removedAt: sql`now()`, via: null, viaColour: null, attachmentCount: 0, sourceMaterialId: null, sourceMaterialVersion: null })
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

    async editDm(message: { id: string; workspaceId: string; authorId: string }, body: string): Promise<Date> {
      await forgetSendAnswers(db, message);
      const sealed = await sealFor(db, 'dm_messages', message.workspaceId, { body }, { id: message.id });
      const [updated] = await db.update(dm).set({ body: sealed.body, editedAt: sql`now()`, via: null, viaColour: null }).where(eq(dm.id, message.id)).returning({ editedAt: dm.editedAt });
      return updated!.editedAt!;
    },

    async removeDm(message: { id: string; workspaceId: string; dmId: string; authorId: string }): Promise<Date> {
      await db.delete(r).where(eq(r.dmMessageId, message.id));
      // A send retried under an Idempotency-Key stored the message in its answer for replay; the message id is the retry identity too,
      // so dropping the author's stored answers for sends only costs a repeat of the same send (which finds the marker, #1052).
      await forgetSendAnswers(db, message);
      const sealed = await sealFor(db, 'dm_messages', message.workspaceId, { body: REMOVED_BY_AUTHOR_BODY, requestFingerprint: unlinkedFingerprint() }, { id: message.id });
      const [updated] = await db.update(dm).set({ body: sealed.body, requestFingerprint: sealed.requestFingerprint, removedAt: sql`now()`, via: null, viaColour: null }).where(eq(dm.id, message.id)).returning({ removedAt: dm.removedAt });
      await forgetNotices(db, { type: 'dm', id: message.dmId }, `/dm/${message.dmId}#message-${message.id}`);
      return updated!.removedAt!;
    },
  };
}
