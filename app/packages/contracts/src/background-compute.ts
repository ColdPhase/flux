import type { AiPrice, AiProviderKind } from './ai-providers.js';

/**
 * An owner's API keys (F-020 PROV-1; Connect AI #854): one or more, each with a name and one daily budget, the only limit
 * on what runs on it. Adding a key never replaces another. An agent uses the key its model belongs to. Removing a key stops what uses it, with no fallback to another connection
 * or payer.
 */
export const backgroundComputeConnectionsPath = '/api/v1/background-compute-connections';
export const backgroundComputeConnectionPath = (connectionId: string) => `${backgroundComputeConnectionsPath}/${connectionId}`;
/** The one daily budget of an API key, in cents (#854): set by its owner; at the budget its agents pause until the next day. */
export const API_KEY_DAILY_BUDGET_CENTS = { min: 10, max: 100_000, default: 500 } as const;

/** Metadata only. The API never returns the key or its ciphertext. */
export interface BackgroundComputeConnection {
  id: string;
  ownerUserId: string;
  /** The owner's label, e.g. "Work OpenRouter". */
  name: string;
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

/** `PATCH /api/v1/background-compute-connections/:id`: rename it or change its daily budget. */
export interface UpdateBackgroundComputeConnectionCommand {
  name?: string;
  dailyBudgetCents?: number;
}
