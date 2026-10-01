import type { AgentScope } from './agent-proposals.js';
import type { AgentOperation, AgentPeerRequestClass, AgentStandingGrant, AuthenticatedAgentRuntime } from './agent-execution.js';

export const AGENT_SOURCE_KINDS = ['doc', 'material', 'work', 'decision', 'result', 'conversation', 'map'] as const;
export type AgentSourceKind = typeof AGENT_SOURCE_KINDS[number];
export type AgentSourceCheckpoint =
  | { kind: 'doc' | 'material' | 'work' | 'decision'; id: string; version: number }
  | { kind: 'result'; id: string }
  | { kind: 'conversation'; id: string; sequence: number }
  | { kind: 'map'; id: string; version: number; updatedAt: string };
export interface AgentSourceReference {
  workspaceId: string;
  projectId: string;
  checkpoint: AgentSourceCheckpoint;
  /** A bounded canonical label. No full body or private draft provenance. */
  title: string;
  state: string | null;
}
export interface AgentSourcePage {
  projectId: string;
  kind: AgentSourceKind;
  items: AgentSourceReference[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  coverage: 'canonical_metadata_page';
}
export interface AgentSourceChanges {
  projectId: string;
  changed: AgentSourceReference[];
  unchanged: { kind: AgentSourceKind; id: string }[];
  /** Missing, foreign and inaccessible inputs have the same content-free outcome. */
  unavailable: { kind: AgentSourceKind; id: string }[];
  coverage: 'supplied_references_only';
  newObjectDiscovery: 'use_project_orientation';
}
export interface AgentToolCapability {
  name: string;
  title: string;
  requiredScope: AgentScope;
  available: boolean;
  operation: AgentOperation | null;
  classes: readonly AgentPeerRequestClass[];
}
export interface AgentInstructionReference {
  bundleId: string;
  version: string;
  digest: string;
  toolContractVersion: number;
  retrievalReference: string;
}
export interface AgentPolicyReference {
  policyId: string;
  revision: number;
  digest: string;
  retrievalReference: string;
}
export interface AgentCoordinationReference {
  activeClaimReference: string | null;
  checkpointReference: string | null;
  inboxContinuation: string | null;
}
export interface AgentBootstrap {
  contractVersion: 1;
  observedAt: string;
  runtime: AuthenticatedAgentRuntime;
  project: { id: string; workspaceId: string; name: string };
  grants: { items: (AgentStandingGrant & { remainingUses: number })[]; total: number; limit: number; offset: number; nextOffset: number | null };
  capabilities: AgentToolCapability[];
  trusted: { playbook: AgentInstructionReference | null; approvedPolicy: AgentPolicyReference | null;
    coordination: AgentCoordinationReference | null; repositoryReferences: string[] | null };
  gaps: ('trusted_playbook_unavailable' | 'approved_policy_unavailable' | 'coordination_unavailable' |
    'verified_repository_context_unavailable' | 'goal_plan_classification_unavailable' | 'dependency_index_unavailable')[];
  readiness: { state: 'pending' | 'ready'; meaning: 'server_context_available_only' };
  coverage: { projectIndex: 'bounded_canonical_metadata'; changesSince: 'supplied_references_only';
    instructionLoading: 'unverified'; modelObedience: 'unverified' };
}
