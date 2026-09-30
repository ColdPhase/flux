import type { AgentScope } from './agent-proposals.js';

/** Exact operations; an adapter advertises only the ones it actually implements. */
export const AGENT_OPERATIONS = ['work.create', 'work.update', 'result.record', 'decision.propose',
  'map.create', 'map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete',
  'map.positions.update', 'map.link.create', 'map.link.delete', 'cowork.claim', 'cowork.renew', 'cowork.release'] as const;
export type AgentOperation = typeof AGENT_OPERATIONS[number];
export const AGENT_PEER_REQUEST_CLASSES = ['execute', 'review', 'plan'] as const;
export type AgentPeerRequestClass = typeof AGENT_PEER_REQUEST_CLASSES[number];
/** Review authority applies only to actual review units, never native execution commands. */
export const AGENT_OPERATION_CLASSES: Record<AgentOperation, readonly AgentPeerRequestClass[]> = {
  'work.create': ['execute', 'plan'], 'work.update': ['execute', 'plan'],
  'result.record': ['execute'], 'decision.propose': ['execute', 'plan'],
  'map.create': ['execute', 'plan'], 'map.rename': ['execute', 'plan'],
  'map.thought.create': ['execute', 'plan'], 'map.thought.update': ['execute', 'plan'],
  'map.thought.delete': ['execute', 'plan'], 'map.positions.update': ['execute', 'plan'],
  'map.link.create': ['execute', 'plan'], 'map.link.delete': ['execute', 'plan'],
  'cowork.claim': ['execute', 'review', 'plan'], 'cowork.renew': ['execute', 'review', 'plan'], 'cowork.release': ['execute', 'review', 'plan'],
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
  | { kind: 'work' | 'decision' | 'material' | 'map' | 'thought'; id: string; version: number }
  | { kind: 'result'; id: string }
  | { kind: 'map_checkpoint'; id: string; updatedAt: string }
  | { kind: 'cowork.claim_state'; workspaceId: string; projectId: string; connectionId: string;
      unitId: string; role: AgentPeerRequestClass; version: number; generation: number;
      state: 'pending' | 'claimed' | 'paused' | 'completed' | 'stopped'; leaseId: string | null;
      leaseSessionId: string | null; leaseExpiresAt: string | null; checkpointId: string | null };

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
