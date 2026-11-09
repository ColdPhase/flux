/**
 * Provider-neutral AI connections (issue #179, decision F-020, PROV-1–PROV-6).
 *
 * An owner's connection names a provider kind, a model, a base URL (fixed for the named
 * providers, owner-set for an OpenAI-compatible endpoint) and a price per 1M tokens. Every
 * provider goes through the same Flux code path; only the wire format differs. Three wire formats
 * cover all five kinds: Anthropic Messages, OpenAI's Responses API (#954: its tool calling and its
 * built-in web search), and OpenAI-compatible Chat Completions (OpenRouter, Gemini's compatible
 * endpoint and self-hosted servers).
 */

export const AI_PROVIDER_KINDS = ['anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];
export type AiWireFormat = 'anthropic_messages' | 'openai_responses' | 'openai_chat_completions';

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
  /**
   * Whether a response reports its own cost (OpenRouter's `usage.cost`). It only reconciles the
   * run's actual charge; it never raises or bypasses the reservation (PROV-3).
   */
  reportsCost: boolean;
  /**
   * Whether the provider has its own built-in web search on the wire format Flux speaks to it (#954, C-29): Anthropic's `web_search`
   * server tool, OpenAI's Responses `web_search` tool. A run with tools is offered it while the operator's `FLUX_WEB_READS` is on;
   * a provider without one simply has no search.
   */
  searchesWeb: boolean;
}

/**
 * Base URLs are the providers' documented public API roots. Chat Completions requests go to
 * `<baseUrl>/chat/completions`, OpenAI's to `<baseUrl>/responses`; Anthropic requests to `<baseUrl>/v1/messages`.
 */
export const AI_PROVIDERS: Readonly<Record<AiProviderKind, AiProviderInfo>> = {
  anthropic: {
    kind: 'anthropic', label: 'Anthropic', wire: 'anthropic_messages', baseUrl: 'https://api.anthropic.com',
    keyHint: 'An Anthropic API key beginning with sk-ant-.', keylessModelList: false, reportsCost: false, searchesWeb: true,
  },
  openai: {
    kind: 'openai', label: 'OpenAI', wire: 'openai_responses', baseUrl: 'https://api.openai.com/v1',
    keyHint: 'An OpenAI project or service-account key beginning with sk-. Admin keys are refused.', keylessModelList: false, reportsCost: false, searchesWeb: true,
  },
  openrouter: {
    kind: 'openrouter', label: 'OpenRouter', wire: 'openai_chat_completions', baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'An OpenRouter key beginning with sk-or-.', keylessModelList: true, reportsCost: true, searchesWeb: false,
  },
  gemini: {
    kind: 'gemini', label: 'Google Gemini', wire: 'openai_chat_completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'A Gemini API key beginning with AIza. Google’s terms allow only a paid (billing-enabled) key for use in the EEA, Switzerland and the UK.', keylessModelList: false, reportsCost: false, searchesWeb: false,
  },
  openai_compatible: {
    kind: 'openai_compatible', label: 'OpenAI-compatible endpoint', wire: 'openai_chat_completions', baseUrl: null,
    keyHint: 'The key your endpoint expects. If it needs none, enter any placeholder of at least 8 characters.', keylessModelList: true, reportsCost: false, searchesWeb: false,
  },
};

/**
 * Models Flux knows cannot make tool calls on the wire format Flux speaks to their provider (F-027
 * AST-8: such a connection answers in one request and cannot change anything). An absent model is
 * not marked: a provider that cannot call tools refuses the request and the run fails closed. This
 * is a dated table like `AI_PRICE_TABLE`; recheck a row before relying on it after its date. It is
 * empty since #954: GPT-6 Astra and GPT-6.1 Sol, which OpenAI's function calling guide (read
 * 2026-10-11) says "require the Responses API for tool calling", call tools now that Flux speaks the
 * Responses API to OpenAI.
 */
export const AI_MODELS_WITHOUT_TOOL_CALLING: readonly { provider: AiProviderKind; model: string; checkedOn: string; reason: string }[] = [];

/** False when Flux knows the model cannot call tools on its wire format (see {@link AI_MODELS_WITHOUT_TOOL_CALLING}). */
export const aiModelCallsTools = (provider: AiProviderKind, model: string): boolean =>
  !AI_MODELS_WITHOUT_TOOL_CALLING.some((entry) => entry.provider === provider && entry.model === model);

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

/**
 * PROV-3: where a connection's price per 1M tokens comes from. A reservation needs a price before
 * any response exists, so only Flux's dated table or the owner sets it.
 */
export type AiPriceSource = 'table' | 'owner';

export interface AiPrice {
  /** Micro-dollars per 1M input tokens ($2/M is 2,000,000). */
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  source: AiPriceSource;
  /** When a table price was read (YYYY-MM-DD); null for an owner-entered price. */
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
const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing';
const GEMINI_PRICING = 'https://ai.google.dev/gemini-api/docs/pricing';

/**
 * Flux's dated price table for named models (PROV-3). Each row was read from the
 * provider's own pricing page on `checkedOn`; the model id from the provider's model overview
 * (https://platform.claude.com/docs/en/models/overview, 2026-10-02; `claude-sonnet-5` from the same
 * page on 2026-09-28, recorded in O-007). Standard rates only: no batch, regional or fast-mode
 * multipliers. Only prices verified from a primary source are listed. OpenAI rows were read on
 * 2026-10-03 from its pricing page (undated). Gemini rows were read on 2026-10-03 from its pricing page,
 * last updated 2026-10-01; they are the <=200k-token prompt tier, the only one Flux's bounded input can
 * reach. Time-limited promotional prices are not listed, because they expire and would under-reserve.
 * OpenRouter prices vary per model and are shown only as a suggestion (`listedPrice`). A missing row
 * never means free: the owner enters the price. Recheck a row before relying on it after its date.
 */
export const AI_PRICE_TABLE: readonly AiPriceTableEntry[] = [
  { provider: 'anthropic', model: 'claude-sonnet-5', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-haiku-4-5', inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'anthropic', model: 'claude-fable-5-1', inputMicrosPerMTok: 10_000_000, outputMicrosPerMTok: 50_000_000, checkedOn: '2026-10-02', source: ANTHROPIC_PRICING },
  { provider: 'openai', model: 'gpt-6-astra', inputMicrosPerMTok: 10_000_000, outputMicrosPerMTok: 50_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-6.1-sol', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-6-sol', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-6-luna', inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.6-sol', inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 20_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.6-terra', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 12_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.6-luna', inputMicrosPerMTok: 200_000, outputMicrosPerMTok: 1_200_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.5', inputMicrosPerMTok: 5_000_000, outputMicrosPerMTok: 30_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.4', inputMicrosPerMTok: 2_500_000, outputMicrosPerMTok: 15_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.4-mini', inputMicrosPerMTok: 750_000, outputMicrosPerMTok: 4_500_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.4-nano', inputMicrosPerMTok: 200_000, outputMicrosPerMTok: 1_250_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.2', inputMicrosPerMTok: 1_750_000, outputMicrosPerMTok: 14_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5.1', inputMicrosPerMTok: 1_250_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5', inputMicrosPerMTok: 1_250_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5-mini', inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 2_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-5-nano', inputMicrosPerMTok: 50_000, outputMicrosPerMTok: 400_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-4.1', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 8_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'gpt-4o', inputMicrosPerMTok: 2_500_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'o3', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 8_000_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'openai', model: 'o3-mini', inputMicrosPerMTok: 1_100_000, outputMicrosPerMTok: 4_400_000, checkedOn: '2026-10-03', source: OPENAI_PRICING },
  { provider: 'gemini', model: 'gemini-3.5-flash', inputMicrosPerMTok: 1_500_000, outputMicrosPerMTok: 9_000_000, checkedOn: '2026-10-03', source: GEMINI_PRICING },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite', inputMicrosPerMTok: 300_000, outputMicrosPerMTok: 2_500_000, checkedOn: '2026-10-03', source: GEMINI_PRICING },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite', inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_500_000, checkedOn: '2026-10-03', source: GEMINI_PRICING },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview', inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 12_000_000, checkedOn: '2026-10-03', source: GEMINI_PRICING },
  { provider: 'gemini', model: 'gemini-2.5-pro', inputMicrosPerMTok: 1_250_000, outputMicrosPerMTok: 10_000_000, checkedOn: '2026-10-03', source: GEMINI_PRICING },
  { provider: 'gemini', model: 'gemini-2.5-flash', inputMicrosPerMTok: 300_000, outputMicrosPerMTok: 2_500_000, checkedOn: '2026-10-03', source: GEMINI_PRICING },
  { provider: 'gemini', model: 'gemini-2.5-flash-lite', inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 400_000, checkedOn: '2026-10-03', source: GEMINI_PRICING },
];

export function tablePrice(provider: AiProviderKind, model: string): AiPriceTableEntry | null {
  return AI_PRICE_TABLE.find((entry) => entry.provider === provider && entry.model === model) ?? null;
}

/**
 * What one search of the provider's built-in web search costs (#954): $10 per 1,000 searches on Anthropic (docs.claude.com web search
 * tool, read 2026-11-08) and $10 per 1,000 calls of OpenAI's `web_search` (developers.openai.com pricing, read 2026-11-08), on top of
 * the result tokens, which the provider counts as input. A search that failed is not billed by Anthropic; Flux counts every one.
 * There is no limit on the searches of a request or a run (founder direction, Hubert, 2026-11-09, #1113): each is charged as the
 * provider reports it, and the key's daily budget is what stops spending.
 */
export const WEB_SEARCH_MICROS = 10_000;

/**
 * The most one request can cost at `price` (PROV-3): maximum input tokens × input price + maximum
 * output tokens × output price, in micro-dollars, rounded up, and `webSearches` searches at `WEB_SEARCH_MICROS` each. A reservation
 * counts none (the searches of a request are not bounded, #1113); a charge counts the ones the provider reported.
 */
export function maxRequestMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, maxInputTokens: number, maxOutputTokens: number, webSearches = 0): number {
  return Math.ceil((maxInputTokens * price.inputMicrosPerMTok + maxOutputTokens * price.outputMicrosPerMTok) / 1_000_000) + webSearches * WEB_SEARCH_MICROS;
}

/**
 * Models whose provider has a built-in web search that they cannot use (#954): a run on one is not offered the search, as on a provider
 * without one. A dated table like `AI_MODELS_WITHOUT_TOOL_CALLING`; recheck a row before relying on it after its date. An absent model
 * is not marked: if its provider refuses the search tool, the request is sent again once without it and the key's model is not offered
 * it for a while (the worker remembers).
 */
export const AI_MODELS_WITHOUT_WEB_SEARCH: readonly { provider: AiProviderKind; model: string; checkedOn: string; reason: string }[] = [
  { provider: 'openai', model: 'o3-mini', checkedOn: '2026-11-09', reason: 'its model page lists no web_search among its Responses API tools' },
];

/** Whether a run on this provider and model may be offered the provider's built-in web search (#954). */
export const aiModelSearchesWeb = (provider: AiProviderKind, model: string): boolean =>
  AI_PROVIDERS[provider].searchesWeb && !AI_MODELS_WITHOUT_WEB_SEARCH.some((entry) => entry.provider === provider && entry.model === model);

/** `POST /api/v1/ai-model-lists`: the provider's models, fetched by the server without a key. */
export const AI_MODEL_LISTS_PATH = '/api/v1/ai-model-lists';

export interface AiModelListQuery {
  provider: AiProviderKind;
  /** `openai_compatible` only. */
  baseUrl?: string;
}

export interface AiListedModel {
  id: string;
  /**
   * The provider's own listed price (OpenRouter), shown to the owner as a suggestion for the price
   * they enter. It is never a price source by itself (PROV-3).
   */
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
