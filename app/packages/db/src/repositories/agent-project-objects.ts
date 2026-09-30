import { and, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type Kind = 'work' | 'decision' | 'result' | 'doc' | 'material' | 'conversation' | 'sketch';

/** Implements core's metadata-only AgentProjectObjectPort; policy stays in core/composition. */
export function agentProjectObjectRows(tx: DbExecutor) {
  return {
    async scopeOf(kind: Kind, id: string, within: { workspaceId: string; projectId: string }): Promise<{ workspaceId: string; projectId: string } | null> {
      if (kind === 'doc' || kind === 'material') {
        const table = schema.projectMaterials;
        const [row] = await tx.select({ workspaceId: table.workspaceId, projectId: table.projectId }).from(table)
          .where(and(eq(table.id, id), eq(table.workspaceId, within.workspaceId), eq(table.projectId, within.projectId),
            kind === 'doc' ? eq(table.kind, 'doc') : undefined)).for('share');
        return row ?? null;
      }
      if (kind === 'sketch') {
        const table = schema.sketches;
        const [row] = await tx.select({ workspaceId: table.workspaceId, projectId: table.projectId }).from(table)
          .where(and(eq(table.id, id), eq(table.scope, 'project'), eq(table.workspaceId, within.workspaceId),
            eq(table.projectId, within.projectId))).for('share');
        return row?.projectId ? { workspaceId: row.workspaceId, projectId: row.projectId } : null;
      }
      const table = kind === 'work' ? schema.projectWorkItems : kind === 'decision' ? schema.projectDecisions
        : kind === 'result' ? schema.projectResults : schema.projectConversations;
      const [row] = await tx.select({ workspaceId: table.workspaceId, projectId: table.projectId }).from(table)
        .where(and(eq(table.id, id), eq(table.workspaceId, within.workspaceId), eq(table.projectId, within.projectId))).for('share');
      return row ?? null;
    },
  };
}
