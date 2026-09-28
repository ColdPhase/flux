import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { LiveContextRef, LivePresentationRef } from '@flux/contracts';
import { assertAuthorized, enforce, evaluateProject, NotFoundError, type Executor, type LiveAccess, type Principal } from '@flux/core';

/** Recheck and lock the context when a session is created, after resolving its project. */
export async function requireLiveContext(principal: Principal, ref: LiveContextRef,
  projectId: string, db: Executor, lock = false): Promise<void> {
  enforce(await evaluateProject(principal, 'project.read', projectId, db, { lock }), 'project');
  const missing = () => { throw new NotFoundError('Context', 'LIVE_CONTEXT_NOT_FOUND'); };
  if (ref.type === 'conversation') {
    const query = db.select({ projectId: schema.projectConversations.projectId })
      .from(schema.projectConversations).where(eq(schema.projectConversations.id, ref.id));
    const [row] = lock ? await query.for('share') : await query;
    if (!row || row.projectId !== projectId) missing();
    return;
  }
  if (ref.type === 'work') {
    const query = db.select({ projectId: schema.projectWorkItems.projectId })
      .from(schema.projectWorkItems).where(eq(schema.projectWorkItems.id, ref.id));
    const [row] = lock ? await query.for('share') : await query;
    if (!row || row.projectId !== projectId) missing();
    return;
  }
  if (ref.type === 'sketch') {
    const query = db.select({ projectId: schema.sketches.projectId, scope: schema.sketches.scope })
      .from(schema.sketches).where(eq(schema.sketches.id, ref.id));
    const [row] = lock ? await query.for('share') : await query;
    if (!row || row.projectId !== projectId || row.scope !== 'project') missing();
    return;
  }
  missing();
}

/**
 * Called again inside the presentation write transaction with `lock: true`. A source
 * update/deletion and an access revoke then serialize with the identifier-only trace.
 */
export async function requireLivePresentationSource(principal: Principal, projectId: string,
  ref: LivePresentationRef, db: Executor, lock = false): Promise<void> {
  enforce(await evaluateProject(principal, 'project.read', projectId, db, { lock }), 'project');
  const s = schema;
  const missing = () => { throw new NotFoundError('Presentation source', 'LIVE_SOURCE_NOT_FOUND'); };
  if (ref.type === 'message') {
    const query = db.select({ projectId: s.projectMessages.projectId }).from(s.projectMessages).where(eq(s.projectMessages.id, ref.id));
    const [row] = lock ? await query.for('share') : await query;
    if (!row || row.projectId !== projectId || ref.version !== 1) missing();
    return;
  }
  if (ref.type === 'material') {
    const query = db.select({ projectId: s.projectMaterialVersions.projectId }).from(s.projectMaterialVersions)
      .where(and(eq(s.projectMaterialVersions.materialId, ref.id), eq(s.projectMaterialVersions.version, ref.version)));
    const [row] = lock ? await query.for('share') : await query;
    if (!row || row.projectId !== projectId) missing();
    return;
  }
  if (ref.type === 'work') {
    const query = db.select({ projectId: s.projectWorkItems.projectId, version: s.projectWorkItems.version }).from(s.projectWorkItems)
      .where(eq(s.projectWorkItems.id, ref.id));
    const [row] = lock ? await query.for('share') : await query;
    // Work has no historical snapshot API yet: an old version is not a readable source.
    if (!row || row.projectId !== projectId || row.version !== ref.version) missing();
    return;
  }
  if (ref.type === 'result') {
    const query = db.select({ projectId: s.projectResults.projectId }).from(s.projectResults).where(eq(s.projectResults.id, ref.id));
    const [row] = lock ? await query.for('share') : await query;
    if (!row || row.projectId !== projectId || ref.version !== 1) missing();
    return;
  }
  if (ref.type === 'sketch') {
    const query = db.select({ projectId: s.sketches.projectId, scope: s.sketches.scope, version: s.sketches.version })
      .from(s.sketches).where(eq(s.sketches.id, ref.id));
    const [row] = lock ? await query.for('share') : await query;
    if (!row || row.scope !== 'project' || row.projectId !== projectId || row.version !== ref.version) missing();
    if (ref.selectedThoughtIds?.length) {
      const ids = [...new Set(ref.selectedThoughtIds)];
      const thoughtsQuery = db.select({ id: s.sketchThoughts.id }).from(s.sketchThoughts)
        .where(and(eq(s.sketchThoughts.sketchId, ref.id), inArray(s.sketchThoughts.id, ids)));
      const thoughts = lock ? await thoughtsQuery.for('share') : await thoughtsQuery;
      if (thoughts.length !== ids.length) missing();
    }
    return;
  }
  missing();
}

/** Resolves identifiers without returning private text; every caller is authorized afterwards. */
export function liveAccess(db: Executor): LiveAccess {
  const project = (principal: Principal, id: string) =>
    assertAuthorized(principal, 'project.read', { type: 'project', id }, db);

  const projectOf = async (type: LiveContextRef['type'] | LivePresentationRef['type'], id: string): Promise<string | null> => {
    if (type === 'conversation') {
      const [row] = await db.select({ projectId: schema.projectConversations.projectId }).from(schema.projectConversations)
        .where(eq(schema.projectConversations.id, id));
      return row?.projectId ?? null;
    }
    if (type === 'work') {
      const [row] = await db.select({ projectId: schema.projectWorkItems.projectId }).from(schema.projectWorkItems)
        .where(eq(schema.projectWorkItems.id, id));
      return row?.projectId ?? null;
    }
    if (type === 'sketch') {
      const [row] = await db.select({ projectId: schema.sketches.projectId, scope: schema.sketches.scope }).from(schema.sketches)
        .where(eq(schema.sketches.id, id));
      return row?.scope === 'project' ? row.projectId : null;
    }
    if (type === 'message') {
      const [row] = await db.select({ projectId: schema.projectMessages.projectId }).from(schema.projectMessages)
        .where(eq(schema.projectMessages.id, id));
      return row?.projectId ?? null;
    }
    if (type === 'material') {
      const [row] = await db.select({ projectId: schema.projectMaterials.projectId }).from(schema.projectMaterials)
        .where(eq(schema.projectMaterials.id, id));
      return row?.projectId ?? null;
    }
    if (type === 'result') {
      const [row] = await db.select({ projectId: schema.projectResults.projectId }).from(schema.projectResults)
        .where(eq(schema.projectResults.id, id));
      return row?.projectId ?? null;
    }
    return null;
  };

  return {
    async resolveContext(principal, ref) {
      const projectId = await projectOf(ref.type, ref.id);
      if (!projectId) throw new NotFoundError('Context', 'LIVE_CONTEXT_NOT_FOUND');
      await project(principal, projectId);
      return { projectId };
    },

    async requireProject(principal, projectId) {
      await project(principal, projectId);
    },

    async requirePresentation(principal, projectId, ref) {
      await requireLivePresentationSource(principal, projectId, ref, db);
    },
  };
}
