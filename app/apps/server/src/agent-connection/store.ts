import { agentConnectionRepository, accessReader, type Database } from '@flux/db';
import { enforce, evaluateProject, initialAgentMcpPolicy, requireSpaceAi } from '@flux/core';

/** One policy adapter for browser selection, OAuth issuance, and MCP calls. */
export function createAgentConnectionStore(db: Database) {
  return agentConnectionRepository(db, {
    initialMcpPolicy: initialAgentMcpPolicy,
    async authorizeProject(agentId, projectId, action, tx, options) {
      const reader = accessReader(tx);
      // AG-10: an agent is not connected to a space whose AI is off. A connection it already has does not become unavailable when one
      // of its spaces turns AI off (real clients drop their sign-in on a refusal of the whole connection): each tool call that names
      // the space is refused with `SPACE_AI_OFF` instead, and the agent's level there is none.
      if (options?.selecting) await requireSpaceAi(reader, projectId, { lock: true });
      else if ((await reader.spaceAi(projectId, { lock: true })).state !== 'allowed') {
        const located = await reader.locateProject(projectId);
        if (located) return located.workspaceId;
      }
      const checked = enforce(await evaluateProject({ kind: 'agent', id: agentId }, action, projectId, reader, { lock: true }), 'project');
      return checked.project!.workspaceId;
    },
  });
}
