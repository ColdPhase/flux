export type AgentScope = 'flux.context.read' | 'flux.proposal.write';

/** A person's server-owned consent selection; no model account or token is stored here. */
export interface AgentConnection {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  agentId: string;
  selectedProjectIds: string[];
  scopes: AgentScope[];
  computeSource: 'user_operated_claude_code';
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateAgentConnectionCommand {
  agentId: string;
  selectedProjectIds: string[];
  scopes: AgentScope[];
}

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
