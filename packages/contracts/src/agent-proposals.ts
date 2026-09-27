/** An agent suggestion stays separate from published project material and human decisions. */
export interface AgentProposal {
  id: string;
  projectId: string;
  audience: { kind: 'project'; projectId: string };
  agentId: string;
  ownerUserId: string;
  /** Immutable provenance; no provider credential or usage is stored. */
  computeSource: 'user_operated_claude_code';
  agentGrant: { id: string; role: 'contributor' };
  source: { materialId: string; version: number };
  fact: string;
  interpretation: string;
  suggestedAction: string;
  status: 'proposed' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentProposalCommand {
  projectId: string;
  source: { materialId: string; version: number };
  clientCommandId: string;
  fact: string;
  interpretation: string;
  suggestedAction: string;
}
