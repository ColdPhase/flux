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
/** What a client reported loading for this runtime session: compatibility evidence, never authority or obedience. */
export interface AgentInstructionAcknowledgment {
  bundleId: string;
  version: string;
  digest: string;
  acknowledgedAt: string;
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
  /** The bundle this runtime session's client acknowledged, and whether it is the one the server serves now. */
  playbookAcknowledgment: (AgentInstructionAcknowledgment & { current: boolean }) | null;
  gaps: ('trusted_playbook_unavailable' | 'approved_policy_unavailable' | 'coordination_unavailable' |
    'verified_repository_context_unavailable' | 'goal_plan_classification_unavailable' | 'dependency_index_unavailable')[];
  readiness: { state: 'pending' | 'ready'; meaning: 'server_context_available_only' };
  coverage: { projectIndex: 'bounded_canonical_metadata'; changesSince: 'supplied_references_only';
    /** `client_acknowledged`: the client reported loading the current bundle; the server cannot observe loading itself. */
    instructionLoading: 'unverified' | 'client_acknowledged'; modelObedience: 'unverified' };
}

/** Bounds of an approved project policy (#160, CW-1): four plain-text fields, each at most this long. */
export const AGENT_POLICY_LIMITS = { fieldCharacters: 4000 } as const;
/** `GET` the current policy (project readers), `PUT` a new revision (project managers). */
export const agentProjectPolicyPath = (projectId: string) => `/api/v1/projects/${projectId}/agent-policy`;
/** The MCP resource of one stored revision; bootstrap's `approvedPolicy.retrievalReference`. */
export const agentProjectPolicyUri = (projectId: string, revision: number) => `flux://policy/${projectId}/${revision}`;

/**
 * The approved project policy for connected agents (#160, F-018 CW-1). Only a project manager's
 * publish changes it. It narrows work inside each owner's grants and never grants anything.
 */
export interface AgentProjectPolicy {
  projectId: string;
  revision: number;
  /** What agents may work on in this project. */
  scope: string;
  priorities: string;
  /** What a review of an agent's work checks. */
  reviewCriteria: string;
  /** Kinds of work agents may take on (and, by omission, may not). */
  allowedWork: string;
  /** `sha256:` of the canonical policy content; bootstrap returns the same digest. */
  digest: string;
  publishedAt: string;
  publishedBy: { id: string; name: string | null };
}

/** Publishes the next revision; `expectedRevision` is the revision the manager saw (0 when none). */
export interface PublishAgentProjectPolicyCommand {
  scope: string;
  priorities: string;
  reviewCriteria: string;
  allowedWork: string;
  expectedRevision: number;
}
