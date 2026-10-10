import type { AssistantJoinRequest } from './assistant.js';
import type { ExternalClientDesignation } from './agent-proposals.js';
import type { AgentOperation } from './agent-execution.js';

/**
 * The Agents view of a project (UI116-2): every current external connection
 * selected for this project, whoever owns it, with what Flux can truthfully say about it. A
 * project reader sees the connection identity and state; never grants, tokens, keys or receipts.
 */
export const projectAgentsPath = (projectId: string) => `/api/v1/projects/${projectId}/agents`;

/**
 * - `not_signed_in`: created in Flux, never authorized from a client.
 * - `offline`: authorized before, no open client session now.
 * - `session_open`: a client started a session that has not expired. It says a client connected,
 *   not that it is working; activity is shown only by `lastActivity`.
 * - `unavailable`: Flux would refuse this connection's calls now (its agent lost the access its
 *   scopes need on one of its selected projects). Only its owner can restore it.
 * `offline` and `not_signed_in` differ by whether a token was ever issued or a session ever opened;
 * choosing the connection on the consent page alone is not an authorization.
 */
export type ProjectAgentConnectionState = 'not_signed_in' | 'offline' | 'session_open' | 'unavailable';

export interface ProjectAgentConnection {
  id: string;
  /** Owner-chosen name, e.g. "Research laptop". */
  name: string;
  /** Owner-reported client label; never proof of the client or model. */
  clientDesignation: ExternalClientDesignation;
  owner: { id: string; name: string };
  agent: { id: string; name: string };
  /** True when the caller owns the connection. */
  own: boolean;
  /** One owner assistant, independent of engine; never an external client label. */
  assistant?: true;
  state: ProjectAgentConnectionState;
  /** The open session's start and end; null unless `session_open`. */
  session: { startedAt: string; expiresAt: string } | null;
  /** The connection's latest completed action in this project; lease renewals (heartbeats) are not activity. */
  lastActivity: { operation: AgentOperation; at: string } | null;
}

export interface ProjectAgents {
  projectId: string;
  connections: ProjectAgentConnection[];
  /** Pending joins visible only to current managers or the requesting owner. */
  joinRequests?: AssistantJoinRequest[];
  /** Only the reader’s own active assistant in this project’s workspace; asking grants no access. */
  assistantJoin?: { agentId: string; canRequest: boolean };
}
