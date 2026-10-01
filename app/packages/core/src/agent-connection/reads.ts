import { NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import { requireAgentSelection, type AgentConnectionContext } from './proposals.js';

export type AgentProjectObjectKind = 'work' | 'decision' | 'result' | 'doc' | 'material' | 'conversation' | 'sketch';
/** Metadata only. No title, body, private provenance or object existence reaches the caller. */
export interface AgentProjectObjectPort {
  scopeOf(kind: AgentProjectObjectKind, id: string, within: { workspaceId: string; projectId: string }): Promise<{ workspaceId: string; projectId: string } | null>;
}

/** Apply the connection's selected-project ceiling before a canonical reader loads content. */
export function agentProjectReads(port: AgentProjectObjectPort) {
  return {
    async requireObject(context: AgentConnectionContext, workspaceId: string, projectId: string,
      kind: AgentProjectObjectKind, id: string) {
      requireAgentSelection(context, projectId, 'flux.context.read');
      const missing = () => new NotFoundError('Project object', 'OBJECT_NOT_FOUND');
      if (!isUuid(id)) throw missing();
      const scope = await port.scopeOf(kind, id, { workspaceId, projectId });
      if (!scope || scope.workspaceId !== workspaceId || scope.projectId !== projectId) throw missing();
    },
  };
}
