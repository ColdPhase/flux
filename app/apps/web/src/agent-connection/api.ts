import {
  AUTH_BASE_PATH, agentActionGrantPath, agentActionGrantsPath, agentMcpPolicyPath, projectGrantsPath, workspaceAgentsPath, type Agent, type AgentConnection,
  type AgentMcpEntry, type AgentMcpPolicy, type SaveAgentMcpPolicy,
  type AgentScope, type AgentOauthConsentContext, type AgentStandingGrant, type CreateAgentCommand, type CreateAgentConnectionCommand,
  type CreateAgentStandingGrantCommand, type GrantProjectCommand, type NarrowAgentStandingGrantCommand, type Page, type ProjectGrant,
} from '@flux/contracts';
import { request } from '../api/client';

const CONNECTIONS_PATH = '/api/v1/agent-connections';

export interface McpPermissionSettings {
  connection: AgentConnection;
  policy: AgentMcpPolicy;
  projects: { id: string; selected: boolean; readable: boolean; writable: boolean }[];
  entries: (AgentMcpEntry & { configured: boolean; available: boolean; reason: string | null })[];
}

export function getMcpPermissions(connectionId: string, signal?: AbortSignal) {
  return request<McpPermissionSettings>(agentMcpPolicyPath(encodeURIComponent(connectionId)), { signal });
}

export function saveMcpPermissions(connectionId: string, version: number, input: SaveAgentMcpPolicy) {
  return request<{ policy: AgentMcpPolicy }>(agentMcpPolicyPath(encodeURIComponent(connectionId)), {
    method: 'PATCH', headers: { 'if-match': `"mcp-policy-${version}"` }, body: input,
  });
}

export type ConsentContext = AgentOauthConsentContext;

export const SCOPE_LABELS: Record<AgentScope, { title: string; description: string }> = {
  'flux.action.execute': {
    title: 'Run approved project actions',
    description: 'Each action also needs a current grant from you, with its own limits and expiry.',
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
  return request<AgentConnection[]>(CONNECTIONS_PATH, { signal });
}

export function createAgentConnection(command: CreateAgentConnectionCommand) {
  return request<AgentConnection>(CONNECTIONS_PATH, { method: 'POST', body: command });
}

export function revokeAgentConnection(connectionId: string) {
  return request<null>(`${CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
}

/**
 * Every standing grant of one of your connections, newest first: current ones and their history. The server
 * pages by 50; a connection rarely has more than a few pages, and the reading stops at 10 (500 grants).
 */
export async function listActionGrants(connectionId: string, signal?: AbortSignal) {
  const grants: AgentStandingGrant[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await request<Page<AgentStandingGrant>>(`${agentActionGrantsPath(encodeURIComponent(connectionId))}?limit=50&offset=${offset}`, { signal });
    grants.push(...page.items);
    if (offset + page.items.length >= page.total || page.items.length === 0) break;
  }
  return grants;
}

export function createActionGrant(connectionId: string, command: CreateAgentStandingGrantCommand) {
  return request<AgentStandingGrant>(agentActionGrantsPath(encodeURIComponent(connectionId)), { method: 'POST', body: command });
}

export function narrowActionGrant(connectionId: string, grantId: string, command: NarrowAgentStandingGrantCommand) {
  return request<AgentStandingGrant>(agentActionGrantPath(encodeURIComponent(connectionId), encodeURIComponent(grantId)), { method: 'PATCH', body: command });
}

export function revokeActionGrant(connectionId: string, grantId: string) {
  return request<null>(agentActionGrantPath(encodeURIComponent(connectionId), encodeURIComponent(grantId)), { method: 'DELETE' });
}

export function createPersonalAgent(workspaceId: string, name: string) {
  const body: CreateAgentCommand = { name, owner: 'self' };
  return request<Agent>(workspaceAgentsPath(workspaceId), { method: 'POST', body });
}

export function listProjectGrants(projectId: string, signal?: AbortSignal) {
  return request<ProjectGrant[]>(projectGrantsPath(projectId), { signal });
}

export function grantAgentProject(projectId: string, agentId: string, role: 'viewer' | 'contributor') {
  const body: GrantProjectCommand = { principal: { kind: 'agent', id: agentId }, role };
  return request<ProjectGrant>(projectGrantsPath(projectId), { method: 'POST', body });
}

export function selectAgentConnection(connectionId: string, oauthQuery: string) {
  return request<null>(`${CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}/select-for-oauth`, { method: 'POST', body: { oauth_query: oauthQuery } });
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
