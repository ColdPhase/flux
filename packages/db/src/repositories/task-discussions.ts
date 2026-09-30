import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type ConversationRow = typeof schema.projectConversations.$inferSelect;
type MessageRow = typeof schema.projectMessages.$inferSelect;
type Source = { materialId: string; version: number };
type Actor = { kind: 'human' | 'agent'; id: string };
function actor(human: string | null, agent: string | null): Actor {
  if ((human === null) === (agent === null)) throw new Error('Stored discussion actor invariant failed');
  return human !== null ? { kind: 'human', id: human } : { kind: 'agent', id: agent! };
}
function conversation(row: ConversationRow) { return { ...row, createdBy: actor(row.createdBy, row.createdByAgentId) }; }
function message(row: MessageRow) {
  return { ...row, author: actor(row.authorId, row.authorAgentId), source: row.sourceMaterialId && row.sourceMaterialVersion
    ? { materialId: row.sourceMaterialId, version: row.sourceMaterialVersion } : null };
}

/** Canonical conversation rows; policy and command decisions live behind core ports. */
export function taskDiscussionRows(db: DbExecutor) {
  const m = schema.projectMessages;
  const c = schema.projectConversations;
  const b = schema.projectTaskDiscussions;
  return {
    async lockCommand(projectId: string, author: Actor, commandId: string) {
      // Shared namespace with ordinary conversation sends. Collisions merely serialize.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${projectId.toLowerCase()}:${author.kind}:${author.id}:${commandId.toLowerCase()}`}))`);
    },
    async existingMessage(projectId: string, author: Actor, commandId: string) {
      const [row] = await db.select().from(m).where(and(eq(m.projectId, projectId), author.kind === 'human' ? eq(m.authorId, author.id) : eq(m.authorAgentId, author.id), eq(m.clientMessageId, commandId)));
      return row ? message(row) : null;
    },
    async findBinding(workId: string) {
      const [row] = await db.select().from(b).where(eq(b.workId, workId));
      return row ?? null;
    },
    async findConversation(conversationId: string) {
      const [row] = await db.select().from(c).where(eq(c.id, conversationId));
      return row ? conversation(row) : null;
    },
    async findMessage(messageId: string) {
      const [row] = await db.select().from(m).where(eq(m.id, messageId));
      return row ? message(row) : null;
    },
    async messages(conversationId: string, window: { limit: number; beforeSequence: number | null }) {
      const rows = await db.select().from(m).where(and(eq(m.conversationId, conversationId),
        window.beforeSequence === null ? undefined : lt(m.sequence, window.beforeSequence)))
        .orderBy(desc(m.sequence)).limit(window.limit + 1);
      return rows.map(message);
    },
    async sourceExists(projectId: string, source: Source) {
      const v = schema.projectMaterialVersions;
      const [row] = await db.select({ id: v.materialId }).from(v).where(and(eq(v.projectId, projectId),
        eq(v.materialId, source.materialId), eq(v.version, source.version)));
      return !!row;
    },
    async createConversation(input: { id: string; workspaceId: string; projectId: string; createdBy: Actor }) {
      const [row] = await db.insert(c).values({ ...input, createdBy: input.createdBy.kind === 'human' ? input.createdBy.id : null,
        createdByAgentId: input.createdBy.kind === 'agent' ? input.createdBy.id : null }).returning();
      return conversation(row!);
    },
    /** Called in a transaction after current access and the shared command lock. */
    async append(conversation: Pick<ConversationRow, 'id' | 'workspaceId' | 'projectId'>, author: Actor,
      input: { body: string; clientMessageId: string; fingerprint: string; source: Source | null }) {
      const [updated] = await db.update(c).set({ nextSequence: sql`${c.nextSequence} + 1` })
        .where(eq(c.id, conversation.id)).returning({ nextSequence: c.nextSequence });
      if (!updated) throw new Error('Conversation disappeared under contribution lock');
      const [row] = await db.insert(m).values({ id: randomUUID(), workspaceId: conversation.workspaceId,
        projectId: conversation.projectId, conversationId: conversation.id, authorId: author.kind === 'human' ? author.id : null,
        authorAgentId: author.kind === 'agent' ? author.id : null, clientMessageId: input.clientMessageId,
        requestFingerprint: input.fingerprint, sequence: updated.nextSequence - 1, body: input.body,
        sourceMaterialId: input.source?.materialId ?? null, sourceMaterialVersion: input.source?.version ?? null }).returning();
      return message(row!);
    },
    async bind(input: { workId: string; workspaceId: string; projectId: string; conversationId: string; rootMessageId: string }) {
      await db.insert(b).values(input);
    },
  };
}
