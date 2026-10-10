import { assistantSettingsRows, type AssistantAuthority, type DbExecutor } from '@flux/db';
import { ConflictError, enforce, evaluateAgent, evaluateProject, evaluateWorkspace, grantProject,
  initialAgentMcpPolicy, mcpPolicyAdmissionActions, mcpPolicyWithinConsent, type Transaction } from '@flux/core';
import type { TransactionEventSession } from '../work/transaction-events.js';

export function assistantRows(tx: DbExecutor, events: TransactionEventSession) {
  const authority: AssistantAuthority = {
    async requireWorkspace(ownerUserId, workspaceId, connection) {
      enforce(await evaluateWorkspace({ kind: 'human', id: ownerUserId }, 'workspace.read', workspaceId, connection, { lock: true }), 'workspace');
    },
    async requireAgent(ownerUserId, workspaceId, agentId, connection) {
      const allowed = enforce(await evaluateAgent({ kind: 'human', id: ownerUserId }, 'agent.invoke', agentId, connection, { lock: true }), 'agent');
      if (allowed.agent!.workspaceId !== workspaceId) throw new ConflictError('Choose an assistant in this workspace', 'ASSISTANT_WORKSPACE_MISMATCH');
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
