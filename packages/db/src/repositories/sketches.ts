import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle persistence for sketches, thoughts and links (issues #69, #46). The rows satisfy the
 * ports in `packages/core/src/sketches/ports.ts` structurally (this package does not depend on
 * core). They make no access decisions: list queries take the policy's condition over
 * `sketches` from the caller, and the server composes it with `visibleFilter`.
 */

type Author = { kind: 'human' | 'agent'; id: string };
const s = schema.sketches;
const t = schema.sketchThoughts;
const l = schema.sketchLinks;
const p = schema.sketchParticipants;
const users = schema.authUsers;
const agents = schema.agents;

function author(principal: Author) {
  return principal.kind === 'agent' ? { createdByUserId: null, createdByAgentId: principal.id } : { createdByUserId: principal.id, createdByAgentId: null };
}

function person(userId: string | null, agentId: string | null, userName: string | null, agentName: string | null) {
  return userId ? { kind: 'human' as const, id: userId, name: userName ?? '' } : { kind: 'agent' as const, id: agentId!, name: agentName ?? '' };
}

const sketchCreator = alias(users, 'sketch_creator');
const sketchAgent = alias(agents, 'sketch_agent');
const sketchColumns = { row: s, userName: sketchCreator.name, agentName: sketchAgent.name };

function toSketchRecord({ row, userName, agentName }: { row: typeof s.$inferSelect; userName: string | null; agentName: string | null }) {
  return {
    id: row.id, workspaceId: row.workspaceId, scope: row.scope, projectId: row.projectId, title: row.title,
    createdBy: person(row.createdByUserId, row.createdByAgentId, userName, agentName),
    version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

const thoughtCreator = alias(users, 'thought_creator');
const thoughtAgent = alias(agents, 'thought_agent');

function toThoughtRecord({ row, userName, agentName }: { row: typeof t.$inferSelect; userName: string | null; agentName: string | null }) {
  return {
    id: row.id, sketchId: row.sketchId, text: row.text, x: row.x, y: row.y, width: row.width, height: row.height, shape: row.shape,
    placement: row.placementType && row.placementId ? { type: row.placementType, id: row.placementId } : null,
    createdBy: person(row.createdByUserId, row.createdByAgentId, userName, agentName),
    version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function toLinkRecord(row: typeof l.$inferSelect) {
  return { id: row.id, sketchId: row.sketchId, fromId: row.fromId, toId: row.toId, label: row.label, createdAt: row.createdAt };
}

export interface NewSketchRow {
  id: string; workspaceId: string; scope: 'project' | 'direct'; projectId: string | null; title: string; createdBy: Author; participantIds: string[];
}
export interface NewThoughtRow {
  id: string; workspaceId: string; sketchId: string; text: string; x: number; y: number; width: number; height: number;
  shape: 'card' | 'pill' | 'circle'; placement: { type: 'draft'; id: string } | null; createdBy: Author;
}
export interface NewLinkRow {
  id: string; workspaceId: string; sketchId: string; fromId: string; toId: string; label: string | null; createdBy: Author;
}
export type ThoughtChangeRow = Partial<{ text: string; x: number; y: number; width: number; height: number; shape: 'card' | 'pill' | 'circle' }>;

export function sketchRows(db: DbExecutor) {
  const selectSketches = () => db.select(sketchColumns).from(s)
    .leftJoin(sketchCreator, eq(sketchCreator.id, s.createdByUserId))
    .leftJoin(sketchAgent, eq(sketchAgent.id, s.createdByAgentId));
  const selectThoughts = () => db.select({ row: t, userName: thoughtCreator.name, agentName: thoughtAgent.name }).from(t)
    .leftJoin(thoughtCreator, eq(thoughtCreator.id, t.createdByUserId))
    .leftJoin(thoughtAgent, eq(thoughtAgent.id, t.createdByAgentId));
  const findSketch = async (id: string) => {
    const [row] = await selectSketches().where(eq(s.id, id));
    return row ? toSketchRecord(row) : null;
  };
  const findThought = async (sketchId: string, id: string) => {
    const [row] = await selectThoughts().where(and(eq(t.sketchId, sketchId), eq(t.id, id)));
    if (!row) throw new Error('Thought row vanished inside its transaction');
    return toThoughtRecord(row);
  };

  return {
    /** Rows of `workspaceId` matching `audience` (the policy's list condition), newest change first. */
    async list(workspaceId: string, audience: SQL, filter: { projectId?: string }, page: { limit: number; offset: number }) {
      const where = and(eq(s.workspaceId, workspaceId), audience, filter.projectId ? eq(s.projectId, filter.projectId) : undefined);
      const rows = await selectSketches().where(where).orderBy(desc(s.updatedAt), asc(s.id)).limit(page.limit).offset(page.offset);
      const [total] = await db.select({ total: count() }).from(s).where(where);
      return { items: rows.map(toSketchRecord), total: total?.total ?? 0 };
    },
    findSketch,
    async participants(sketchIds: string[]) {
      const result = new Map<string, { id: string; name: string }[]>();
      if (!sketchIds.length) return result;
      const rows = await db.select({ sketchId: p.sketchId, id: p.userId, name: users.name }).from(p)
        .innerJoin(users, eq(users.id, p.userId)).where(inArray(p.sketchId, sketchIds)).orderBy(asc(p.createdAt), asc(users.name));
      for (const row of rows) result.set(row.sketchId, [...(result.get(row.sketchId) ?? []), { id: row.id, name: row.name }]);
      return result;
    },
    async insertSketch(sketch: NewSketchRow) {
      await db.insert(s).values({ id: sketch.id, workspaceId: sketch.workspaceId, scope: sketch.scope, projectId: sketch.projectId, title: sketch.title, ...author(sketch.createdBy) });
      if (sketch.participantIds.length) {
        await db.insert(p).values(sketch.participantIds.map((userId) => ({ workspaceId: sketch.workspaceId, sketchId: sketch.id, userId })));
      }
      return (await findSketch(sketch.id))!;
    },
    async renameSketch(id: string, title: string) {
      await db.update(s).set({ title, version: sql`${s.version} + 1`, updatedAt: new Date() }).where(eq(s.id, id));
      return (await findSketch(id))!;
    },
    async touchSketch(id: string) {
      await db.update(s).set({ updatedAt: new Date() }).where(eq(s.id, id));
    },
    async thoughts(sketchId: string) {
      return (await selectThoughts().where(eq(t.sketchId, sketchId)).orderBy(asc(t.createdAt), asc(t.id))).map(toThoughtRecord);
    },
    async lockThoughts(sketchId: string, ids: string[]) {
      if (!ids.length) return [];
      const locked = await db.select({ id: t.id }).from(t).where(and(eq(t.sketchId, sketchId), inArray(t.id, ids))).orderBy(asc(t.id)).for('update');
      if (!locked.length) return [];
      return (await selectThoughts().where(and(eq(t.sketchId, sketchId), inArray(t.id, locked.map((row) => row.id)))).orderBy(asc(t.id))).map(toThoughtRecord);
    },
    async thoughtExists(id: string) {
      return (await db.select({ id: t.id }).from(t).where(eq(t.id, id))).length > 0;
    },
    async insertThought(thought: NewThoughtRow) {
      await db.insert(t).values({
        id: thought.id, workspaceId: thought.workspaceId, sketchId: thought.sketchId, text: thought.text, x: thought.x, y: thought.y,
        width: thought.width, height: thought.height, shape: thought.shape,
        placementType: thought.placement?.type ?? null, placementId: thought.placement?.id ?? null, ...author(thought.createdBy),
      });
      return findThought(thought.sketchId, thought.id);
    },
    async updateThought(sketchId: string, id: string, changes: ThoughtChangeRow) {
      await db.update(t).set({ ...changes, version: sql`${t.version} + 1`, updatedAt: new Date() }).where(and(eq(t.sketchId, sketchId), eq(t.id, id)));
      return findThought(sketchId, id);
    },
    async deleteThought(sketchId: string, id: string) {
      await db.delete(t).where(and(eq(t.sketchId, sketchId), eq(t.id, id)));
    },
    async links(sketchId: string) {
      return (await db.select().from(l).where(eq(l.sketchId, sketchId)).orderBy(asc(l.createdAt), asc(l.id))).map(toLinkRecord);
    },
    async linkExists(id: string) {
      return (await db.select({ id: l.id }).from(l).where(eq(l.id, id))).length > 0;
    },
    async linkBetween(sketchId: string, a: string, b: string) {
      const [row] = await db.select().from(l).where(and(eq(l.sketchId, sketchId), or(and(eq(l.fromId, a), eq(l.toId, b)), and(eq(l.fromId, b), eq(l.toId, a)))));
      return row ? toLinkRecord(row) : null;
    },
    async insertLink(link: NewLinkRow) {
      const [row] = await db.insert(l).values({ id: link.id, workspaceId: link.workspaceId, sketchId: link.sketchId, fromId: link.fromId, toId: link.toId, label: link.label, ...author(link.createdBy) }).returning();
      return toLinkRecord(row!);
    },
    async deleteLink(sketchId: string, id: string) {
      return (await db.delete(l).where(and(eq(l.sketchId, sketchId), eq(l.id, id))).returning({ id: l.id })).length > 0;
    },
  };
}
