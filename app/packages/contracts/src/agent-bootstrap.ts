import type { AgentOperation, AgentPeerRequestClass, AuthenticatedAgentRuntime } from './agent-execution.js';

export const AGENT_SOURCE_KINDS = ['doc', 'material', 'work', 'decision', 'conversation', 'map'] as const;
export type AgentSourceKind = typeof AGENT_SOURCE_KINDS[number];
export type AgentSourceCheckpoint =
  | { kind: 'doc' | 'material' | 'work' | 'decision'; id: string; version: number }
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
  access: 'read' | 'write';
  /** Whether the client may call it now: every tool is (Ask me first makes a change wait, it never hides it, #1419). */
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
export interface AgentCoordinationReference {
  activeClaimReference: string | null;
  checkpointReference: string | null;
  /** Opt-in recovery of existing work; no claim/lease secret or checkpoint content. */
  work?: {
    units: { id: string; taskId: string; role: 'execute' | 'review' | 'plan'; state: 'pending' | 'paused' | 'claimed';
      version: number; checkpointId: string | null;
      lease: { expiresAt: string; currentSession: boolean } | null }[];
    limit: number; offset: number; nextOffset: number | null;
    coverage: 'current_connection_open_units';
  };
}
export interface AgentBootstrap {
  contractVersion: 2;
  observedAt: string;
  runtime: AuthenticatedAgentRuntime;
  project: { id: string; workspaceId: string; name: string };
  capabilities: AgentToolCapability[];
  trusted: { playbook: AgentInstructionReference | null;
    coordination: AgentCoordinationReference | null; repositoryReferences: string[] | null };
  /** The bundle this runtime session's client acknowledged, and whether it is the one the server serves now. */
  playbookAcknowledgment: (AgentInstructionAcknowledgment & { current: boolean }) | null;
  gaps: ('trusted_playbook_unavailable' | 'coordination_unavailable' |
    'verified_repository_context_unavailable' | 'goal_plan_classification_unavailable' | 'dependency_index_unavailable')[];
  readiness: { state: 'pending' | 'ready'; meaning: 'server_context_available_only' };
  coverage: { projectIndex: 'bounded_canonical_metadata'; changesSince: 'supplied_references_only';
    /** `client_acknowledged`: the client reported loading the current bundle; the server cannot observe loading itself. */
    instructionLoading: 'unverified' | 'client_acknowledged'; modelObedience: 'unverified' };
}
