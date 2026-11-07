import {
  AGENT_CONNECTIONS_PATH, AGENT_OAUTH_CONSENT_CONTEXT_PATH, AGENT_OAUTH_HELD_CONNECTION_PATH, AUTH_OAUTH2_CONSENT_PATH, AUTH_OAUTH2_CONTINUE_PATH,
  agentConnectionPath, agentConnectionSelectPath, agentMcpPolicyPath, workspaceAgentsPath, type Agent, type AgentConnection,
  type AgentMcpEntry, type AgentMcpPolicy, type SaveAgentMcpPolicy, type AgentConnectionSetupFacts,
  type AgentScope, type AgentOauthConsentContext, type CreateAgentCommand, type CreateAgentConnectionCommand,
  type AgentMayDo, type ExternalClientDesignation, type UpdateAgentConnectionCommand,
} from '@flux/contracts';
import { request } from '../api/client';

export interface McpPermissionSettings {
  connection: AgentConnection;
  policy: AgentMcpPolicy;
  projects: { id: string; selected: boolean; readable: boolean; writable: boolean }[];
  entries: (AgentMcpEntry & { configured: boolean; available: boolean; reason: string | null })[];
  setup: AgentConnectionSetupFacts;
}

export function getMcpPermissions(connectionId: string, signal?: AbortSignal) {
  return request<McpPermissionSettings>(agentMcpPolicyPath(encodeURIComponent(connectionId)), { signal });
}

export function saveMcpPermissions(connectionId: string, version: number, input: SaveAgentMcpPolicy, signal?: AbortSignal) {
  return request<{ policy: AgentMcpPolicy }>(agentMcpPolicyPath(encodeURIComponent(connectionId)), {
    method: 'PATCH', headers: { 'if-match': `"mcp-policy-${version}"` }, body: input, signal,
  });
}

export type ConsentContext = AgentOauthConsentContext;

export const SCOPE_LABELS: Record<AgentScope, { title: string; description: string }> = {
  'flux.action.execute': {
    title: 'Run approved project actions',
    description: 'Deleting and other people’s things wait for your OK, and so does everything if you choose Ask me first.',
  },
  'flux.context.read': {
    title: 'Read selected project context',
    description: 'See project materials and their current revisions.',
  },
  'flux.proposal.write': {
    title: 'Suggest a next step',
    description: 'Create sourced proposals for you and your team to review.',
  },
};

export function listAgentConnections(signal?: AbortSignal) {
  return request<AgentConnection[]>(AGENT_CONNECTIONS_PATH, { signal });
}

export function createAgentConnection(command: CreateAgentConnectionCommand) {
  return request<AgentConnection>(AGENT_CONNECTIONS_PATH, { method: 'POST', body: command });
}

export function revokeAgentConnection(connectionId: string) {
  return request<null>(agentConnectionPath(encodeURIComponent(connectionId)), { method: 'DELETE' });
}

export function createPersonalAgent(workspaceId: string, name: string) {
  const body: CreateAgentCommand = { name, owner: 'self' };
  return request<Agent>(workspaceAgentsPath(workspaceId), { method: 'POST', body });
}

/** "What it may do" (F-036 AG-3): the owner sets it in their own session; the answer is the connection as saved. */
export function setAgentMayDo(connectionId: string, mayDo: AgentMayDo) {
  const body: UpdateAgentConnectionCommand = { mayDo };
  return request<AgentConnection>(agentConnectionPath(encodeURIComponent(connectionId)), { method: 'PATCH', body });
}

export function selectAgentConnection(connectionId: string, oauthQuery: string) {
  return request<null>(agentConnectionSelectPath(encodeURIComponent(connectionId)), { method: 'POST', body: { oauth_query: oauthQuery } });
}

/** The server checks Better Auth's signed OAuth query before returning display data. */
export function getConsentContext(oauthQuery: string, signal?: AbortSignal) {
  return request<ConsentContext>(`${AGENT_OAUTH_CONSENT_CONTEXT_PATH}?oauth_query=${encodeURIComponent(oauthQuery)}`, { signal });
}

/** The held connection and the client label its own name suggests (#763 AG-6). A failure only means no preselection. */
export async function getOauthRequester(oauthQuery: string, signal?: AbortSignal): Promise<{ connectionId: string | null; clientDesignation: ExternalClientDesignation | null }> {
  try {
    const held = await request<{ connectionId: string | null; clientDesignation?: ExternalClientDesignation | null }>(`${AGENT_OAUTH_HELD_CONNECTION_PATH}?oauth_query=${encodeURIComponent(oauthQuery)}`, { signal });
    return { connectionId: held.connectionId, clientDesignation: held.clientDesignation ?? null };
  } catch { return { connectionId: null, clientDesignation: null }; }
}

interface OAuthRedirect { url?: string; redirect_uri?: string }

export async function continueAgentOAuth(oauthQuery: string) {
  return request<OAuthRedirect>(AUTH_OAUTH2_CONTINUE_PATH, {
    method: 'POST', body: { postLogin: true, oauth_query: oauthQuery },
  });
}

/** Approval names exactly the granted scopes, so the token carries no more than the connection allows (#548). */
export async function decideAgentConsent(accept: boolean, oauthQuery: string, scopes?: readonly string[]) {
  return request<OAuthRedirect>(AUTH_OAUTH2_CONSENT_PATH, {
    method: 'POST', body: { accept, oauth_query: oauthQuery, ...(accept && scopes?.length ? { scope: scopes.join(' ') } : {}) },
  });
}

export function followOAuthRedirect(result: OAuthRedirect) {
  const target = result.url ?? result.redirect_uri;
  if (!target) throw new Error('Flux did not return the next authorization step. Please try connecting again.');
  // Better Auth issues this destination after validating the registered client and signed flow.
  window.location.assign(target);
}
