import { sql } from 'drizzle-orm';
import type { LinkRole, ObjectLink, ObjectRef, SourceAssociationCounts, WorkObjectType, WorkReadCursor } from '@flux/contracts';
import type { DbExecutor } from './push.js';
import { nativeReadKeyWindow } from './work-read-keys.js';
import { nativeVisibleWorkEdges, nativeWorkEndpointVisible, type NativeWorkReadObject, type NativeWorkSourceScope } from './work-read-visibility.js';

export type NativeWorkAssociationSelector = NativeWorkSourceScope & { relation: 'source' | 'any' };
export type NativeWorkRelationSelector = { objects: NativeWorkReadObject[]; role?: LinkRole };
export function nativeWorkSourceMessages(projectId: string, sources: NativeWorkSourceScope) {
  const predicate = 'conversationId' in sources ? sql`m.conversation_id = ${sources.conversationId}::uuid` : sql`m.id IN (${sql.join(sources.messageIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  return sql`SELECT m.id, m.created_at FROM project_messages m WHERE m.project_id = ${projectId}::uuid AND (${predicate})`;
}
function matching(projectId: string, selection: NativeWorkAssociationSelector) {
  return sql`WITH visible AS (${nativeVisibleWorkEdges(projectId)}), messages AS (${nativeWorkSourceMessages(projectId, selection)})
    SELECT e.* FROM visible e WHERE e.from_type IN ('work', 'decision', 'result') AND e.to_type = 'message'
      AND e.to_id IN (SELECT id FROM messages) AND (${selection.relation === 'source' ? sql`e.role = 'source'` : sql`true`})`;
}
function objectPredicate(objects: readonly NativeWorkReadObject[], both: boolean) {
  return objects.length ? sql.join(objects.map((object) => sql`(e.from_type = ${object.kind} AND e.from_id = ${object.id}::uuid)${both ? sql` OR (e.to_type = ${object.kind} AND e.to_id = ${object.id}::uuid)` : sql``}`), sql` OR `) : sql`false`;
}
function title(projectId: string, kind: ReturnType<typeof sql>, id: ReturnType<typeof sql>, version = sql`NULL`) {
  return sql`CASE ${kind}
    WHEN 'work' THEN (SELECT o.title FROM project_work_items o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'decision' THEN (SELECT o.title FROM project_decisions o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'result' THEN (SELECT o.title FROM project_results o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'message' THEN (SELECT left(split_part(btrim(o.body), E'\n', 1), 120) FROM project_messages o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id})
    WHEN 'material' THEN (SELECT o.title FROM project_material_versions o WHERE o.project_id = ${projectId}::uuid AND o.material_id = ${id} AND o.version = ${version})
    WHEN 'doc' THEN (SELECT v.title FROM project_materials o JOIN project_material_versions v ON v.material_id = o.id AND v.version = o.current_version WHERE o.project_id = ${projectId}::uuid AND o.id = ${id} AND o.kind = 'doc')
    WHEN 'sketch' THEN (SELECT o.title FROM sketches o WHERE o.project_id = ${projectId}::uuid AND o.id = ${id} AND o.scope = 'project')
    WHEN 'thought' THEN (SELECT left(split_part(btrim(t.text), E'\n', 1), 120) FROM sketch_thoughts t JOIN sketches s ON s.id = t.sketch_id WHERE s.project_id = ${projectId}::uuid AND t.id = ${id} AND s.scope = 'project')
    ELSE NULL END`;
}

export function nativeWorkAssociationRows(db: DbExecutor) {
  return {
    async sourcesExist(projectId: string, sources: NativeWorkSourceScope) {
      if ('messageIds' in sources && (!sources.messageIds.length || sources.messageIds.length > 100)) throw new Error('Invalid bounded native source selector');
      const expected = 'conversationId' in sources ? 1 : sources.messageIds.length;
      const selected = 'conversationId' in sources ? sql`SELECT id FROM project_conversations WHERE project_id = ${projectId}::uuid AND id = ${sources.conversationId}::uuid` : nativeWorkSourceMessages(projectId, sources);
      const result = await db.execute<{ total: number }>(sql`WITH selected AS (${selected}) SELECT count(*)::int AS total FROM selected`);
      if (!result.rows[0]) throw new Error('Missing native source validation');
      return result.rows[0].total === expected;
    },
    async objectsExist(projectId: string, objects: readonly NativeWorkReadObject[]) {
      if (!objects.length || objects.length > 100) throw new Error('Invalid bounded native object selector');
      const refs = sql.join(objects.map((object) => sql`(${object.kind}::text, ${object.id}::uuid)`), sql`, `);
      const result = await db.execute<{ ok: boolean }>(sql`WITH refs(kind, id) AS (VALUES ${refs}) SELECT bool_and(${nativeWorkEndpointVisible(projectId, sql`kind`, sql`id`)}) AS ok FROM refs`);
      if (!result.rows[0]) throw new Error('Missing native object validation');
      return result.rows[0].ok;
    },
    objectKeys(projectId: string, selection: NativeWorkAssociationSelector, limit: number, cursor?: WorkReadCursor) {
      const selected = sql`WITH matched AS (${matching(projectId, selection)})
        SELECT 'work'::text AS kind, o.id, o.created_at, 0 AS rank FROM project_work_items o WHERE o.project_id = ${projectId}::uuid AND EXISTS(SELECT 1 FROM matched e WHERE e.from_type = 'work' AND e.from_id = o.id)
        UNION ALL SELECT 'decision'::text AS kind, o.id, o.created_at, 1 AS rank FROM project_decisions o WHERE o.project_id = ${projectId}::uuid AND EXISTS(SELECT 1 FROM matched e WHERE e.from_type = 'decision' AND e.from_id = o.id)
        UNION ALL SELECT 'result'::text AS kind, o.id, o.created_at, 2 AS rank FROM project_results o WHERE o.project_id = ${projectId}::uuid AND EXISTS(SELECT 1 FROM matched e WHERE e.from_type = 'result' AND e.from_id = o.id)`;
      return nativeReadKeyWindow<WorkObjectType>(db, selected, limit, cursor);
    },
    async sourceCounts(projectId: string, selection: NativeWorkAssociationSelector, cursor?: WorkReadCursor) {
      const keys = await nativeReadKeyWindow<'message'>(db, sql`SELECT 'message'::text AS kind, id, created_at, 0 AS rank FROM (${nativeWorkSourceMessages(projectId, selection)}) m`, 100, cursor, true);
      if (!keys.items.length) return { ...keys, items: [] };
      const ids = sql.join(keys.items.map((key) => sql`${key.id}::uuid`), sql`, `);
      const result = await db.execute<{ messageId: string; work: number; decisions: number; results: number; edges: number }>(sql`WITH matched AS (${matching(projectId, selection)})
        SELECT m.id AS "messageId", count(DISTINCT e.from_id) FILTER(WHERE e.from_type = 'work')::int AS work,
          count(DISTINCT e.from_id) FILTER(WHERE e.from_type = 'decision')::int AS decisions,
          count(DISTINCT e.from_id) FILTER(WHERE e.from_type = 'result')::int AS results, count(e.id)::int AS edges
        FROM project_messages m LEFT JOIN matched e ON e.to_id = m.id WHERE m.project_id = ${projectId}::uuid AND m.id IN (${ids}) GROUP BY m.id`);
      const byId = new Map<string, SourceAssociationCounts>(result.rows.map((row) => [row.messageId, row]));
      return { ...keys, items: keys.items.map((key) => {
        const value = byId.get(key.id); if (!value) throw new Error('Missing native message count'); return { key: { rank: key.rank, createdAt: key.createdAt, id: key.id }, value };
      }) };
    },
    relationKeys(projectId: string, selection: NativeWorkRelationSelector, limit: number, cursor?: WorkReadCursor) {
      const selected = sql`WITH visible AS (${nativeVisibleWorkEdges(projectId)}) SELECT 'edge'::text AS kind, e.id, e.created_at, 0 AS rank FROM visible e
        WHERE (${objectPredicate(selection.objects, true)}) AND (${selection.role ? sql`e.role = ${selection.role}` : sql`true`})`;
      return nativeReadKeyWindow<'edge'>(db, selected, limit, cursor, true);
    },
    associationEdgeKeys(projectId: string, selection: NativeWorkAssociationSelector, objects: readonly NativeWorkReadObject[], limit: number, cursor?: WorkReadCursor) {
      return nativeReadKeyWindow<'edge'>(db, sql`WITH matched AS (${matching(projectId, selection)}) SELECT 'edge'::text AS kind, e.id, e.created_at, 0 AS rank FROM matched e WHERE (${objectPredicate(objects, false)})`, limit, cursor, true);
    },
    async edgeTotal(projectId: string, selection: NativeWorkAssociationSelector) {
      const result = await db.execute<{ total: number }>(sql`WITH matched AS (${matching(projectId, selection)}) SELECT count(*)::int AS total FROM matched`);
      if (!result.rows[0]) throw new Error('Missing native edge total'); return result.rows[0].total;
    },
    async edges(projectId: string, ids: readonly string[]): Promise<ObjectLink[]> {
      if (ids.length > 100) throw new Error('Native edge hydration exceeds the global bound');
      if (!ids.length) return [];
      const ordered = [...ids];
      type Row = { id: string; role: LinkRole; fromType: ObjectLink['from']['type']; fromId: string; toType: ObjectRef['type']; toId: string; toVersion: number | null; fromTitle: string | null; toTitle: string | null; conversationId: string | null; sketchId: string | null; createdAt: Date };
      const found = await db.execute<Row>(sql`WITH visible AS (${nativeVisibleWorkEdges(projectId)}) SELECT e.id, e.role, e.from_type AS "fromType", e.from_id AS "fromId", e.to_type AS "toType", e.to_id AS "toId", e.to_version AS "toVersion", e.created_at AS "createdAt",
        ${title(projectId, sql`e.from_type`, sql`e.from_id`)} AS "fromTitle", ${title(projectId, sql`e.to_type`, sql`e.to_id`, sql`e.to_version`)} AS "toTitle",
        CASE WHEN e.to_type = 'message' THEN (SELECT m.conversation_id FROM project_messages m WHERE m.project_id = ${projectId}::uuid AND m.id = e.to_id) ELSE NULL END AS "conversationId",
        CASE WHEN e.to_type = 'sketch' THEN e.to_id WHEN e.to_type = 'thought' THEN (SELECT t.sketch_id FROM sketch_thoughts t JOIN sketches s ON s.id = t.sketch_id WHERE s.project_id = ${projectId}::uuid AND s.scope = 'project' AND t.id = e.to_id) ELSE NULL END AS "sketchId"
        FROM visible e WHERE e.id IN (${sql.join(ordered.map((id) => sql`${id}::uuid`), sql`, `)})`);
      const rows = new Map(found.rows.map((row) => [row.id, row]));
      return ordered.map((id) => {
        const row = rows.get(id); if (!row || row.fromTitle === null || row.toTitle === null) throw new Error('Missing required native edge endpoint metadata');
        const to: ObjectRef = row.toType === 'material' ? { type: 'material', id: row.toId, version: row.toVersion! } : { type: row.toType, id: row.toId };
        return { id, projectId, role: row.role, from: { type: row.fromType, id: row.fromId }, to, fromTitle: row.fromTitle, toTitle: row.toTitle,
          conversationId: row.conversationId, sketchId: row.sketchId, createdAt: row.createdAt.toISOString() };
      });
    },
  };
}
