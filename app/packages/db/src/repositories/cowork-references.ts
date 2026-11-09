import { sql, type SQL } from 'drizzle-orm';
import type { CoWorkSourceRef } from '@flux/contracts';
import type { DbExecutor } from './push.js';

/** True when every reference of a jsonb array exists in the project at its exact recorded version (a unit's outcome, #153). */
export function readableReferenceSet(references: SQL, workspaceId: SQL, projectId: SQL) {
  return sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      ${references}
    ) AS reference(value)
    WHERE NOT COALESCE(CASE reference.value->>'type'
      WHEN 'message' THEN EXISTS (SELECT 1 FROM project_messages object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId})
      WHEN 'work' THEN EXISTS (SELECT 1 FROM project_work_items object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId}
          AND object.version::text=reference.value->>'version')
      WHEN 'material' THEN EXISTS (SELECT 1 FROM project_materials object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId}
          AND object.current_version::text=reference.value->>'version')
      WHEN 'doc' THEN EXISTS (SELECT 1 FROM project_materials object
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId} AND object.project_id=${projectId}
          AND object.kind='doc' AND object.current_version::text=reference.value->>'version')
      WHEN 'thought' THEN EXISTS (SELECT 1 FROM sketch_thoughts object JOIN sketches map
        ON map.workspace_id=object.workspace_id AND map.id=object.sketch_id
        WHERE object.id::text=reference.value->>'id' AND object.workspace_id=${workspaceId}
          AND map.project_id=${projectId} AND map.scope='project' AND object.version::text=reference.value->>'version')
      ELSE false END, false)
  )`;
}

export function coworkReferenceRows(tx: DbExecutor) {
  return {
    /** True when every reference exists in this project at its exact recorded version. GitHub refs are never readable here. */
    async referencesReadable(workspaceId: string, projectId: string, references: readonly CoWorkSourceRef[]) {
      const result = await tx.execute<{ readable: boolean }>(sql`SELECT ${readableReferenceSet(sql`${JSON.stringify(references)}::jsonb`,
        sql`${workspaceId}::uuid`, sql`${projectId}::uuid`)} AS readable`);
      return result.rows[0]?.readable === true;
    },
  };
}
