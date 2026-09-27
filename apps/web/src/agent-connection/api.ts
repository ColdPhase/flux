import {
  AUTH_BASE_PATH, type AgentConnection, type AgentScope,
  type CreateAgentConnectionCommand,
} from '@flux/contracts';
import { request } from '../api/client';

const CONNECTIONS_PATH = '/api/v1/agent-connections';

export interface ConsentContext {
  clientName: string;
  scopes: string[];
  connection: AgentConnection;
  agentName?: string;
  selectedProjects?: { id: string; name: string }[];
}

export const SCOPE_LABELS: Record<AgentScope, { title: string; description: string }> = {
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
  return request<AgentConnection[]>(CONNECTIONS_PATH, { signal });
}

export function createAgentConnection(command: CreateAgentConnectionCommand) {
  return request<AgentConnection>(CONNECTIONS_PATH, { method: 'POST', body: command });
}

export function selectAgentConnection(connectionId: string) {
  return request<null>(`${CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}/select-for-oauth`, { method: 'POST' });
}

/** The server checks Better Auth's signed OAuth query before returning display data. */
export function getConsentContext(oauthQuery: string, signal?: AbortSignal) {
  return request<ConsentContext>(`/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(oauthQuery)}`, { signal });
}

interface OAuthRedirect { url?: string; redirect_uri?: string }

export async function continueAgentOAuth(oauthQuery: string) {
  return request<OAuthRedirect>(`${AUTH_BASE_PATH}/oauth2/continue`, {
    method: 'POST', body: { postLogin: true, oauth_query: oauthQuery },
  });
}

export async function decideAgentConsent(accept: boolean, oauthQuery: string) {
  return request<OAuthRedirect>(`${AUTH_BASE_PATH}/oauth2/consent`, {
    method: 'POST', body: { accept, oauth_query: oauthQuery },
  });
}

export function followOAuthRedirect(result: OAuthRedirect) {
  const target = result.url ?? result.redirect_uri;
  if (!target) throw new Error('Flux did not return the next authorization step. Please try connecting again.');
  // Better Auth issues this destination after validating the registered client and signed flow.
  window.location.assign(target);
}
