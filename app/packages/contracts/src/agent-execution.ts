import type { AgentScope } from './agent-proposals.js';

/** Exact operations; an adapter advertises only the ones it actually implements. */
export const AGENT_OPERATIONS = ['work.create', 'work.update', 'result.record', 'decision.propose',
  'map.create', 'map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete',
  'map.positions.update', 'map.link.create', 'map.link.delete', 'doc.create', 'doc.update', 'conversation.create', 'conversation.reply',
  'cowork.claim', 'cowork.renew', 'cowork.release', 'cowork.request', 'cowork.request.claim', 'cowork.request.respond',
  'cowork.unit.create', 'cowork.unit.complete', 'cowork.unit.transfer'] as const;
export type AgentOperation = typeof AGENT_OPERATIONS[number];
export const AGENT_PEER_REQUEST_CLASSES = ['execute', 'review', 'plan'] as const;
export type AgentPeerRequestClass = typeof AGENT_PEER_REQUEST_CLASSES[number];
/** Review authority applies only to actual review units, never native execution commands.
 * `cowork.request` reserves queued sender intent only: its class is the SENDER unit's actual role, never the
 * recipient's class or the request kind. It authorizes no receiver claim, review or execution.
 * `cowork.request.claim` / `cowork.request.respond` are the RECIPIENT's: their target and class are the recipient's
 * own unit and its actual role, under that unit's live claim. Neither is a general publication right.
 * `cowork.unit.create` targets the native TASK; its class is the role of the unit it CREATES. It gives the creator no
 * claim on that unit and the assignee no authority: the assignee still needs its own `cowork.claim` grant.
 * `cowork.unit.complete` / `cowork.unit.transfer` are the current HOLDER's: their target and class are its own unit and
 * that unit's actual role, under the unit's live claim. A transfer gives the new assignee no authority either. */
export const AGENT_OPERATION_CLASSES: Record<AgentOperation, readonly AgentPeerRequestClass[]> = {
  'work.create': ['execute', 'plan'], 'work.update': ['execute', 'plan'],
  'result.record': ['execute'], 'decision.propose': ['execute', 'plan'],
  'map.create': ['execute', 'plan'], 'map.rename': ['execute', 'plan'],
  'map.thought.create': ['execute', 'plan'], 'map.thought.update': ['execute', 'plan'],
  'map.thought.delete': ['execute', 'plan'], 'map.positions.update': ['execute', 'plan'],
  'map.link.create': ['execute', 'plan'], 'map.link.delete': ['execute', 'plan'],
  'doc.create': ['execute', 'plan'], 'doc.update': ['execute', 'plan'],
  'conversation.create': ['execute', 'plan'], 'conversation.reply': ['execute', 'plan'],
  'cowork.claim': ['execute', 'review', 'plan'], 'cowork.renew': ['execute', 'review', 'plan'], 'cowork.release': ['execute', 'review', 'plan'],
  'cowork.request': ['execute', 'review', 'plan'],
  'cowork.request.claim': ['execute', 'review', 'plan'], 'cowork.request.respond': ['execute', 'review', 'plan'],
  'cowork.unit.create': ['execute', 'review', 'plan'],
  'cowork.unit.complete': ['execute', 'review', 'plan'], 'cowork.unit.transfer': ['execute', 'review', 'plan'],
};
export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | { [key: string]: AgentJsonValue };

export interface AgentStandingGrant {
  id: string;
  workspaceId: string;
  projectId: string;
  connectionId: string;
  operation: AgentOperation;
  peerRequestClass: AgentPeerRequestClass;
  objectId: string | null;
  audience: { kind: 'project'; projectId: string };
  maximumUses: number;
  used: number;
  expiresAt: string;
  revokedAt: string | null;
  generation: number;
  createdAt: string;
}
export interface CreateAgentStandingGrantCommand {
  clientCommandId: string;
  projectId: string;
  operation: AgentOperation;
  peerRequestClass: AgentPeerRequestClass;
  objectId?: string;
  maximumUses: number;
  expiresAt: string;
}

/**
 * Narrow one live standing grant in place (#152, 2026-10-05): fewer uses and/or an earlier expiry, never more.
 * Values are absolute, so a retry is idempotent. Operation, class, project and target never change.
 */
export interface NarrowAgentStandingGrantCommand {
  /** At least the uses already made (and at least 1), at most the current limit. */
  maximumUses?: number;
  /** In the future and no later than the current expiry. */
  expiresAt?: string;
}

export const agentActionGrantsPath = (connectionId: string) => `/api/v1/agent-connections/${connectionId}/action-grants`;
export const agentActionGrantPath = (connectionId: string, grantId: string) => `${agentActionGrantsPath(connectionId)}/${grantId}`;
export interface AuthenticatedAgentRuntime {
  id: string;
  workspaceId: string;
  connectionId: string;
  ownerUserId: string;
  agentId: string;
  /** Actual AS-owned OAuth client; clientInfo and owner labels are separate. */
  clientId: string;
  grantReferenceId: string;
  bindingGeneration: number;
  scopes: AgentScope[];
  createdAt: string;
  expiresAt: string;
}

/** Postconditions are read from canonical rows, never from MCP-reported metadata. */
export type AgentPostcondition =
  | { kind: 'work' | 'decision' | 'material' | 'doc' | 'map' | 'thought'; id: string; version: number }
  | { kind: 'result'; id: string }
  /** A project message is immutable: its identity is its whole produced post-state. */
  | { kind: 'message'; id: string }
  | { kind: 'map_checkpoint'; id: string; updatedAt: string }
  | { kind: 'cowork.claim_state'; workspaceId: string; projectId: string; connectionId: string;
      unitId: string; role: AgentPeerRequestClass; version: number; generation: number;
      state: 'pending' | 'claimed' | 'paused' | 'completed' | 'stopped'; leaseId: string | null;
      leaseSessionId: string | null; leaseExpiresAt: string | null; checkpointId: string | null }
  /** Content-free request identity for the ACTING connection: for `cowork.request` the sender and its unit, for
   * `cowork.request.claim`/`.respond` the recipient and its unit; `role` is that unit's actual class. */
  | { kind: 'cowork.request_state'; workspaceId: string; projectId: string; connectionId: string;
      unitId: string; requestId: string; role: AgentPeerRequestClass; version: number;
      state: 'queued' | 'deferred' | 'claimed' | 'resolved' | 'declined' | 'superseded' | 'expired' | 'cancelled' }
  /** A unit created by `cowork.unit.create`: its task (the command target), canonical lineage/run, actual role (the
   * class) and assignment, which may be another connection; the receipt itself records the creating connection.
   * Also the unit a holder completed or transferred (`cowork.unit.complete`/`.transfer`; the unit is the target). */
  | { kind: 'cowork.unit_state'; workspaceId: string; projectId: string; unitId: string; taskId: string;
      lineageTaskId: string; runId: string; role: AgentPeerRequestClass; assignmentConnectionId: string; version: number;
      state: 'pending' | 'claimed' | 'paused' | 'completed' | 'stopped' };

export interface AgentExecutionCommand {
  runtimeSessionId: string;
  grantId: string;
  clientCommandId: string;
  projectId: string;
  operation: AgentOperation;
  peerRequestClass: AgentPeerRequestClass;
  audience: { kind: 'project'; projectId: string };
  objectId: string | null;
  sources: { materialId: string; version: number }[];
  payload: AgentJsonValue;
}
export interface AgentCommandReceipt {
  clientCommandId: string;
  runtimeSessionId: string;
  operation: AgentOperation;
  projectId: string;
  value: AgentJsonValue;
  postconditions: AgentPostcondition[];
  completedAt: string;
}
