import { sql, type SQL } from 'drizzle-orm';
import type { WorkObjectType, WorkReadRef } from '@flux/contracts';
import type { DbExecutor } from './push.js';

/** Native structural scope, matching workRows.targetExists. Central project.read is
 * required by the caller first; private/DM sketches are never project-work endpoints.
 */
export function nativeWorkEndpointVisible(projectId: string, kind: SQL, id: SQL, version = sql`NULL`): SQL {
  return sql`CASE ${kind}
    WHEN 'work' THEN EXISTS(SELECT 1 FROM project_work_items o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'decision' THEN EXISTS(SELECT 1 FROM project_decisions o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'result' THEN EXISTS(SELECT 1 FROM project_results o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'message' THEN EXISTS(SELECT 1 FROM project_messages o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'material' THEN EXISTS(SELECT 1 FROM project_material_versions o WHERE o.project_id = ${projectId}::uuid AND o.material_id = ${id} AND o.version = ${version})
    WHEN 'doc' THEN EXISTS(SELECT 1 FROM project_materials o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id} AND o.kind = 'doc')
    WHEN 'sketch' THEN EXISTS(SELECT 1 FROM sketches o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id} AND o.scope = 'project')
    WHEN 'thought' THEN EXISTS(SELECT 1 FROM sketch_thoughts t JOIN sketches s ON s.id = t.sketch_id WHERE s.project_id = ${projectId}::uuid AND t.id = ${id} AND s.scope = 'project')
    ELSE false END`;
}

/** Both endpoints are filtered before counting, selection or any label hydration. */
export function nativeVisibleWorkEdges(projectId: string): SQL {
  return sql`SELECT e.* FROM project_object_links e WHERE e.project_id = ${projectId}::uuid
    AND (${nativeWorkEndpointVisible(projectId, sql`e.from_type`, sql`e.from_id`)})
    AND (${nativeWorkEndpointVisible(projectId, sql`e.to_type`, sql`e.to_id`, sql`e.to_version`)})`;
}
export type NativeWorkReadObject = { kind: WorkObjectType; id: string };
export type NativeWorkSourceScope = { messageIds: string[] } | { conversationId: string };
export type NativeWorkRelationFacts = NativeWorkReadObject & { edges: number; sourceMessages: number; sourceMaterials: number; decisions: number; results: number; rule: WorkReadRef | null };

export function nativeWorkVisibilityRows(db: DbExecutor) {
  return {
    /** Fixed-size SQL aggregate covers all counted/uncounted native link endpoints,
     * including sources outside the returned object/edge window. No graph leaves DB.
     */
    async fingerprint(projectId: string, sources?: NativeWorkSourceScope) {
      if (sources && 'messageIds' in sources && (sources.messageIds.length < 1 || sources.messageIds.length > 100)) throw new Error('Invalid bounded source fingerprint selector');
      const sourceFacts = !sources ? sql`SELECT NULL::text AS fact WHERE false` : 'conversationId' in sources ? sql`
        SELECT 'conversation:' || c.id::text AS fact FROM project_conversations c WHERE c.project_id = ${projectId}::uuid AND c.id = ${sources.conversationId}::uuid
        UNION ALL SELECT 'message:' || m.id::text || ':' || m.conversation_id::text AS fact FROM project_messages m
          WHERE m.project_id = ${projectId}::uuid AND m.conversation_id = ${sources.conversationId}::uuid`
        : sql`SELECT 'message:' || m.id::text || ':' || m.conversation_id::text AS fact FROM project_messages m
          WHERE m.project_id = ${projectId}::uuid AND m.id IN (${sql.join(sources.messageIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
      const result = await db.execute<{ fingerprint: string }>(sql`WITH link_facts AS (SELECT
        'link:' || e.id::text || ':' || e.from_type || ':' || e.from_id::text || ':' || e.to_type || ':' || e.to_id::text || ':' || coalesce(e.to_version::text, '') || ':' || e.role || ':' ||
        (${nativeWorkEndpointVisible(projectId, sql`e.from_type`, sql`e.from_id`)})::text || ':' ||
        (${nativeWorkEndpointVisible(projectId, sql`e.to_type`, sql`e.to_id`, sql`e.to_version`)})::text AS fact
        FROM project_object_links e WHERE e.project_id = ${projectId}::uuid), source_facts AS (${sourceFacts}), facts AS (
          SELECT fact FROM link_facts UNION ALL SELECT fact FROM source_facts)
        SELECT encode(sha256(convert_to(coalesce(string_agg(fact, ',' ORDER BY fact COLLATE "C"), ''), 'UTF8')), 'hex') AS fingerprint FROM facts`);
      const fingerprint = result.rows[0]?.fingerprint;
      if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Native source visibility could not be observed');
      return fingerprint;
    },

    /** Exactly one scalar aggregate row per bounded native object; never hydrate its links. */
    async relations(projectId: string, objects: readonly NativeWorkReadObject[]): Promise<NativeWorkRelationFacts[]> {
      if (objects.length > 100) throw new Error('Native relation count batch exceeds the bound');
      if (!objects.length) return [];
      const expectedCount = objects.length;
      const refs = objects.map((object) => sql`(${object.kind}::text, ${object.id}::uuid)`);
      const result = await db.execute<NativeWorkRelationFacts>(sql`WITH refs(kind, id) AS (VALUES ${sql.join(refs, sql`, `)}), visible AS (${nativeVisibleWorkEdges(projectId)})
        SELECT g.kind, g.id, count(DISTINCT e.id)::int AS edges,
          count(DISTINCT e.to_id) FILTER (WHERE e.from_type = g.kind AND e.from_id = g.id AND e.role = 'source' AND e.to_type = 'message')::int AS "sourceMessages",
          count(DISTINCT (e.to_id, e.to_version)) FILTER (WHERE e.from_type = g.kind AND e.from_id = g.id AND e.role = 'source' AND e.to_type = 'material')::int AS "sourceMaterials",
          count(DISTINCT CASE WHEN e.from_type = 'decision' AND NOT(g.kind = 'decision' AND g.id = e.from_id) THEN e.from_id
            WHEN e.to_type = 'decision' AND NOT(g.kind = 'decision' AND g.id = e.to_id) THEN e.to_id END)::int AS decisions,
          count(DISTINCT CASE WHEN e.from_type = 'result' AND NOT(g.kind = 'result' AND g.id = e.from_id) THEN e.from_id
            WHEN e.to_type = 'result' AND NOT(g.kind = 'result' AND g.id = e.to_id) THEN e.to_id END)::int AS results,
          (SELECT json_build_object('kind', 'decision', 'id', d.id, 'title', d.title)
            FROM visible v JOIN project_decisions d ON d.project_id = ${projectId}::uuid AND ((v.from_type = 'decision' AND d.id = v.from_id) OR (v.to_type = 'decision' AND d.id = v.to_id))
            WHERE g.kind = 'work' AND ((v.from_type = g.kind AND v.from_id = g.id) OR (v.to_type = g.kind AND v.to_id = g.id))
            ORDER BY v.created_at, v.id LIMIT 1) AS rule
        FROM refs g LEFT JOIN visible e ON (e.from_type = g.kind AND e.from_id = g.id) OR (e.to_type = g.kind AND e.to_id = g.id)
        GROUP BY g.kind, g.id`);
      if (result.rows.length !== expectedCount) throw new Error('Incomplete native relation count observation');
      return result.rows;
    },
  };
}
