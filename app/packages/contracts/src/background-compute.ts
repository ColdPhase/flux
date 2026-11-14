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
  /** Prices the owner entered for the key's other models that Flux's price list does not price, by model id (#1218, #1465). */
  modelPrices?: Readonly<Record<string, { inputMicrosPerMTok: number; outputMicrosPerMTok: number }>>;
}

/** `PUT` the owner's price for one model of their key (PROV-3, #1218). */
export const backgroundComputeModelPricePath = (connectionId: string) => `/api/v1/background-compute-connections/${connectionId}/model-price`;
export interface SetApiKeyModelPriceCommand { model: string; inputMicrosPerMTok: number; outputMicrosPerMTok: number }
/** `POST` reads the key's models from its provider again (Try again, #1218); the worker does it, and the answer is the key's list. */
export const backgroundComputeModelListPath = (connectionId: string) => `/api/v1/background-compute-connections/${connectionId}/model-list`;

/**
 * Adds an API key. The price comes from Flux's price list when it has the model (#1465); an owner `price` is accepted only when
 * it does not (PROV-3), in micro-dollars per 1M tokens, and may be zero (a self-hosted endpoint).
 */
export interface ConnectBackgroundComputeCommand {
  /** 1–80 characters; defaults to "<Provider> key". */
  name?: string;
  provider: AiProviderKind;
  /** The model the owner chose for the key: Flux has no default (a command without one is a 422, `AI_MODEL_REQUIRED`). */
  model: string;
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

/**
 * The worker reads a stored key's models from its provider (#1218): the only process that opens a stored key (CA-4). The payload is
 * the key's id; the key itself never enters a job.
 */
export const API_KEY_MODEL_LIST_JOB = 'api-key.model-list.v1';
export interface ApiKeyModelListJob { connectionId: string }
/** A key's list is read again when its picker opens and the last reading is older than this (#1218). */
export const API_KEY_MODEL_LIST_FRESH_MS = 6 * 3600_000;
