import { agentConnectionRepository } from '@flux/db';
import { enforce, evaluateProject, type Database } from '@flux/core';

/** One policy adapter for browser selection, OAuth issuance, and MCP calls. */
export function createAgentConnectionStore(db: Database) {
  return agentConnectionRepository(db, {
    async authorizeProject(agentId, projectId, action, tx) {
      const checked = enforce(await evaluateProject({ kind: 'agent', id: agentId }, action, projectId, tx, { lock: true }), 'project');
      return checked.project!.workspaceId;
    },
  });
}
