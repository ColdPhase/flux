import { sql, type Placeholder, type SQL } from 'drizzle-orm';
import type { WorkObjectType, WorkReadRef } from '@flux/contracts';
import type { DbExecutor } from './push.js';
import { openField, sealOf } from '../sealing.js';
import { preparedTemplate } from '../prepared.js';

/** Native structural scope, matching workRows.targetExists. Central project.read is
 * required by the caller first; private/DM sketches are never project-work endpoints.
 */
export function nativeWorkEndpointVisible(projectId: string | Placeholder, kind: SQL, id: SQL, version = sql`NULL`): SQL {
  return sql`CASE ${kind}
    WHEN 'work' THEN EXISTS(SELECT 1 FROM project_work_items o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'decision' THEN EXISTS(SELECT 1 FROM project_decisions o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'message' THEN EXISTS(SELECT 1 FROM project_messages o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'material' THEN EXISTS(SELECT 1 FROM project_material_versions o WHERE o.project_id = ${projectId}::uuid AND o.material_id = ${id} AND o.version = ${version})
    WHEN 'doc' THEN EXISTS(SELECT 1 FROM project_materials o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id} AND o.kind = 'doc')
    WHEN 'sketch' THEN EXISTS(SELECT 1 FROM sketches o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id} AND o.scope = 'project')
    WHEN 'thought' THEN EXISTS(SELECT 1 FROM sketch_thoughts t JOIN sketches s ON s.id = t.sketch_id WHERE s.project_id = ${projectId}::uuid AND t.id = ${id} AND s.scope = 'project')
    ELSE false END`;
}

/** Both endpoints are filtered before counting, selection or any label hydration. */
export function nativeVisibleWorkEdges(projectId: string | Placeholder): SQL {
  return sql`SELECT e.* FROM project_object_links e WHERE e.project_id = ${projectId}::uuid
    AND (${nativeWorkEndpointVisible(projectId, sql`e.from_type`, sql`e.from_id`)})
    AND (${nativeWorkEndpointVisible(projectId, sql`e.to_type`, sql`e.to_id`, sql`e.to_version`)})`;
}
export type NativeWorkReadObject = { kind: WorkObjectType; id: string };
export type NativeWorkSourceScope = { messageIds: string[] } | { conversationId: string };
export type NativeWorkRelationFacts = NativeWorkReadObject & { edges: number; sourceMessages: number; sourceMaterials: number; decisions: number; rule: WorkReadRef | null };

/**
 * The fingerprint and the relation counts, composed once per shape (#1178): Drizzle built them from about forty fragments on every call,
 * twice and once in every work read. The values are placeholders: the space, then the conversation, the messages or the objects.
 */
const project = sql.placeholder('project');
function fingerprintOf(sourceFacts: SQL) {
  return preparedTemplate<{ fingerprint: string; observedAt: string }>(() => sql`WITH link_facts AS (SELECT
        'link:' || e.id::text || ':' || e.from_type || ':' || e.from_id::text || ':' || e.to_type || ':' || e.to_id::text || ':' || coalesce(e.to_version::text, '') || ':' || e.role || ':' ||
        (${nativeWorkEndpointVisible(project, sql`e.from_type`, sql`e.from_id`)})::text || ':' ||
        (${nativeWorkEndpointVisible(project, sql`e.to_type`, sql`e.to_id`, sql`e.to_version`)})::text AS fact
        FROM project_object_links e WHERE e.project_id = ${project}::uuid), source_facts AS (${sourceFacts}), facts AS (
          SELECT fact FROM link_facts UNION ALL SELECT fact FROM source_facts)
        SELECT encode(sha256(convert_to(coalesce(string_agg(fact, ',' ORDER BY fact COLLATE "C"), ''), 'UTF8')), 'hex') AS fingerprint,
          to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt" FROM facts`);
}
const fingerprints = {
  none: fingerprintOf(sql`SELECT NULL::text AS fact WHERE false`),
  conversation: fingerprintOf(sql`
        SELECT 'conversation:' || c.id::text AS fact FROM project_conversations c WHERE c.project_id = ${project}::uuid AND c.id = ${sql.placeholder('conversation')}::uuid
        UNION ALL SELECT 'message:' || m.id::text || ':' || m.conversation_id::text AS fact FROM project_messages m
          WHERE m.project_id = ${project}::uuid AND m.conversation_id = ${sql.placeholder('conversation')}::uuid`),
  messages: fingerprintOf(sql`SELECT 'message:' || m.id::text || ':' || m.conversation_id::text AS fact FROM project_messages m
          WHERE m.project_id = ${project}::uuid AND m.id = ANY(${sql.placeholder('messages')}::uuid[])`),
};
const relationCounts = preparedTemplate<NativeWorkRelationFacts>(() => sql`WITH refs(kind, id) AS (
          SELECT * FROM unnest(${sql.placeholder('kinds')}::text[], ${sql.placeholder('ids')}::uuid[])),
        visible AS (${nativeVisibleWorkEdges(project)})
        SELECT g.kind, g.id, count(DISTINCT e.id)::int AS edges,
          count(DISTINCT e.to_id) FILTER (WHERE e.from_type = g.kind AND e.from_id = g.id AND e.role = 'source' AND e.to_type = 'message')::int AS "sourceMessages",
          count(DISTINCT (e.to_id, e.to_version)) FILTER (WHERE e.from_type = g.kind AND e.from_id = g.id AND e.role = 'source' AND e.to_type = 'material')::int AS "sourceMaterials",
          count(DISTINCT CASE WHEN e.from_type = 'decision' AND NOT(g.kind = 'decision' AND g.id = e.from_id) THEN e.from_id
            WHEN e.to_type = 'decision' AND NOT(g.kind = 'decision' AND g.id = e.to_id) THEN e.to_id END)::int AS decisions,
          (SELECT json_build_object('kind', 'decision', 'id', d.id, 'title', d.title)
            FROM visible v JOIN project_decisions d ON d.project_id = ${project}::uuid AND ((v.from_type = 'decision' AND d.id = v.from_id) OR (v.to_type = 'decision' AND d.id = v.to_id))
            WHERE g.kind = 'work' AND ((v.from_type = g.kind AND v.from_id = g.id) OR (v.to_type = g.kind AND v.to_id = g.id))
            ORDER BY v.created_at, v.id LIMIT 1) AS rule
        FROM refs g LEFT JOIN visible e ON (e.from_type = g.kind AND e.from_id = g.id) OR (e.to_type = g.kind AND e.to_id = g.id)
        GROUP BY g.kind, g.id`);

export function nativeWorkVisibilityRows(db: DbExecutor) {
  /** The fingerprint with the read's observation time (the transaction's), in the same statement (#1429). */
  async function observation(projectId: string, sources?: NativeWorkSourceScope) {
    if (sources && 'messageIds' in sources && (sources.messageIds.length < 1 || sources.messageIds.length > 100)) throw new Error('Invalid bounded source fingerprint selector');
    const result = !sources ? await fingerprints.none(db, { project: projectId })
      : 'conversationId' in sources ? await fingerprints.conversation(db, { project: projectId, conversation: sources.conversationId })
        : await fingerprints.messages(db, { project: projectId, messages: sources.messageIds });
    const { fingerprint, observedAt } = result.rows[0] ?? {};
    if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint) || !observedAt) throw new Error('Native source visibility could not be observed');
    return { fingerprint, observedAt };
  }
  return {
    /** Fixed-size SQL aggregate covers all counted/uncounted native link endpoints,
     * including sources outside the returned object/edge window. No graph leaves DB.
     */
    async fingerprint(projectId: string, sources?: NativeWorkSourceScope) {
      return (await observation(projectId, sources)).fingerprint;
    },
    observation,

    /** Exactly one scalar aggregate row per bounded native object; never hydrate its links. */
    async relations(projectId: string, objects: readonly NativeWorkReadObject[]): Promise<NativeWorkRelationFacts[]> {
      if (objects.length > 100) throw new Error('Native relation count batch exceeds the bound');
      if (!objects.length) return [];
      const expectedCount = objects.length;
      const result = await relationCounts(db, { project: projectId, kinds: objects.map((object) => object.kind), ids: objects.map((object) => object.id) });
      if (result.rows.length !== expectedCount) throw new Error('Incomplete native relation count observation');
      // F-030: the rule's title comes through SQL sealed; it is opened here.
      const withRule = result.rows.filter((row) => row.rule);
      if (withRule.length) {
        const [project] = (await db.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM projects WHERE id = ${projectId}::uuid`)).rows;
        const seal = await sealOf(db, project!.workspace_id, { write: false });
        for (const row of withRule) row.rule = { ...row.rule!, title: openField('project_decisions', 'title', [row.rule!.id], row.rule!.title, seal)! };
      }
      return result.rows;
    },
  };
}
