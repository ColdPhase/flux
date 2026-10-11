import { agentMcpPolicyRepository } from '@flux/db';
import { enforce, evaluateProject, initialAgentMcpPolicy, mcpPolicyWithinConsent, mcpPolicyAdmissionActions, type Database } from '@flux/core';

export function createMcpPolicyStore(db: Database) {
  return agentMcpPolicyRepository(db, { initialPolicy: initialAgentMcpPolicy, withinConsent: mcpPolicyWithinConsent,
    admissionActions: mcpPolicyAdmissionActions, async authorizeProject(agentId, projectId, action, tx) {
    const checked = enforce(await evaluateProject({ kind: 'agent', id: agentId }, action, projectId, tx, { lock: true }), 'project');
    return checked.project!.workspaceId;
  } });
}
