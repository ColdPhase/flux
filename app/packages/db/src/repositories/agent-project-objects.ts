import { and, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type Kind = 'work' | 'decision' | 'result' | 'doc' | 'material' | 'conversation' | 'sketch';

/** Implements core's metadata-only AgentProjectObjectPort; policy stays in core/composition. */
export function agentProjectObjectRows(tx: DbExecutor) {
  return {
    async scopeOf(kind: Kind, id: string, within: { workspaceId: string; projectId: string }, lock = true): Promise<{ workspaceId: string; projectId: string } | null> {
      if (kind === 'doc' || kind === 'material') {
        const table = schema.projectMaterials;
        const query = tx.select({ workspaceId: table.workspaceId, projectId: table.projectId }).from(table)
          .where(and(eq(table.id, id), eq(table.workspaceId, within.workspaceId), eq(table.projectId, within.projectId),
            kind === 'doc' ? eq(table.kind, 'doc') : undefined));
        const [row] = await (lock ? query.for('share') : query);
        return row ?? null;
      }
      if (kind === 'sketch') {
        const table = schema.sketches;
        const query = tx.select({ workspaceId: table.workspaceId, projectId: table.projectId }).from(table)
          .where(and(eq(table.id, id), eq(table.scope, 'project'), eq(table.workspaceId, within.workspaceId),
            eq(table.projectId, within.projectId)));
        const [row] = await (lock ? query.for('share') : query);
        return row?.projectId ? { workspaceId: row.workspaceId, projectId: row.projectId } : null;
      }
      const table = kind === 'work' ? schema.projectWorkItems : kind === 'decision' ? schema.projectDecisions
        : kind === 'result' ? schema.projectResults : schema.projectConversations;
      const query = tx.select({ workspaceId: table.workspaceId, projectId: table.projectId }).from(table)
        .where(and(eq(table.id, id), eq(table.workspaceId, within.workspaceId), eq(table.projectId, within.projectId)));
      // Work identity/scope is immutable. Its mutation and lifecycle fence belongs to
      // the complete sorted native task pass, never this upstream grant preparation.
      const [row] = await (lock && kind !== 'work' ? query.for('share') : query);
      return row ?? null;
    },
  };
}
