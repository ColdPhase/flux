import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { LiveContextRef, LivePresentationRef } from '@flux/contracts';
import { assertAuthorized, NotFoundError, type Database, type LiveAccess, type Principal } from '@flux/core';

/** Resolves identifiers without returning private text; every caller is authorized afterwards. */
export function liveAccess(db: Database): LiveAccess {
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
      await project(principal, projectId);
      const sourceProject = await projectOf(ref.type, ref.id);
      if (sourceProject !== projectId) throw new NotFoundError('Presentation source', 'LIVE_SOURCE_NOT_FOUND');
      const s = schema;
      let exists = false;
      if (ref.type === 'message') {
        exists = ref.version === 1;
      } else if (ref.type === 'material') {
        const [row] = await db.select({ id: s.projectMaterialVersions.materialId }).from(s.projectMaterialVersions)
          .where(and(eq(s.projectMaterialVersions.materialId, ref.id), eq(s.projectMaterialVersions.version, ref.version)));
        exists = Boolean(row);
      } else if (ref.type === 'work') {
        const [row] = await db.select({ version: s.projectWorkItems.version }).from(s.projectWorkItems)
          .where(eq(s.projectWorkItems.id, ref.id));
        // Work has no historical snapshot API yet; do not claim an older version is readable.
        exists = Boolean(row && row.version === ref.version);
      } else if (ref.type === 'result') {
        exists = ref.version === 1;
      } else if (ref.type === 'sketch') {
        const [row] = await db.select({ version: s.sketches.version }).from(s.sketches).where(eq(s.sketches.id, ref.id));
        // A map revision needs the currently readable snapshot until map history exists.
        exists = Boolean(row && row.version === ref.version);
        if (exists && ref.selectedThoughtIds?.length) {
          const ids = [...new Set(ref.selectedThoughtIds)];
          const thoughts = await db.select({ id: s.sketchThoughts.id }).from(s.sketchThoughts)
            .where(and(eq(s.sketchThoughts.sketchId, ref.id), inArray(s.sketchThoughts.id, ids)));
          exists = thoughts.length === ids.length;
        }
      }
      if (!exists) throw new NotFoundError('Presentation source', 'LIVE_SOURCE_NOT_FOUND');
    },
  };
}
