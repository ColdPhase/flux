import { NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import { requireAgentProject, type AgentConnectionContext } from './proposals.js';

export type AgentProjectObjectKind = 'work' | 'decision' | 'result' | 'doc' | 'material' | 'conversation' | 'sketch';
/** Metadata only. No title, body, private provenance or object existence reaches the caller. */
export interface AgentProjectObjectPort {
  scopeOf(kind: AgentProjectObjectKind, id: string, within: { workspaceId: string; projectId: string }): Promise<{ workspaceId: string; projectId: string } | null>;
}

/** Check the object lies in the project the call names before a canonical reader loads content. */
export function agentProjectReads(port: AgentProjectObjectPort) {
  return {
    async requireObject(context: AgentConnectionContext, workspaceId: string, projectId: string,
      kind: AgentProjectObjectKind, id: string) {
      requireAgentProject(context, projectId);
      const missing = () => new NotFoundError('Project object', 'OBJECT_NOT_FOUND');
      if (!isUuid(id)) throw missing();
      const scope = await port.scopeOf(kind, id, { workspaceId, projectId });
      if (!scope || scope.workspaceId !== workspaceId || scope.projectId !== projectId) throw missing();
    },
  };
}
