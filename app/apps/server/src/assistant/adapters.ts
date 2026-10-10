import { assistantSettingsRows, type AssistantAuthority, type DbExecutor } from '@flux/db';
import { ConflictError, assertAuthorized, evaluateProject, policyPersonalRunAccess, grantProject,
  initialAgentMcpPolicy, mcpPolicyAdmissionActions, mcpPolicyWithinConsent, type Transaction } from '@flux/core';
import type { TransactionEventSession } from '../work/transaction-events.js';

export function assistantRows(tx: DbExecutor, events: TransactionEventSession) {
  const authority: AssistantAuthority = {
    async requireWorkspace(ownerUserId, workspaceId, connection) {
      await assertAuthorized({ kind: 'human', id: ownerUserId }, 'workspace.read', { type: 'workspace', id: workspaceId }, connection, { lock: true });
    },
    async requireAgent(ownerUserId, workspaceId, agentId, connection) {
      const allowed = await policyPersonalRunAccess(connection).requireInvoke({ kind: 'human', id: ownerUserId }, agentId, { lock: true });
      if (allowed.workspaceId !== workspaceId) throw new ConflictError('Choose an assistant in this workspace', 'ASSISTANT_WORKSPACE_MISMATCH');
    },
    async allowsProject(principal, action, projectId, connection) {
      return (await evaluateProject(principal, action, projectId, connection, { lock: true })).allowed;
    },
    async grantProject(ownerUserId, projectId, agentId, connection) {
      await grantProject({ kind: 'human', id: ownerUserId }, projectId, { principal: { kind: 'agent', id: agentId }, role: 'contributor' }, connection, events);
    },
    identityChanged() { throw new ConflictError('This workspace already has its assistant identity; reuse that agent', 'ASSISTANT_IDENTITY_CHANGED'); },
    initialPolicy: initialAgentMcpPolicy,
    withinConsent: mcpPolicyWithinConsent,
    admissionActions: mcpPolicyAdmissionActions,
  };
  return assistantSettingsRows(tx as Transaction, authority);
}
