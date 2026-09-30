import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ObjectRef } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle rows for work items, decisions, results and their links (issues #101, #46). They
 * satisfy the `WorkRepository` port of `packages/core/src/work/ports.ts` structurally (this
 * package does not depend on core) and make no access decisions: the core use cases ask the
 * access policy first, and list filters come from the policy's `visibleFilter`.
 */

type Actor = { kind: 'human' | 'agent'; id: string };
type WorkRow = typeof schema.projectWorkItems.$inferSelect;
type DecisionRow = typeof schema.projectDecisions.$inferSelect;
type ResultRow = typeof schema.projectResults.$inferSelect;
type LinkRow = typeof schema.projectObjectLinks.$inferSelect;
type Ref = { type: 'message' | 'thought' | 'work' | 'decision' | 'result' | 'doc' | 'sketch'; id: string } | { type: 'material'; id: string; version: number };
type Window = { limit: number; offset: number };

const w = schema.projectWorkItems;
const d = schema.projectDecisions;
const r = schema.projectResults;
const l = schema.projectObjectLinks;

export function toWorkRecord(row: WorkRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, title: row.title, outcome: row.outcome,
    status: row.status, blocker: row.blocker,
    owner: row.ownerUserId ? { kind: 'human' as const, id: row.ownerUserId } : row.ownerAgentId ? { kind: 'agent' as const, id: row.ownerAgentId } : null,
    parked: row.parkedByDecisionId && row.parkedAt ? { decisionId: row.parkedByDecisionId, at: row.parkedAt } : null,
    createdBy: { kind: row.createdByKind, id: row.createdById }, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export function toDecisionRecord(row: DecisionRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, title: row.title, rationale: row.rationale, status: row.status,
    proposedBy: { kind: row.proposedByKind, id: row.proposedById }, decidedBy: row.decidedBy, decidedAt: row.decidedAt,
    supersedesId: row.supersedesId, supersededById: row.supersededById, supersededAt: row.supersededAt,
    version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export function toResultRecord(row: ResultRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, title: row.title, finding: row.finding, evidence: row.evidence,
    createdBy: { kind: row.createdByKind, id: row.createdById }, createdAt: row.createdAt,
  };
}

function toLinkRecord(row: LinkRow) {
  return { id: row.id, projectId: row.projectId, role: row.role, fromType: row.fromType, fromId: row.fromId, toType: row.toType, toId: row.toId, toVersion: row.toVersion, createdAt: row.createdAt };
}

/** A message's opening words: its first line, at most 120 characters. */
function excerpt(body: string) {
  const line = body.trim().split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Sketches shared with the project; a private sketch's thoughts are never linkable to project work. */
function projectSketch(projectId: string) {
  return and(eq(schema.sketches.projectId, projectId), eq(schema.sketches.scope, 'project'));
}

function ownerColumns(owner: Actor | null | undefined) {
  if (owner === undefined) return {};
  return { ownerUserId: owner?.kind === 'human' ? owner.id : null, ownerAgentId: owner?.kind === 'agent' ? owner.id : null };
}

async function paged<Row, T>(db: DbExecutor, table: typeof w | typeof d | typeof r, where: SQL, window: Window, map: (row: Row) => T) {
  const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(table).where(where);
  const rows = await db.select().from(table).where(where).orderBy(desc(table.createdAt), desc(table.id)).limit(window.limit).offset(window.offset);
  return { items: (rows as Row[]).map(map), total: counted?.total ?? 0 };
}

export function workRows(db: DbExecutor) {
  return {
    async locate(type: 'work' | 'decision' | 'result', id: string) {
      const table = type === 'work' ? w : type === 'decision' ? d : r;
      const [row] = await db.select({ projectId: table.projectId }).from(table).where(eq(table.id, id));
      return row ?? null;
    },

    listWork: (projectId: string, window: Window) => paged(db, w, eq(w.projectId, projectId), window, toWorkRecord),
    listDecisions: (projectId: string, window: Window) => paged(db, d, eq(d.projectId, projectId), window, toDecisionRecord),
    listResults: (projectId: string, window: Window) => paged(db, r, eq(r.projectId, projectId), window, toResultRecord),

    /** Unfinished, unparked work of `owner` in projects matching `visibleProjects` (a condition over `projects`). */
    async listAssigned(workspaceId: string, owner: Actor, visibleProjects: SQL, window: Window) {
      const where = and(
        eq(w.workspaceId, workspaceId),
        owner.kind === 'human' ? eq(w.ownerUserId, owner.id) : eq(w.ownerAgentId, owner.id),
        notInArray(w.status, ['done', 'not_pursued']), isNull(w.parkedAt),
        sql`${w.projectId} IN (SELECT ${schema.projects.id} FROM ${schema.projects} WHERE ${visibleProjects})`,
      )!;
      return paged(db, w, where, window, toWorkRecord);
    },

    async findWork(id: string, options: { lock?: boolean } = {}) {
      const query = db.select().from(w).where(eq(w.id, id));
      const [row] = options.lock ? await query.for('update') : await query;
      return row ? toWorkRecord(row) : null;
    },
    async insertWork(work: { id: string; workspaceId: string; projectId: string; title: string; outcome: string; status: WorkRow['status']; blocker: string | null; owner: Actor | null; createdBy: Actor; clientCommandId?: string; requestFingerprint?: string }) {
      const [row] = await db.insert(w).values({
        id: work.id, workspaceId: work.workspaceId, projectId: work.projectId, title: work.title, outcome: work.outcome,
        status: work.status, blocker: work.blocker, ...ownerColumns(work.owner), createdByKind: work.createdBy.kind, createdById: work.createdBy.id,
        clientCommandId: work.clientCommandId ?? null, requestFingerprint: work.requestFingerprint ?? null,
      }).returning();
      return toWorkRecord(row!);
    },
    async createdWork(projectId: string, by: Actor, commandId: string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`work-create:${projectId}:${by.kind}:${by.id}:${commandId}`}))`);
      const [row] = await db.select().from(w).where(and(eq(w.projectId, projectId), eq(w.createdByKind, by.kind),
        eq(w.createdById, by.id), eq(w.clientCommandId, commandId)));
      return row ? { work: toWorkRecord(row), fingerprint: row.requestFingerprint! } : null;
    },
    async insertCreationNotice(work: ReturnType<typeof toWorkRecord>, sources: ObjectRef[]) {
      await db.insert(schema.projectTaskNotices).values({ id: randomUUID(), workspaceId: work.workspaceId,
        projectId: work.projectId, workId: work.id, kind: 'task.created', createdByKind: work.createdBy.kind,
        createdById: work.createdBy.id, sources, createdAt: work.createdAt });
    },
    async listTaskNotices(projectId: string, window: Window) {
      const n = schema.projectTaskNotices;
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(n).where(eq(n.projectId, projectId));
      const rows = await db.select({ notice: n, workTitle: w.title }).from(n)
        .innerJoin(w, and(eq(w.id, n.workId), eq(w.projectId, n.projectId), eq(w.workspaceId, n.workspaceId)))
        .where(eq(n.projectId, projectId)).orderBy(desc(n.createdAt), desc(n.id)).limit(window.limit).offset(window.offset);
      return { total: count?.total ?? 0, items: rows.map(({ notice, workTitle }) => ({ id: notice.id,
        workspaceId: notice.workspaceId, projectId: notice.projectId, workId: notice.workId, workTitle,
        createdBy: { kind: notice.createdByKind, id: notice.createdById }, sources: notice.sources, createdAt: notice.createdAt })) };
    },
    async updateWork(id: string, changes: { title?: string; outcome?: string; status?: WorkRow['status']; blocker?: string | null; owner?: Actor | null; parked?: { decisionId: string; at: Date } | null }) {
      const [row] = await db.update(w).set({
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.outcome !== undefined ? { outcome: changes.outcome } : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.blocker !== undefined ? { blocker: changes.blocker } : {}),
        ...ownerColumns(changes.owner),
        ...(changes.parked !== undefined ? { parkedByDecisionId: changes.parked?.decisionId ?? null, parkedAt: changes.parked?.at ?? null } : {}),
        version: sql`${w.version} + 1`, updatedAt: new Date(),
      }).where(eq(w.id, id)).returning();
      return toWorkRecord(row!);
    },

    async findDecision(id: string, options: { lock?: boolean } = {}) {
      const query = db.select().from(d).where(eq(d.id, id));
      const [row] = options.lock ? await query.for('update') : await query;
      return row ? toDecisionRecord(row) : null;
    },
    async insertDecision(decision: { id: string; workspaceId: string; projectId: string; title: string; rationale: string; proposedBy: Actor; supersedesId: string | null }) {
      const [row] = await db.insert(d).values({
        id: decision.id, workspaceId: decision.workspaceId, projectId: decision.projectId, title: decision.title, rationale: decision.rationale,
        proposedByKind: decision.proposedBy.kind, proposedById: decision.proposedBy.id, supersedesId: decision.supersedesId,
      }).returning();
      return toDecisionRecord(row!);
    },
    async updateDecision(id: string, changes: { status?: DecisionRow['status']; decidedBy?: string | null; decidedAt?: Date | null; supersededById?: string | null; supersededAt?: Date | null }) {
      const [row] = await db.update(d).set({ ...changes, version: sql`${d.version} + 1`, updatedAt: new Date() }).where(eq(d.id, id)).returning();
      return toDecisionRecord(row!);
    },

    async findResult(id: string) {
      const [row] = await db.select().from(r).where(eq(r.id, id));
      return row ? toResultRecord(row) : null;
    },
    async insertResult(result: { id: string; workspaceId: string; projectId: string; title: string; finding: ResultRow['finding']; evidence: string; createdBy: Actor }) {
      const [row] = await db.insert(r).values({
        id: result.id, workspaceId: result.workspaceId, projectId: result.projectId, title: result.title, finding: result.finding,
        evidence: result.evidence, createdByKind: result.createdBy.kind, createdById: result.createdBy.id,
      }).returning();
      return toResultRecord(row!);
    },

    async links(ids: string[]) {
      if (!ids.length) return [];
      const rows = await db.select().from(l).where(or(inArray(l.fromId, ids), inArray(l.toId, ids))).orderBy(asc(l.createdAt), asc(l.id));
      return rows.map(toLinkRecord);
    },
    async insertLinks(links: { id: string; workspaceId: string; projectId: string; role: LinkRow['role']; from: { type: LinkRow['fromType']; id: string }; to: Ref; createdBy: Actor }[]) {
      if (!links.length) return;
      await db.insert(l).values(links.map((link) => ({
        id: link.id, workspaceId: link.workspaceId, projectId: link.projectId, role: link.role, fromType: link.from.type, fromId: link.from.id,
        toType: link.to.type, toId: link.to.id, toVersion: link.to.type === 'material' ? link.to.version : null,
        createdByKind: link.createdBy.kind, createdById: link.createdBy.id,
      }))).onConflictDoNothing();
    },

    async targetExists(projectId: string, ref: Ref) {
      let found: unknown[];
      switch (ref.type) {
        case 'message':
          found = await db.select({ id: schema.projectMessages.id }).from(schema.projectMessages)
            .where(and(eq(schema.projectMessages.projectId, projectId), eq(schema.projectMessages.id, ref.id)));
          break;
        case 'thought':
          found = await db.select({ id: schema.sketchThoughts.id }).from(schema.sketchThoughts)
            .innerJoin(schema.sketches, eq(schema.sketches.id, schema.sketchThoughts.sketchId))
            .where(and(projectSketch(projectId), eq(schema.sketchThoughts.id, ref.id)));
          break;
        case 'doc':
          found = await db.select({ id: schema.projectMaterials.id }).from(schema.projectMaterials)
            .where(and(eq(schema.projectMaterials.projectId, projectId), eq(schema.projectMaterials.id, ref.id), eq(schema.projectMaterials.kind, 'doc')));
          break;
        case 'sketch':
          found = await db.select({ id: schema.sketches.id }).from(schema.sketches).where(and(projectSketch(projectId), eq(schema.sketches.id, ref.id)));
          break;
        case 'material':
          found = await db.select({ id: schema.projectMaterialVersions.materialId }).from(schema.projectMaterialVersions)
            .where(and(eq(schema.projectMaterialVersions.projectId, projectId), eq(schema.projectMaterialVersions.materialId, ref.id), eq(schema.projectMaterialVersions.version, ref.version)));
          break;
        default: {
          const table = ref.type === 'work' ? w : ref.type === 'decision' ? d : r;
          found = await db.select({ id: table.id }).from(table).where(and(eq(table.projectId, projectId), eq(table.id, ref.id)));
        }
      }
      return found.length > 0;
    },

    /** Titles keyed like core's `refKey`: `<type>:<id>`, or `material:<id>:<version>`. */
    async titles(projectId: string, refs: Ref[]) {
      const titles = new Map<string, { title: string; conversationId?: string; sketchId?: string }>();
      const of = (type: Ref['type']) => [...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id))];
      const messages = of('message');
      if (messages.length) {
        const m = schema.projectMessages;
        for (const row of await db.select({ id: m.id, body: m.body, conversationId: m.conversationId }).from(m).where(and(eq(m.projectId, projectId), inArray(m.id, messages))))
          titles.set(`message:${row.id}`, { title: excerpt(row.body), conversationId: row.conversationId });
      }
      const thoughts = of('thought');
      if (thoughts.length) {
        const t = schema.sketchThoughts;
        const rows = await db.select({ id: t.id, text: t.text, sketchId: t.sketchId }).from(t).innerJoin(schema.sketches, eq(schema.sketches.id, t.sketchId))
          .where(and(projectSketch(projectId), inArray(t.id, thoughts)));
        for (const row of rows) titles.set(`thought:${row.id}`, { title: excerpt(row.text), sketchId: row.sketchId });
      }
      const materials = refs.filter((ref): ref is Extract<Ref, { type: 'material' }> => ref.type === 'material');
      if (materials.length) {
        const v = schema.projectMaterialVersions;
        const rows = await db.select({ id: v.materialId, version: v.version, title: v.title }).from(v)
          .where(and(eq(v.projectId, projectId), inArray(v.materialId, [...new Set(materials.map((ref) => ref.id))])));
        for (const row of rows) titles.set(`material:${row.id}:${row.version}`, { title: row.title });
      }
      const docs = of('doc');
      if (docs.length) {
        const m = schema.projectMaterials;
        const v = schema.projectMaterialVersions;
        const rows = await db.select({ id: m.id, title: v.title }).from(m)
          .innerJoin(v, and(eq(v.materialId, m.id), eq(v.version, m.currentVersion)))
          .where(and(eq(m.projectId, projectId), eq(m.kind, 'doc'), inArray(m.id, docs)));
        for (const row of rows) titles.set(`doc:${row.id}`, { title: row.title });
      }
      const sketchIds = of('sketch');
      if (sketchIds.length) {
        for (const row of await db.select({ id: schema.sketches.id, title: schema.sketches.title }).from(schema.sketches).where(and(projectSketch(projectId), inArray(schema.sketches.id, sketchIds))))
          titles.set(`sketch:${row.id}`, { title: row.title, sketchId: row.id });
      }
      for (const [type, table] of [['work', w], ['decision', d], ['result', r]] as const) {
        const wanted = of(type);
        if (!wanted.length) continue;
        for (const row of await db.select({ id: table.id, title: table.title }).from(table).where(and(eq(table.projectId, projectId), inArray(table.id, wanted))))
          titles.set(`${type}:${row.id}`, { title: row.title });
      }
      return titles;
    },

    async names(refs: Actor[]) {
      const names = new Map<string, string>();
      const users = [...new Set(refs.filter((ref) => ref.kind === 'human').map((ref) => ref.id))];
      const agents = [...new Set(refs.filter((ref) => ref.kind === 'agent').map((ref) => ref.id))];
      if (users.length) {
        for (const row of await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, users)))
          names.set(`human:${row.id}`, row.name);
      }
      if (agents.length) {
        for (const row of await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agents)))
          names.set(`agent:${row.id}`, row.name);
      }
      return names;
    },
  };
}
