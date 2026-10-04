import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import { TaskUseRefusal, type TaskUseFence } from './task-use.js';
import { prepareReferencedTaskUse, referencedTaskIds } from './task-targets.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle rows for project docs (issue #112): #36 materials of kind `doc` and their immutable
 * versions. They satisfy the `DocRepository` port of `packages/core/src/docs/ports.ts`
 * structurally and make no access decisions; list filters come from the policy's
 * `visibleFilter`. Versions are only inserted; the database also rejects updates to them.
 */

type Actor = { kind: 'human' | 'agent'; id: string };
type Ref = { type: 'message' | 'thought' | 'work' | 'decision' | 'result' | 'doc' | 'sketch'; id: string } | { type: 'material'; id: string; version: number };
type Window = { limit: number; offset: number };
type MaterialRow = typeof schema.projectMaterials.$inferSelect;
type VersionRow = typeof schema.projectMaterialVersions.$inferSelect;
type SnapshotRow = typeof schema.docLiveSnapshots.$inferSelect;
type NewVersion = { title: string; body: string; state: 'draft' | 'published'; reason: string; author: Actor };

const m = schema.projectMaterials;
const v = schema.projectMaterialVersions;
const p = schema.projects;
const l = schema.projectObjectLinks;
const s = schema.docLiveSnapshots;

/** Exactly one stored actor (migration 0043): a person, or the agent that wrote under a standing grant (#152). */
function actor(human: string | null, agent: string | null): Actor {
  if ((human === null) === (agent === null)) throw new Error('Stored doc actor invariant failed');
  return human !== null ? { kind: 'human', id: human } : { kind: 'agent', id: agent! };
}
const columns = (by: Actor) => ({ human: by.kind === 'human' ? by.id : null, agent: by.kind === 'agent' ? by.id : null });

function toDoc(row: MaterialRow) {
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, createdBy: actor(row.createdBy, row.createdByAgentId),
    currentVersion: row.currentVersion, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function toVersion(row: VersionRow, snapshot: SnapshotRow | null = null) {
  return {
    docId: row.materialId, projectId: row.projectId, version: row.version, title: row.title, body: row.body,
    state: row.state ?? 'published', reason: row.reason, author: actor(row.authorId, row.authorAgentId), createdAt: row.createdAt,
    ...(snapshot ? { contributors: snapshot.contributors, liveSnapshot: { generation: snapshot.generation,
      fromSequence: snapshot.fromSequence, toSequence: snapshot.toSequence } } : {}),
  };
}

function versionValues({ author, ...version }: NewVersion) {
  const by = columns(author);
  return { ...version, authorId: by.human, authorAgentId: by.agent };
}

export function docRows(db: DbExecutor) {
  const current = and(eq(v.materialId, m.id), eq(v.version, m.currentVersion));
  const savedSnapshot = and(eq(s.docId, v.materialId), eq(s.version, v.version));
  const joined = () => db.select({ doc: m, current: v, snapshot: s, projectName: p.name }).from(m).innerJoin(v, current)
    .innerJoin(p, eq(p.id, m.projectId)).leftJoin(s, savedSnapshot);
  const map = (rows: { doc: MaterialRow; current: VersionRow; snapshot: SnapshotRow | null; projectName: string }[]) =>
    rows.map((row) => ({ doc: toDoc(row.doc), current: toVersion(row.current, row.snapshot), projectName: row.projectName }));

  async function paged(where: SQL, window: Window) {
    const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(m).where(where);
    const rows = await joined().where(where).orderBy(desc(m.updatedAt), desc(m.id)).limit(window.limit).offset(window.offset);
    return { items: map(rows), total: counted?.total ?? 0 };
  }

  async function find(id: string, options: { lock?: boolean } = {}) {
    if (options.lock) await db.select({ id: m.id }).from(m).where(and(eq(m.id, id), eq(m.kind, 'doc'))).for('update');
    const [row] = await joined().where(and(eq(m.id, id), eq(m.kind, 'doc')));
    return row ? map([row])[0]! : null;
  }

  async function assertTaskUse(docId: string, refs: readonly Ref[], retained: Pick<TaskUseFence, 'ids'>) {
    const previous = await db.select({ type: l.toType, id: l.toId }).from(l)
      .where(and(eq(l.fromId, docId), eq(l.fromType, 'doc'), eq(l.role, 'mentions')));
    const actual = await referencedTaskIds(db, [...previous, ...refs]);
    const held = new Set(retained.ids);
    if (actual.some((id) => !held.has(id))) throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
  }

  return {
    async locate(id: string) {
      const [row] = await db.select({ projectId: m.projectId }).from(m).where(and(eq(m.id, id), eq(m.kind, 'doc')));
      return row ?? null;
    },

    list: (projectId: string, window: Window) => paged(and(eq(m.projectId, projectId), eq(m.kind, 'doc'))!, window),

    /** Docs of the workspace in projects matching `visibleProjects` (a condition over `projects`). */
    listVisible: (workspaceId: string, visibleProjects: SQL, window: Window) => paged(and(
      eq(m.workspaceId, workspaceId), eq(m.kind, 'doc'),
      sql`${m.projectId} IN (SELECT ${p.id} FROM ${p} WHERE ${visibleProjects})`,
    )!, window),

    find,

    async version(id: string, version: number) {
      const [row] = await db.select({ version: v, snapshot: s }).from(v).innerJoin(m, eq(m.id, v.materialId)).leftJoin(s, savedSnapshot)
        .where(and(eq(v.materialId, id), eq(v.version, version), eq(m.kind, 'doc')));
      return row ? toVersion(row.version, row.snapshot) : null;
    },

    async versions(id: string, window: Window) {
      const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(v).where(eq(v.materialId, id));
      const rows = await db.select({ version: v, snapshot: s }).from(v).leftJoin(s, savedSnapshot)
        .where(eq(v.materialId, id)).orderBy(desc(v.version)).limit(window.limit).offset(window.offset);
      return { items: rows.map((row) => toVersion(row.version, row.snapshot)), total: counted?.total ?? 0 };
    },

    async insert(doc: { id: string; workspaceId: string; projectId: string; createdBy: Actor }, first: NewVersion) {
      const by = columns(doc.createdBy);
      await db.insert(m).values({ id: doc.id, workspaceId: doc.workspaceId, projectId: doc.projectId, createdBy: by.human, createdByAgentId: by.agent, kind: 'doc' });
      await db.insert(v).values({ workspaceId: doc.workspaceId, projectId: doc.projectId, materialId: doc.id, version: 1, ...versionValues(first) });
      return (await find(doc.id))!;
    },

    async append(id: string, next: NewVersion) {
      const [updated] = await db.update(m).set({ currentVersion: sql`${m.currentVersion} + 1`, updatedAt: new Date() }).where(and(eq(m.id, id), eq(m.kind, 'doc'))).returning();
      await db.insert(v).values({ workspaceId: updated!.workspaceId, projectId: updated!.projectId, materialId: id, version: updated!.currentVersion, ...versionValues(next) });
      return (await find(id))!;
    },

    async prepareTaskUse(scope: { workspaceId: string; projectId: string }, docId: string, refs: readonly Ref[]) {
      const previous = await db.select({ type: l.toType, id: l.toId }).from(l)
        .where(and(eq(l.fromId, docId), eq(l.fromType, 'doc'), eq(l.role, 'mentions')));
      return prepareReferencedTaskUse(db, scope.projectId, [...previous, ...refs]);
    },

    assertTaskUse,

    async replaceMentions(scope: { workspaceId: string; projectId: string }, docId: string, targets: Ref[], by: Actor, retained?: Pick<TaskUseFence, 'ids' | 'mark'>) {
      // The doc/material row is already retained by the caller. Include removed targets
      // before replacing links, so a later removal cannot erase evidence of use.
      const previous = await db.select({ type: l.toType, id: l.toId }).from(l)
        .where(and(eq(l.fromId, docId), eq(l.fromType, 'doc'), eq(l.role, 'mentions')));
      const fence = retained ?? await prepareReferencedTaskUse(db, scope.projectId, [...previous, ...targets]);
      // Body resolution can change while preparation waits for a graph. Verify the
      // final saved targets without extending the already retained graph/task set.
      await assertTaskUse(docId, targets, fence);
      await db.delete(l).where(and(eq(l.fromId, docId), eq(l.fromType, 'doc'), eq(l.role, 'mentions')));
      if (targets.length) await db.insert(l).values(targets.map((to) => ({
        id: randomUUID(), workspaceId: scope.workspaceId, projectId: scope.projectId, role: 'mentions' as const, fromType: 'doc' as const, fromId: docId,
        toType: to.type, toId: to.id, toVersion: to.type === 'material' ? to.version : null, createdByKind: by.kind, createdById: by.id,
      }))).onConflictDoNothing();
      await fence.mark();
    },
  };
}
