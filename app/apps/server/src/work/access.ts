import type { DbExecutor } from '@flux/db';
import { assertAuthorized, authorize, enforce, evaluateProject, type WorkAccess } from '@flux/core';

/** Project access through the single policy choke point. */
export function policyWorkAccess(tx: DbExecutor): WorkAccess {
  return {
    async requireProject(principal, action, projectId, options) {
      const checked = enforce(await evaluateProject(principal,
        action === 'write' ? 'project.write' : 'project.read', projectId, tx, options), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    requireWorkspace: (principal, workspaceId) => assertAuthorized(principal,
      'workspace.read', { type: 'workspace', id: workspaceId }, tx),
    async canRead(candidate, projectId) {
      return (await authorize(candidate, 'project.read', { type: 'project', id: projectId }, tx)).allowed;
    },
  };
}
