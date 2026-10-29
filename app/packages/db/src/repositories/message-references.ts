import { and, asc, eq, inArray } from 'drizzle-orm';
import type { MessageReference } from '@flux/contracts';
import * as schema from '../schema.js';
import { openField, openRows, sealOf } from '../sealing.js';
import type { DbExecutor } from './push.js';

/** The message that cites: a project conversation's or a direct message's (#469, migration 0120). */
export type ReferenceOwner = { kind: 'project' | 'dm'; id: string };

/** What a located map thought is, before any reader's access is decided. Never returned to a caller without that decision. */
export interface LocatedThought {
  id: string; workspaceId: string; sketchId: string; text: string; updatedAt: Date; sketchTitle: string;
  scope: 'project' | 'private' | 'dm'; projectId: string | null; dmId: string | null;
  author: { kind: 'human' | 'agent'; id: string } | null;
}
export type LocatedMessage =
  | { kind: 'project'; id: string; workspaceId: string; projectId: string; conversationId: string; projectName: string; body: string; attachmentCount: number; createdAt: Date;
    author: { kind: 'human' | 'agent'; id: string } }
  | { kind: 'dm'; id: string; workspaceId: string; dmId: string; body: string; createdAt: Date; author: { kind: 'human'; id: string } };

const BATCH = 5_000;
const actorOf = (userId: string | null, agentId: string | null) => userId !== null ? { kind: 'human' as const, id: userId } : agentId !== null ? { kind: 'agent' as const, id: agentId } : null;

/**
 * Persistence of the references of messages and the plain location of what they cite (#469). It decides nothing about
 * access: the server resolves each card through the one access policy, and only then reads a title, an author or a place out of
 * what is located here.
 */
export function messageReferenceRows(db: DbExecutor) {
  const r = schema.messageReferences;
  const ownerColumn = (kind: ReferenceOwner['kind']) => kind === 'project' ? r.projectMessageId : r.dmMessageId;
  return {
    /** Stores the references of a message just inserted, in the order given. */
    async save(owner: ReferenceOwner, workspaceId: string, references: readonly MessageReference[]) {
      if (!references.length) return;
      await db.insert(r).values(references.map((reference, position) => ({ workspaceId, position, kind: reference.kind, targetId: reference.id,
        projectMessageId: owner.kind === 'project' ? owner.id : null, dmMessageId: owner.kind === 'dm' ? owner.id : null })));
    },

    /** The stored references of these messages, each list in attachment order. Messages without any are absent. */
    async stored(kind: ReferenceOwner['kind'], messageIds: readonly string[]) {
      const grouped = new Map<string, MessageReference[]>();
      const column = ownerColumn(kind);
      for (let start = 0; start < messageIds.length; start += BATCH) {
        const rows = await db.select({ owner: column, kind: r.kind, targetId: r.targetId }).from(r)
          .where(inArray(column, messageIds.slice(start, start + BATCH))).orderBy(asc(column), asc(r.position));
        for (const row of rows) {
          const list = grouped.get(row.owner!) ?? [];
          list.push({ kind: row.kind, id: row.targetId });
          grouped.set(row.owner!, list);
        }
      }
      return grouped;
    },

    /**
     * The lookups are bounded by the citing message's workspace in SQL, before anything is opened or any policy is asked: an id of
     * another workspace (locked and sealed included) is not found, exactly as an id that does not exist, so no answer names it.
     * Opened here, never in SQL (F-030): a sealed workspace's thought text, sketch title, message body and project name are read through its seal. */
    async thought(id: string, workspaceId: string): Promise<LocatedThought | null> {
      const [row] = await db.select({ id: schema.sketchThoughts.id, workspaceId: schema.sketchThoughts.workspaceId, sketchId: schema.sketchThoughts.sketchId,
        text: schema.sketchThoughts.text, updatedAt: schema.sketchThoughts.updatedAt, sketchTitle: schema.sketches.title, scope: schema.sketches.scope,
        projectId: schema.sketches.projectId, dmId: schema.sketches.dmId, userId: schema.sketchThoughts.createdByUserId, agentId: schema.sketchThoughts.createdByAgentId })
        .from(schema.sketchThoughts).innerJoin(schema.sketches, eq(schema.sketches.id, schema.sketchThoughts.sketchId))
        .where(and(eq(schema.sketchThoughts.id, id), eq(schema.sketchThoughts.workspaceId, workspaceId)));
      if (!row) return null;
      const { userId, agentId, ...fields } = row;
      const [opened] = await openRows(db, 'sketch_thoughts', [{ id: fields.id, workspaceId: fields.workspaceId, text: fields.text }]);
      const seal = await sealOf(db, fields.workspaceId, { write: false });
      return { ...fields, text: opened!.text, sketchTitle: openField('sketches', 'title', [fields.sketchId], fields.sketchTitle, seal)!, author: actorOf(userId, agentId) };
    },

    /** A project message or, failing that, a direct message with this id; null for any other id. */
    async message(id: string, workspaceId: string): Promise<LocatedMessage | null> {
      const m = schema.projectMessages;
      const [project] = await db.select({ id: m.id, workspaceId: m.workspaceId, projectId: m.projectId, conversationId: m.conversationId, projectName: schema.projects.name,
        body: m.body, attachmentCount: m.attachmentCount, createdAt: m.createdAt, userId: m.authorId, agentId: m.authorAgentId })
        .from(m).innerJoin(schema.projects, eq(schema.projects.id, m.projectId)).where(and(eq(m.id, id), eq(m.workspaceId, workspaceId)));
      if (project) {
        const { userId, agentId, ...fields } = project;
        const [opened] = await openRows(db, 'project_messages', [{ id: fields.id, workspaceId: fields.workspaceId, body: fields.body }]);
        const seal = await sealOf(db, fields.workspaceId, { write: false });
        return { kind: 'project', ...fields, body: opened!.body, projectName: openField('projects', 'name', [fields.projectId], fields.projectName, seal)!, author: actorOf(userId, agentId)! };
      }
      const d = schema.dmMessages;
      const [dm] = await db.select({ id: d.id, workspaceId: d.workspaceId, dmId: d.dmId, body: d.body, createdAt: d.createdAt, userId: d.authorId }).from(d).where(and(eq(d.id, id), eq(d.workspaceId, workspaceId)));
      if (!dm) return null;
      const { userId, ...fields } = dm;
      const [opened] = await openRows(db, 'dm_messages', [{ id: fields.id, workspaceId: fields.workspaceId, body: fields.body }]);
      return { kind: 'dm', ...fields, body: opened!.body, author: { kind: 'human', id: userId } };
    },
  };
}
