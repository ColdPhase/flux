export type AgentScope = 'flux.context.read' | 'flux.proposal.write';
export type ExternalComputeSource = 'user_operated_claude_code' | 'user_operated_external_client';
export type ExternalClientDesignation = 'claude_code' | 'codex' | 'other';

/** A person's server-owned consent selection; no model account or token is stored here. */
export interface AgentConnection {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  agentId: string;
  name: string;
  /** Owner-reported description; never proof of client or model identity. */
  clientDesignation: ExternalClientDesignation;
  selectedProjectIds: string[];
  scopes: AgentScope[];
  computeSource: ExternalComputeSource;
  revokedAt: string | null;
  createdAt: string;
}

/** Current owner-only display projection of a provider-signed authorization request. */
export interface AgentOauthConsentContext {
  clientName: string;
  scopes: string[];
  connection: AgentConnection;
  agentName: string;
  selectedProjects: { id: string; name: string }[];
}

export interface CreateAgentConnectionCommand {
  agentId: string;
  selectedProjectIds: string[];
  scopes: AgentScope[];
  name?: string;
  clientDesignation?: ExternalClientDesignation;
}

/** An agent suggestion stays separate from published project material and human decisions. */
export interface AgentProposal {
  id: string;
  projectId: string;
  audience: { kind: 'project'; projectId: string };
  agentId: string;
  ownerUserId: string;
  /** Immutable provenance; no provider credential or usage is stored. */
  computeSource: ExternalComputeSource;
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
