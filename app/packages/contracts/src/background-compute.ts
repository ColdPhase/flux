import type { AiPrice, AiProviderKind } from './ai-providers.js';

/** One bounded background comparison request (O-007 §3), the same for every provider. */
export const BACKGROUND_COMPARISON_LIMITS = { maxInputTokens: 8_000, maxOutputTokens: 1_200, minimumReserveCents: 5 } as const;

/**
 * An owner's API keys (F-020 PROV-1; Connect AI #854): one or more, each with a name and one daily budget, the only limit
 * on what runs on it. Adding a key never replaces another. Background comparisons use the one marked `usedForBackground`;
 * an agent uses the key its model belongs to. Removing a key stops what uses it, with no fallback to another connection
 * or payer.
 */
export const backgroundComputeConnectionsPath = '/api/v1/background-compute-connections';
export const backgroundComputeConnectionPath = (connectionId: string) => `${backgroundComputeConnectionsPath}/${connectionId}`;
/** Whether this instance runs background comparisons (#58, `FLUX_BACKGROUND_COMPARISONS`). */
export const backgroundComparisonRuntimePath = '/api/v1/background-comparisons/runtime';
export interface BackgroundComparisonRuntime { status: 'available' | 'unavailable' }

/** The one daily budget of an API key, in cents (#854): set by its owner; at the budget its agents pause until the next day. */
export const API_KEY_DAILY_BUDGET_CENTS = { min: 10, max: 100_000, default: 500 } as const;

/** Metadata only. The API never returns the key or its ciphertext. */
export interface BackgroundComputeConnection {
  id: string;
  ownerUserId: string;
  /** The owner's label, e.g. "Work OpenRouter". */
  name: string;
  /** Whether background comparisons run on this connection (at most one of the owner's). */
  usedForBackground: boolean;
  provider: AiProviderKind;
  /** The key's default model: the one Connect AI offers first for a new agent. */
  model: string;
  /** The owner's endpoint for `openai_compatible`; null for a named provider's fixed URL. */
  baseUrl: string | null;
  /** Null when no price is known: the daily budget cannot hold, so the key cannot be used (PROV-3). */
  price: AiPrice | null;
  keyLastFour: string;
  keyFingerprint: string;
  /** The key's one daily budget. */
  dailyBudgetCents: number;
  /** The IANA time zone whose midnight starts the key's day. */
  timeZone: string;
  /** Today's use of the budget by everything that runs on the key: what was spent, not what work in progress holds. */
  today: { spentMicros: number; resetsAt: string };
  createdAt: string;
}

/**
 * Adds an API key. The price comes from Flux's dated table when it has the model; an owner `price` is accepted only when
 * it does not (PROV-3), in micro-dollars per 1M tokens, and may be zero (a self-hosted endpoint).
 */
export interface ConnectBackgroundComputeCommand {
  /** 1–80 characters; defaults to "<Provider> key". */
  name?: string;
  /** Make this the connection background comparisons use; the owner's first connection always is. */
  useForBackground?: boolean;
  provider: AiProviderKind;
  /** The key's default model; for a named provider, Flux's default for it when left out. */
  model?: string;
  /** Required for `openai_compatible`, refused for the named providers. */
  baseUrl?: string;
  price?: { inputMicrosPerMTok: number; outputMicrosPerMTok: number };
  apiKey: string;
  dailyBudgetCents: number;
  /** Defaults to UTC. */
  timeZone?: string;
}

/** Project-readable, quiet suggestion from one owner-funded background candidate. */
export interface ProactiveComparisonProposal {
  id: string;
  projectId: string;
  resultId: string;
  ownerUserId: string;
  agentId: string;
  audience: { kind: 'project'; projectId: string };
  /** The owner's own background connection, of any provider (F-020), and the model it ran on. */
  computeSource: 'owner_background_connection';
  provider: AiProviderKind;
  model: string;
  /** Cited project source revisions, including the triggering result. Reads and changes omit those the current reader cannot open. */
  sources: Array<{ type: 'result' | 'message' | 'material' | 'work' | 'thought'; id: string; version: number; conversationId?: string; sketchId?: string; title?: string }>;
  fact: string;
  interpretation: string;
  suggestedAction: string;
  status: 'proposed' | 'dismissed' | 'used';
  version: number;
  editedByUserId: string | null;
  usedWorkId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const proactiveComparisonProposalsPath = (projectId: string) =>
  `/api/v1/projects/${projectId}/proactive-comparison-proposals`;
export const proactiveComparisonProposalPath = (proposalId: string) => `/api/v1/proactive-comparison-proposals/${proposalId}`;
export const proactiveComparisonProposalUsePath = (proposalId: string) => `${proactiveComparisonProposalPath(proposalId)}/use`;
export const proactiveComparisonRulesPath = (projectId: string) => `/api/v1/projects/${projectId}/proactive-comparison-rules`;
export const proactiveComparisonRulePath = (ruleId: string) => `/api/v1/proactive-comparison-rules/${ruleId}`;

/** `PATCH /api/v1/background-compute-connections/:id`: rename it, change its daily budget, or make it the background connection. */
export interface UpdateBackgroundComputeConnectionCommand {
  name?: string;
  dailyBudgetCents?: number;
  /** Only `true`: another connection is chosen by marking it; none is chosen by removing the marked one. */
  usedForBackground?: true;
}
