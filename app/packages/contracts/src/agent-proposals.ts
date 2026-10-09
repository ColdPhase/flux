export type AgentScope = 'flux.context.read' | 'flux.proposal.write' | 'flux.action.execute';
export type ExternalComputeSource = 'user_operated_claude_code' | 'user_operated_external_client' | 'owner_runtime';
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

/**
 * Where an approved authorization goes: the signed request's redirect URI (#287). `loopback` is
 * 127.0.0.1, [::1] or localhost on the person's own computer; `web` is any other http(s) host;
 * `app` is a native app's private-use scheme, shown as the whole URI because it has no host.
 */
export interface AgentOauthRedirect {
  kind: 'loopback' | 'web' | 'app';
  /** Host and port of an http(s) redirect, or the whole private-use URI. */
  host: string;
}

/** Current owner-only display projection of a provider-signed authorization request. */
export interface AgentOauthConsentContext {
  /** Self-asserted by the client; never proof of who runs it. */
  clientName: string;
  /** The client_id's host when the client_id is an https URL (a Client ID Metadata Document); null for a client registered on this server. */
  clientIdHost: string | null;
  redirect: AgentOauthRedirect;
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
