import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle rows for the return view (issue #106). They satisfy the `ReturnRepository` port of
 * `packages/core/src/returns/ports.ts` structurally (this package does not depend on core) and
 * make no access decisions: the core use case authorizes every event before it asks for the
 * objects the event names, and project lists take the policy's `visibleFilter` from the caller.
 */

type Place = { key: string; type: 'home' | 'project' | 'conversation'; projectId: string | null; conversationId: string | null };
const rp = schema.returnPoints;

const pointColumns = { seq: rp.seq, savedAt: rp.savedAt, previousSeq: rp.previousSeq, previousSavedAt: rp.previousSavedAt };

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

const actorKey = (kind: string, id: string) => `${kind}:${id}`;

function excerpt(body: string) {
  const line = body.trim().split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

export function returnRows(db: DbExecutor) {
  return {
    async points(userId: string, keys: string[]) {
      if (!keys.length) return new Map();
      const rows = await db.select({ key: rp.placeKey, ...pointColumns }).from(rp).where(and(eq(rp.userId, userId), inArray(rp.placeKey, keys)));
      return new Map(rows.map(({ key, ...point }) => [key, point]));
    },

    /** Forward only: an older or equal position leaves the point (and its previous one) as it is. */
    async advance(userId: string, place: Place, seq: number) {
      const [row] = await db.insert(rp).values({
        userId, placeKey: place.key, placeType: place.type, projectId: place.projectId, conversationId: place.conversationId, seq,
      }).onConflictDoUpdate({
        target: [rp.userId, rp.placeKey],
        set: { seq, savedAt: sql`now()`, previousSeq: sql`${rp.seq}`, previousSavedAt: sql`${rp.savedAt}` },
        setWhere: sql`${rp.seq} < ${seq}`,
      }).returning(pointColumns);
      if (row) return row;
      const [current] = await db.select(pointColumns).from(rp).where(and(eq(rp.userId, userId), eq(rp.placeKey, place.key)));
      return current!;
    },

    async restore(userId: string, key: string) {
      const [row] = await db.update(rp).set({ seq: sql`${rp.previousSeq}`, savedAt: sql`${rp.previousSavedAt}`, previousSeq: null, previousSavedAt: null })
        .where(and(eq(rp.userId, userId), eq(rp.placeKey, key), sql`${rp.previousSeq} IS NOT NULL`)).returning(pointColumns);
      if (row) return row;
      // A point first saved in the visit being undone had no previous one: the place is unviewed again.
      await db.delete(rp).where(and(eq(rp.userId, userId), eq(rp.placeKey, key), sql`${rp.previousSeq} IS NULL`));
      return null;
    },

    /** The recipient's own audience rows after `afterSeq`, newest first, by primary key. */
    audienceAfter(recipient: string, afterSeq: number, limit: number) {
      return db.select({
        id: schema.events.id, seq: schema.eventAudience.seq, kind: schema.events.kind, workspaceId: schema.events.workspaceId,
        objectId: schema.events.objectId, actorId: schema.events.actorId, data: sql<Record<string, unknown>>`${schema.events.data}`,
        createdAt: schema.events.createdAt,
      }).from(schema.eventAudience)
        .innerJoin(schema.events, eq(schema.events.id, schema.eventAudience.eventId))
        .where(and(eq(schema.eventAudience.recipient, recipient), gt(schema.eventAudience.seq, afterSeq)))
        .orderBy(desc(schema.eventAudience.seq)).limit(limit);
    },

    async audienceSeq(recipient: string, eventId: string) {
      const [row] = await db.select({ seq: schema.eventAudience.seq }).from(schema.eventAudience)
        .where(and(eq(schema.eventAudience.recipient, recipient), eq(schema.eventAudience.eventId, eventId)));
      return row?.seq ?? null;
    },

    async lastEvent(recipient: string) {
      const [row] = await db.select({ id: schema.eventAudience.eventId, seq: schema.eventAudience.seq }).from(schema.eventAudience)
        .where(eq(schema.eventAudience.recipient, recipient)).orderBy(desc(schema.eventAudience.seq)).limit(1);
      return row ?? null;
    },

    /** Ids of the workspace's projects that pass `visible` (the policy's list condition). */
    async projectIdsWhere(workspaceId: string, visible: SQL) {
      const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, workspaceId), visible));
      return new Set(rows.map((row) => row.id));
    },

    /** The project of a conversation, whoever may read it; callers must authorize before using it. */
    async conversationProject(id: string) {
      const [row] = await db.select({ projectId: schema.projectConversations.projectId }).from(schema.projectConversations).where(eq(schema.projectConversations.id, id));
      return row?.projectId ?? null;
    },

    async projects(ids: string[]) {
      if (!ids.length) return new Map();
      return byId(await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, ids)));
    },

    async work(ids: string[]) {
      if (!ids.length) return new Map();
      const w = schema.projectWorkItems;
      const rows = await db.select().from(w).where(inArray(w.id, ids));
      return byId(rows.map((row) => ({
        id: row.id, projectId: row.projectId, title: row.title, status: row.status, blocker: row.blocker,
        ownerKey: row.ownerUserId ? actorKey('human', row.ownerUserId) : row.ownerAgentId ? actorKey('agent', row.ownerAgentId) : null,
        createdByKey: actorKey(row.createdByKind, row.createdById), parkedByDecisionId: row.parkedByDecisionId, createdAt: row.createdAt,
      })));
    },

    async decisions(ids: string[]) {
      if (!ids.length) return new Map();
      const d = schema.projectDecisions;
      const rows = await db.select().from(d).where(inArray(d.id, ids));
      return byId(rows.map((row) => ({
        id: row.id, projectId: row.projectId, title: row.title, rationale: row.rationale, status: row.status,
        proposedByKey: actorKey(row.proposedByKind, row.proposedById), supersedesId: row.supersedesId, supersededById: row.supersededById,
      })));
    },

    async results(ids: string[]) {
      if (!ids.length) return new Map();
      const r = schema.projectResults;
      const rows = await db.select().from(r).where(inArray(r.id, ids));
      return byId(rows.map((row) => ({
        id: row.id, projectId: row.projectId, title: row.title, finding: row.finding as 'positive' | 'negative', evidence: row.evidence,
        createdByKey: actorKey(row.createdByKind, row.createdById),
      })));
    },

    /** Work linked from a result (any role), kept inside the result's project. */
    async resultWork(resultIds: string[]) {
      const map = new Map<string, string[]>();
      if (!resultIds.length) return map;
      const l = schema.projectObjectLinks;
      const r = schema.projectResults;
      const rows = await db.select({ resultId: l.fromId, workId: l.toId }).from(l)
        .innerJoin(r, and(eq(r.id, l.fromId), eq(r.projectId, l.projectId)))
        .where(and(eq(l.fromType, 'result'), eq(l.toType, 'work'), inArray(l.fromId, resultIds)))
        .orderBy(asc(l.createdAt));
      for (const row of rows) map.set(row.resultId, [...(map.get(row.resultId) ?? []), row.workId]);
      return map;
    },

    async messages(ids: string[]) {
      if (!ids.length) return new Map();
      const m = schema.projectMessages;
      return byId(await db.select({ id: m.id, projectId: m.projectId, conversationId: m.conversationId, authorId: m.authorId, body: m.body, sequence: m.sequence, createdAt: m.createdAt })
        .from(m).where(inArray(m.id, ids)));
    },

    async conversations(ids: string[]) {
      if (!ids.length) return new Map();
      const c = schema.projectConversations;
      const m = schema.projectMessages;
      const rows = await db.select({ id: c.id, projectId: c.projectId, createdBy: c.createdBy, opening: m.body }).from(c)
        .leftJoin(m, and(eq(m.conversationId, c.id), eq(m.sequence, 1))).where(inArray(c.id, ids));
      return byId(rows.map((row) => ({ ...row, opening: excerpt(row.opening ?? '') })));
    },

    async lastPosts(userId: string, conversationIds: string[]) {
      if (!conversationIds.length) return new Map();
      const m = schema.projectMessages;
      const rows = await db.select({ id: m.conversationId, at: sql<Date>`max(${m.createdAt})`.mapWith((value) => new Date(value as string)) })
        .from(m).where(and(eq(m.authorId, userId), inArray(m.conversationId, conversationIds))).groupBy(m.conversationId);
      return new Map(rows.map((row) => [row.id, row.at]));
    },

    async materials(ids: string[]) {
      if (!ids.length) return new Map();
      const pm = schema.projectMaterials;
      const v = schema.projectMaterialVersions;
      const rows = await db.select({ id: pm.id, projectId: pm.projectId, title: v.title, version: pm.currentVersion }).from(pm)
        .innerJoin(v, and(eq(v.materialId, pm.id), eq(v.version, pm.currentVersion))).where(inArray(pm.id, ids));
      return byId(rows);
    },

    async sketches(ids: string[]) {
      if (!ids.length) return new Map();
      const s = schema.sketches;
      return byId(await db.select({ id: s.id, workspaceId: s.workspaceId, projectId: s.projectId, title: s.title }).from(s).where(inArray(s.id, ids)));
    },

    async names(keys: string[]) {
      const humans = keys.filter((item) => item.startsWith('human:')).map((item) => item.slice(6));
      const agents = keys.filter((item) => item.startsWith('agent:')).map((item) => item.slice(6)).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      const names = new Map<string, string>();
      if (humans.length) for (const row of await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, humans))) names.set(`human:${row.id}`, row.name);
      if (agents.length) for (const row of await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agents))) names.set(`agent:${row.id}`, row.name);
      return names;
    },
  };
}
