import { agentConnectionRepository, accessReader, type Database } from '@flux/db';
import { enforce, evaluateProject, initialAgentMcpPolicy } from '@flux/core';

/** One policy adapter for browser selection, OAuth issuance, and MCP calls. */
export function createAgentConnectionStore(db: Database) {
  return agentConnectionRepository(db, {
    initialMcpPolicy: initialAgentMcpPolicy,
    async authorizeProject(agentId, projectId, action, tx) {
      const checked = enforce(await evaluateProject({ kind: 'agent', id: agentId }, action, projectId, accessReader(tx), { lock: true }), 'project');
      return checked.project!.workspaceId;
    },
  });
}
