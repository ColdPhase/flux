export type AgentScope = 'flux.context.read' | 'flux.proposal.write' | 'flux.action.execute';
export type ExternalComputeSource = 'user_operated_claude_code' | 'user_operated_external_client' | 'owner_assistant';
export type ExternalClientDesignation = 'claude_code' | 'codex' | 'other';

/**
 * "What it may do" (F-036 AG-3, #855): the one permission row of each agent, the assistant and every local client alike.
 * Whatever it says, an agent has exactly its owner's rights, and deleting or changing other people's things always waits.
 */
export const AGENT_MAY_DO = ['read', 'act', 'ask'] as const;
export type AgentMayDo = typeof AGENT_MAY_DO[number];
export const AGENT_MAY_DO_LABELS: Readonly<Record<AgentMayDo, string>> = { read: 'Only read', act: 'Do it and tell me', ask: 'Ask me first' };
export const AGENT_MAY_DO_HINTS: Readonly<Record<AgentMayDo, string>> = {
  read: 'Reads and answers. It changes nothing.',
  act: 'Makes new things and changes yours at once, then tells you, with Undo.',
  ask: 'Every change waits for your OK.',
};
/** The line under every "What it may do" row. */
export const AGENT_ALWAYS_WAITS = 'Agents never have more rights than you. Deleting and other people\'s things always wait for your OK.';
/** `PATCH`: the owner, in their own signed-in session, sets one agent's "What it may do". No agent or client can. */
export interface UpdateAgentConnectionCommand { mayDo: AgentMayDo }

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
  /** "What it may do" (F-036 AG-3). */
  mayDo: AgentMayDo;
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
  /** What approval grants: the client's request narrowed to this connection's permissions (partial consent, #548). */
  scopes: string[];
  /** Requested by the client but not part of this connection; approval leaves these out. */
  notGranted: string[];
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
