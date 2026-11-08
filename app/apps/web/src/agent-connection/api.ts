import {
  AGENT_CONNECTIONS_PATH, AGENT_OAUTH_CONSENT_CONTEXT_PATH, AUTH_OAUTH2_CONSENT_PATH, agentConnectionPath, workspaceAgentsPath,
  type Agent, type AgentConnection, type AgentMayDo, type CreateAgentCommand, type AgentOauthConsentContext, type UpdateAgentConnectionCommand,
} from '@flux/contracts';
import { request } from '../api/client';

export type ConsentContext = AgentOauthConsentContext;

export function listAgentConnections(signal?: AbortSignal) {
  return request<AgentConnection[]>(AGENT_CONNECTIONS_PATH, { signal });
}

/** Disconnect: the client's access stops at once, and what it had waiting for your OK is dropped. */
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

/** The server checks Better Auth's signed OAuth query before returning display data. */
export function getConsentContext(oauthQuery: string, signal?: AbortSignal) {
  return request<ConsentContext>(`${AGENT_OAUTH_CONSENT_CONTEXT_PATH}?oauth_query=${encodeURIComponent(oauthQuery)}`, { signal });
}

interface OAuthRedirect { url?: string; redirect_uri?: string }

/** The one decision (#859): Allow makes the client's connection if it has none, Deny makes nothing. */
export async function decideAgentConsent(accept: boolean, oauthQuery: string) {
  return request<OAuthRedirect>(AUTH_OAUTH2_CONSENT_PATH, { method: 'POST', body: { accept, oauth_query: oauthQuery } });
}

export function followOAuthRedirect(result: OAuthRedirect) {
  const target = result.url ?? result.redirect_uri;
  if (!target) throw new Error('Flux did not return the next authorization step. Please try connecting again.');
  // Better Auth issues this destination after validating the registered client and signed flow.
  window.location.assign(target);
}
