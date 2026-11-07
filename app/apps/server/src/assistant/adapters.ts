import { assistantSettingsRows, type AssistantAuthority, type DbExecutor, accessReader, type Transaction } from '@flux/db';
import { ConflictError, assertAuthorized, policyPersonalRunAccess, initialAgentMcpPolicy } from '@flux/core';

/** A person's agents: no grants, switches or project list; it has exactly its owner's rights (F-036 AG-3). */
export function assistantRows(tx: DbExecutor) {
  const authority: AssistantAuthority = {
    async requireWorkspace(ownerUserId, workspaceId, connection) {
      await assertAuthorized({ kind: 'human', id: ownerUserId }, 'workspace.read', { type: 'workspace', id: workspaceId }, accessReader(connection), { lock: true });
    },
    async requireAgent(ownerUserId, workspaceId, agentId, connection) {
      const allowed = await policyPersonalRunAccess(accessReader(connection)).requireInvoke({ kind: 'human', id: ownerUserId }, agentId, { lock: true });
      if (allowed.workspaceId !== workspaceId) throw new ConflictError('Choose an assistant in this company', 'ASSISTANT_WORKSPACE_MISMATCH');
    },
    initialPolicy: initialAgentMcpPolicy,
  };
  return assistantSettingsRows(tx as Transaction, authority);
}
