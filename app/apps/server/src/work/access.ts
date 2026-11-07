import type { DbExecutor } from '@flux/db';
import { assertAuthorized, authorize, enforce, evaluateProject, type WorkAccess } from '@flux/core';
import { agentTaskRows, spaceAi, accessReader } from '@flux/db';

/** Project access through the single policy choke point. */
export function policyWorkAccess(tx: DbExecutor): WorkAccess {
  return {
    async requireProject(principal, action, projectId, options) {
      const checked = enforce(await evaluateProject(principal,
        action === 'write' ? 'project.write' : 'project.read', projectId, accessReader(tx), options), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    requireWorkspace: (principal, workspaceId) => assertAuthorized(principal,
      'workspace.read', { type: 'workspace', id: workspaceId }, accessReader(tx)),
    async canRead(candidate, projectId) {
      return (await authorize(candidate, 'project.read', { type: 'project', id: projectId }, accessReader(tx))).allowed;
    },
    async aiAllowed(projectId) {
      return (await spaceAi(tx, projectId, { lock: true })).state === 'allowed';
    },
    /**
     * #904 (AG-5): a task is given to your own agent, never to someone else's; an agent acts for its owner, so it reaches its owner's
     * agents. (The Owner field offers your agents that run on the server; a local client is not offered there, LC-3.)
     */
    async ownsAgent(principal, agentId) {
      const rows = agentTaskRows(tx);
      const owner = principal.kind === 'human' ? principal.id : (await rows.agent(principal.id))?.ownerUserId;
      const target = await rows.agent(agentId);
      return !!owner && !!target && !target.revokedAt && target.ownerUserId === owner;
    },
  };
}
