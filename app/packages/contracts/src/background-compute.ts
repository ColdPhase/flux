import type { AiPrice, AiProviderKind } from './ai-providers.js';

/**
 * Disclosure versions of a background connection's consent. `o-007-2026-09-28` named Anthropic and
 * `claude-sonnet-5` only and stays valid for exactly those connections; `o-007-2026-10-02` is the
 * provider-neutral revision of F-020 (#179), naming the selected provider, model and price.
 */
export const BACKGROUND_CONSENT_VERSIONS = ['o-007-2026-09-28', 'o-007-2026-10-02'] as const;
export type BackgroundConsentVersion = (typeof BACKGROUND_CONSENT_VERSIONS)[number];
export const BACKGROUND_CONSENT_VERSION: BackgroundConsentVersion = 'o-007-2026-10-02';

/** One bounded background comparison request (O-007 §3), the same for every provider. */
export const BACKGROUND_COMPARISON_LIMITS = { maxInputTokens: 8_000, maxOutputTokens: 1_200, minimumReserveCents: 5 } as const;

/**
 * An owner's AI connections (F-020 PROV-1): one or more, each with a name. Adding a connection never
 * replaces another. Background comparisons use the one marked `usedForBackground`; the assistant in
 * Flux uses the one its consent names. Removing a connection stops the uses that point to it, with no
 * fallback to another connection or payer.
 */
export const backgroundComputeConnectionsPath = '/api/v1/background-compute-connections';
export const backgroundComputeConnectionPath = (connectionId: string) => `${backgroundComputeConnectionsPath}/${connectionId}`;
/** Whether this instance runs background comparisons (#58, `FLUX_BACKGROUND_COMPARISONS`). */
export const backgroundComparisonRuntimePath = '/api/v1/background-comparisons/runtime';
export interface BackgroundComparisonRuntime { status: 'available' | 'unavailable' }

/** Metadata only. The API never returns the key or its ciphertext. */
export interface BackgroundComputeConnection {
  id: string;
  ownerUserId: string;
  /** The owner's label, e.g. "Work OpenRouter". */
  name: string;
  /** Whether background comparisons run on this connection (at most one of the owner's). */
  usedForBackground: boolean;
  provider: AiProviderKind;
  model: string;
  /** The owner's endpoint for `openai_compatible`; null for a named provider's fixed URL. */
  baseUrl: string | null;
  /** Null when no price is known: the connection cannot be enabled for any use (PROV-3). */
  price: AiPrice | null;
  payerOrganization: string;
  providerWorkspace: string;
  keyLastFour: string;
  keyFingerprint: string;
  maxRunsPerDay: number;
  periodDays: 30;
  periodBudgetCents: number;
  perRunCents: number;
  consentVersion: BackgroundConsentVersion;
  consentedAt: string;
  createdAt: string;
}

/**
 * An owner explicitly attests the provider payer/workspace and local budget. The price comes from
 * the provider's own listing or Flux's price table when either has the model; an owner `price` is
 * accepted only when neither does (PROV-3), in micro-dollars per 1M tokens, and may be zero.
 */
export interface ConnectBackgroundComputeCommand {
  /** 1–80 characters; defaults to "<Provider> · <model>". */
  name?: string;
  /** Make this the connection background comparisons use; the owner's first connection always is. */
  useForBackground?: boolean;
  provider: AiProviderKind;
  model: string;
  /** Required for `openai_compatible`, refused for the named providers. */
  baseUrl?: string;
  price?: { inputMicrosPerMTok: number; outputMicrosPerMTok: number };
  apiKey: string;
  payerOrganization: string;
  providerWorkspace: string;
  workspaceScopedKeyConfirmed: true;
  payerAuthorityConfirmed: true;
  providerBillingAcknowledged: true;
  projectDataDisclosureAcknowledged: true;
  maxRunsPerDay: number;
  periodDays: 30;
  periodBudgetCents: number;
  perRunCents: number;
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

/** `PATCH /api/v1/background-compute-connections/:id`: rename it, or make it the background connection. */
export interface UpdateBackgroundComputeConnectionCommand {
  name?: string;
  /** Only `true`: another connection is chosen by marking it; none is chosen by removing the marked one. */
  usedForBackground?: true;
}
