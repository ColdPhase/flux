import { sql, type SQL } from 'drizzle-orm';
import type { AgentSourceCheckpoint, AgentSourceKind, AgentSourceReference } from '@flux/contracts';
type AgentOrientationScope = Pick<AgentSourceReference, 'workspaceId' | 'projectId'>;
import type { DbExecutor } from './push.js';

type MetadataRow = { id: string; title: string; version: number | null; updated_at: Date | string | null; sequence: number | null; state: string | null }
/** Exact native scope precedes all labels/counts. Upstream/private overlays require their canonical policy predicate here before publication. */
function source(scope: AgentOrientationScope, kind: AgentSourceKind): SQL {
  if (kind === 'doc' || kind === 'material') return sql`
    SELECT m.id, left(v.title, 300) AS title, m.current_version AS version,
      m.updated_at, NULL::integer AS sequence, v.state
    FROM project_materials m JOIN project_material_versions v
      ON v.workspace_id = m.workspace_id AND v.project_id = m.project_id AND v.material_id = m.id AND v.version = m.current_version
    WHERE m.workspace_id = ${scope.workspaceId} AND m.project_id = ${scope.projectId} AND m.kind = ${kind}`;
  if (kind === 'map') return sql`
    SELECT id, left(title, 300) AS title, version, updated_at, NULL::integer AS sequence, NULL::text AS state
    FROM sketches WHERE workspace_id = ${scope.workspaceId} AND project_id = ${scope.projectId} AND scope = 'project'`;
  if (kind === 'conversation') return sql`
    SELECT c.id, coalesce(left(m.body, 300), '') AS title, NULL::integer AS version,
      NULL::timestamptz AS updated_at, c.next_sequence - 1 AS sequence, NULL::text AS state
    FROM project_conversations c LEFT JOIN project_messages m ON m.conversation_id = c.id AND m.sequence = 1
      AND m.workspace_id = c.workspace_id AND m.project_id = c.project_id
    WHERE c.workspace_id = ${scope.workspaceId} AND c.project_id = ${scope.projectId}`;
  const table = kind === 'work' ? sql`project_work_items` : kind === 'decision' ? sql`project_decisions` : sql`project_results`;
  const version = kind === 'result' ? sql`NULL::integer` : sql`version`;
  const at = kind === 'result' ? sql`NULL::timestamptz` : sql`updated_at`;
  const state = kind === 'result' ? sql`finding` : sql`status`;
  return sql`SELECT id, left(title, 300) AS title, ${version} AS version, ${at} AS updated_at,
    NULL::integer AS sequence, ${state} AS state FROM ${table}
    WHERE workspace_id = ${scope.workspaceId} AND project_id = ${scope.projectId} ${kind === 'work' ? sql`AND creation_reverted_at IS NULL` : sql``}`;
}
function reference(scope: AgentOrientationScope, kind: AgentSourceKind, row: MetadataRow): AgentSourceReference {
  const checkpoint: AgentSourceCheckpoint = kind === 'result' ? { kind, id: row.id }
    : kind === 'conversation' ? { kind, id: row.id, sequence: row.sequence! }
      : kind === 'map' ? { kind, id: row.id, version: row.version!, updatedAt: new Date(row.updated_at!).toISOString() }
        : { kind, id: row.id, version: row.version! };
  return { ...scope, checkpoint, title: row.title, state: row.state };
}
/** Caller holds the current connection, selected-project and canonical project policy locks. */
export function agentOrientationRows(tx: DbExecutor) {
  return {
    async list(scope: AgentOrientationScope, kind: AgentSourceKind, page: { limit: number; offset: number }) {
      const query = source(scope, kind);
      const count = await tx.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM (${query}) sources`);
      const result = await tx.execute<MetadataRow>(sql`SELECT * FROM (${query}) sources ORDER BY id LIMIT ${page.limit} OFFSET ${page.offset}`);
      return { items: result.rows.map((row) => reference(scope, kind, row)), total: count.rows[0]!.total };
    },
    async find(scope: AgentOrientationScope, kind: AgentSourceKind, id: string) {
      const result = await tx.execute<MetadataRow>(sql`SELECT * FROM (${source(scope, kind)}) sources WHERE id = ${id}`);
      return result.rows[0] ? reference(scope, kind, result.rows[0]) : null;
    },
  };
}
