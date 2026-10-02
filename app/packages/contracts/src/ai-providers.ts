/**
 * Provider-neutral AI connections (issue #179, decision F-020, PROV-1–PROV-6).
 *
 * An owner's connection names a provider kind, a model, a base URL (fixed for the named
 * providers, owner-set for an OpenAI-compatible endpoint) and a price per 1M tokens. Every
 * provider goes through the same Flux code path; only the wire format differs. Two wire formats
 * cover all five kinds: Anthropic Messages, and OpenAI-compatible Chat Completions (OpenAI,
 * OpenRouter, Gemini's compatible endpoint and self-hosted servers).
 */

export const AI_PROVIDER_KINDS = ['anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];
export type AiWireFormat = 'anthropic_messages' | 'openai_chat_completions';

export interface AiProviderInfo {
  kind: AiProviderKind;
  /** Neutral display name, e.g. "OpenRouter · model-id" in the UI (PROV-2). */
  label: string;
  wire: AiWireFormat;
  /**
   * The fixed public API base of a named provider; null when the owner sets it. Flux never reads
   * a base URL from environment variables, so no variable can redirect an owner's key (PROV-4).
   */
  baseUrl: string | null;
  /** What a key of this provider looks like, for the settings form. */
  keyHint: string;
  /** Whether the server may list the provider's models without a key (PROV-1). */
  keylessModelList: boolean;
  /** Whether a response reports its own cost (PROV-3 price source 1): OpenRouter's `usage.cost`. */
  reportsCost: boolean;
}

/**
 * Base URLs are the providers' documented public API roots. Chat Completions requests go to
 * `<baseUrl>/chat/completions`; Anthropic requests to `<baseUrl>/v1/messages`.
 */
export const AI_PROVIDERS: Readonly<Record<AiProviderKind, AiProviderInfo>> = {
  anthropic: {
    kind: 'anthropic', label: 'Anthropic', wire: 'anthropic_messages', baseUrl: 'https://api.anthropic.com',
    keyHint: 'An Anthropic API key beginning with sk-ant-.', keylessModelList: false, reportsCost: false,
  },
  openai: {
    kind: 'openai', label: 'OpenAI', wire: 'openai_chat_completions', baseUrl: 'https://api.openai.com/v1',
    keyHint: 'An OpenAI project or service-account key beginning with sk-. Admin keys are refused.', keylessModelList: false, reportsCost: false,
  },
  openrouter: {
    kind: 'openrouter', label: 'OpenRouter', wire: 'openai_chat_completions', baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'An OpenRouter key beginning with sk-or-.', keylessModelList: true, reportsCost: true,
  },
  gemini: {
    kind: 'gemini', label: 'Google Gemini', wire: 'openai_chat_completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'A Gemini API key beginning with AIza.', keylessModelList: false, reportsCost: false,
  },
  openai_compatible: {
    kind: 'openai_compatible', label: 'OpenAI-compatible endpoint', wire: 'openai_chat_completions', baseUrl: null,
    keyHint: 'The key your endpoint expects. If it needs none, enter any placeholder of at least 8 characters.', keylessModelList: true, reportsCost: false,
  },
};

export const isAiProviderKind = (value: unknown): value is AiProviderKind =>
  typeof value === 'string' && (AI_PROVIDER_KINDS as readonly string[]).includes(value);

/** "OpenRouter · vendor/model". Names the selected connection only (PROV-2). */
export const aiConnectionLabel = (provider: AiProviderKind, model: string) => `${AI_PROVIDERS[provider].label} · ${model}`;

/** A model id is the owner's free choice within these bounds: no spaces, controls or quotes. */
export const AI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
/** An owner-set base URL (`openai_compatible` only). */
export const AI_BASE_URL_MAX_LENGTH = 2048;
/** $1,000 per 1M tokens, in micro-dollars: far above any listed model, so a typo cannot pass silently. */
export const AI_PRICE_MAX_MICROS_PER_MTOK = 1_000_000_000;

/** PROV-3: where a connection's price per 1M tokens comes from. */
export type AiPriceSource = 'table' | 'provider_reported' | 'owner';

export interface AiPrice {
  /** Micro-dollars per 1M input tokens ($2/M is 2,000,000). */
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  source: AiPriceSource;
  /** When a table or provider-reported price was read (YYYY-MM-DD); null for an owner-entered price. */
  checkedOn: string | null;
}

export interface AiPriceTableEntry {
  provider: AiProviderKind;
  model: string;
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  checkedOn: string;
  /** The primary source the price was read from on `checkedOn`. */
  source: string;
}

const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';

/**
 * Flux's dated price table for named models (PROV-3 price source 2). Each row was read from the
 * provider's own pricing page on `checkedOn`; the model id from the provider's model overview
 * (https://platform.claude.com/docs/en/models/overview, 2026-10-02; `claude-sonnet-5` from the same
 * page on 2026-09-28, recorded in O-007). Standard rates only: no batch, regional or fast-mode
 * multipliers. Only prices verified from a primary source are listed. OpenAI, OpenRouter and Gemini
 * pages could not be reached from the implementation sandbox on 2026-10-02, so none of their models
 * is listed: for those, the price comes from the provider's own listing (OpenRouter) or the owner.
 * A missing row never means free. Recheck a row before relying on it after its date.
 */
export const AI_PRICE_TABLE: readonly AiPriceTableEntry[] = [
  { provider: 'anthropic', model: 'claude-sonnet-5', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-haiku-4-5', inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-fable-5-1', inputMicrosPerMTok: 10_000_000, outputMicrosPerMTok: 50_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
];

export function tablePrice(provider: AiProviderKind, model: string): AiPriceTableEntry | null {
  return AI_PRICE_TABLE.find((entry) => entry.provider === provider && entry.model === model) ?? null;
}

/**
 * The most one request can cost at `price` (PROV-3): maximum input tokens × input price + maximum
 * output tokens × output price, in micro-dollars, rounded up.
 */
export function maxRequestMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, maxInputTokens: number, maxOutputTokens: number): number {
  return Math.ceil((maxInputTokens * price.inputMicrosPerMTok + maxOutputTokens * price.outputMicrosPerMTok) / 1_000_000);
}

/** `POST /api/v1/ai-model-lists`: the provider's models, fetched by the server without a key. */
export const AI_MODEL_LISTS_PATH = '/api/v1/ai-model-lists';

export interface AiModelListQuery {
  provider: AiProviderKind;
  /** `openai_compatible` only. */
  baseUrl?: string;
}

export interface AiListedModel {
  id: string;
  /** Present when the provider's own listing states it (OpenRouter). */
  price: { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | null;
}

export interface AiModelList {
  provider: AiProviderKind;
  /**
   * `listed`: the models below. `needs_key`: this provider lists models only with a key, so the
   * owner types the model id. `unavailable`: the endpoint could not be reached or refused, or it
   * answered with something that is not a model list. `refused`: the base URL is not allowed here.
   */
  status: 'listed' | 'needs_key' | 'unavailable' | 'refused';
  models: AiListedModel[];
  /** When the list was read (YYYY-MM-DD). */
  checkedOn: string;
}
