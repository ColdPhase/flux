import type { ProactiveComparisonProposal } from './background-compute.js';

/** Metadata of a source actually inspected by a comparison; never its body. */
export interface InspectedComparisonSource {
  type: 'result' | 'message' | 'material' | 'work' | 'thought';
  id: string;
  version: number;
  title: string;
  conversationId?: string;
  sketchId?: string;
  excerpted?: boolean;
  originalCharacters?: number;
}

export interface InsufficientComparisonOutcome {
  kind: 'insufficient_evidence';
  id: string;
  projectId: string;
  resultId: string;
  ownerUserId: string;
  agentId: string;
  reason: string;
  inspectedSources: InspectedComparisonSource[];
  /** References the current reader cannot open are omitted, including their titles. */
  unavailableSourcesCount: number;
  status: 'open' | 'dismissed';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ProactiveComparisonOutcome =
  | {
    kind: 'comparison';
    proposal: ProactiveComparisonProposal;
    /** Null for legacy proposals whose complete inspected vector was not recorded. */
    inspectedSources: InspectedComparisonSource[] | null;
    unavailableSourcesCount: number;
  }
  | InsufficientComparisonOutcome;

/** Owner-private accounting. Amounts are local estimates, not a provider invoice. */
export interface BackgroundComputeCandidateUsage {
  id: string;
  projectId: string;
  resultId: string;
  ruleId: string;
  status: 'queued' | 'reserved' | 'not_run' | 'unknown' | 'completed';
  reason: string | null;
  createdAt: string;
  reservedAt: string | null;
  /** Persisted dispatch intent; not proof of adapter entry, sending or charging. Null also covers legacy unknown metadata. */
  startedAt: string | null;
  finishedAt: string | null;
  reservedCents: number;
  observedUsage: { inputTokens: number; outputTokens: number; estimatedCents: number } | null;
}

export interface BackgroundComputeUsage {
  asOf: string;
  utcDayStartsAt: string;
  rollingPeriodStartsAt: string;
  /** Conservative count of persisted dispatch intents in the UTC day. */
  startedRequestsToday: number;
  conservativeCountedCents: number;
  observedEstimatedCents: number;
  unknownPossibleCents: number;
  inFlightCents: number;
  currentLimits: { maxRunsPerDay: number; periodDays: 30; periodBudgetCents: number; perRunCents: number } | null;
  candidates: BackgroundComputeCandidateUsage[];
}

export const proactiveComparisonOutcomesPath = (projectId: string) =>
  `/api/v1/projects/${projectId}/proactive-comparison-outcomes`;
export const proactiveComparisonOutcomePath = (outcomeId: string) =>
  `/api/v1/proactive-comparison-outcomes/${outcomeId}`;
export const backgroundComputeUsagePath = '/api/v1/background-compute-usage';
