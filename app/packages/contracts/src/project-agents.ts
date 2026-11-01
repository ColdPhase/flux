import type { AssistantJoinRequest } from './assistant.js';
import type { AgentScope, ExternalClientDesignation } from './agent-proposals.js';
import type { AgentOperation } from './agent-execution.js';
import type { CoWorkRequestKind, CoWorkRequestState } from './cowork.js';

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

/** One action of an agent in a project (CW-8) and the object it touched; the reader's app names and links the object. */
export interface ProjectAgentActivity {
  operation: AgentOperation;
  at: string;
  object: { kind: 'work' | 'decision' | 'result' | 'doc' | 'map' | 'thought' | 'message'; id: string } | null;
}

export interface ProjectAgentConnection {
  id: string;
  /** Owner-chosen name, e.g. "Research laptop". */
  name: string;
  /** Owner-reported client label; never proof of the client or model. */
  clientDesignation: ExternalClientDesignation;
  /** What the owner let this connection do: the exact scopes its tokens carry (#548). */
  scopes: AgentScope[];
  owner: { id: string; name: string };
  agent: { id: string; name: string };
  /** True when the caller owns the connection. */
  own: boolean;
  /** Own assistant only: available to its owner’s hand-off/settings, never a project Agents list row (#522). */
  assistant?: true;
  state: ProjectAgentConnectionState;
  /** The open session's start and end; null unless `session_open`. */
  session: { startedAt: string; expiresAt: string } | null;
  /** The connection's latest completed action in this project; lease renewals (heartbeats) are not activity. */
  lastActivity: { operation: AgentOperation; at: string } | null;
  /** CW-8: its latest actions here (at most 6, newest first), each with the object it made or changed when there is one. */
  recentActivity?: ProjectAgentActivity[];
  /** The task unit this connection holds in this project now; null when it holds none. */
  currentWork: { taskId: string; taskTitle: string; role: 'execute' | 'review' | 'plan'; state: 'pending' | 'claimed' | 'paused';
    /** Expiry only when the claimed lease matches this connection's current usable session and project ceiling. */
    liveClaimExpiresAt: string | null } | null;
  /** Requests addressed to this connection that are still open here (#160 AC-5), oldest first. Quiet acknowledgments are not listed. */
  requests: ProjectAgentRequest[];
}

/** One open request in the Agents view: who asked, what for, its task and why it waits. Its content stays in its source. */
export interface ProjectAgentRequest {
  id: string;
  kind: CoWorkRequestKind;
  state: Extract<CoWorkRequestState, 'queued' | 'deferred' | 'claimed'>;
  reason: string | null;
  taskId: string;
  taskTitle: string;
  sender: { connectionId: string; name: string; ownerName: string };
}

export interface ProjectAgents {
  projectId: string;
  connections: ProjectAgentConnection[];
  /** The requesting owner’s pending joins for their assistant settings; managers review explicit requests in Inbox (#522). */
  joinRequests?: AssistantJoinRequest[];
  /** Only the reader’s own active assistant in this project’s workspace; asking grants no access. */
  assistantJoin?: { agentId: string; canRequest: boolean };
}
