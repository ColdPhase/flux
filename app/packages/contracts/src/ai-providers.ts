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
  /**
   * Whether its models take pictures as input on the wire format Flux speaks to it (#1217, C-59), unless `AI_MODELS_WITHOUT_VISION` names
   * one. Flux cannot tell for OpenRouter or an OpenAI-compatible server, whose models differ, so those are taken to see none.
   */
  seesPictures: boolean;
}

/**
 * Base URLs are the providers' documented public API roots. Chat Completions requests go to
 * `<baseUrl>/chat/completions`, OpenAI's to `<baseUrl>/responses`; Anthropic requests to `<baseUrl>/v1/messages`.
 */
export const AI_PROVIDERS: Readonly<Record<AiProviderKind, AiProviderInfo>> = {
  anthropic: {
    kind: 'anthropic', label: 'Anthropic', wire: 'anthropic_messages', baseUrl: 'https://api.anthropic.com',
    keyHint: 'An Anthropic API key beginning with sk-ant-.', keylessModelList: false, reportsCost: false, searchesWeb: true, seesPictures: true,
  },
  openai: {
    kind: 'openai', label: 'OpenAI', wire: 'openai_responses', baseUrl: 'https://api.openai.com/v1',
    keyHint: 'An OpenAI project or service-account key beginning with sk-. Admin keys are refused.', keylessModelList: false, reportsCost: false, searchesWeb: true, seesPictures: true,
  },
  openrouter: {
    kind: 'openrouter', label: 'OpenRouter', wire: 'openai_chat_completions', baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'An OpenRouter key beginning with sk-or-.', keylessModelList: true, reportsCost: true, searchesWeb: false, seesPictures: false,
  },
  gemini: {
    kind: 'gemini', label: 'Google Gemini', wire: 'openai_chat_completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'A Gemini API key beginning with AIza. Google’s terms allow only a paid (billing-enabled) key for use in the EEA, Switzerland and the UK.', keylessModelList: false, reportsCost: false, searchesWeb: false, seesPictures: true,
  },
  openai_compatible: {
    kind: 'openai_compatible', label: 'OpenAI-compatible endpoint', wire: 'openai_chat_completions', baseUrl: null,
    keyHint: 'The key your endpoint expects. If it needs none, enter any placeholder of at least 8 characters.', keylessModelList: true, reportsCost: false, searchesWeb: false, seesPictures: false,
  },
};

/**
 * Models Flux knows cannot make tool calls on the wire format Flux speaks to their provider (F-027
 * AST-8: such a connection answers in one request and cannot change anything). An absent model is
 * not marked: a provider that cannot call tools refuses the request and the run fails closed. This
 * is a dated table; recheck a row before relying on it after its date. It is
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
 * PROV-3: where a connection's price per 1M tokens comes from. A reservation needs a price before any response exists, so only Flux's
 * price list (refreshed daily from a maintained public list, #1465) or the owner sets it.
 */
export type AiPriceSource = 'list' | 'owner';

export interface AiPrice {
  /** Micro-dollars per 1M input tokens ($2/M is 2,000,000). */
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  source: AiPriceSource;
  /** The day Flux's price list was fetched (YYYY-MM-DD); null for an owner-entered price. */
  checkedOn: string | null;
}

/** Prices per 1M tokens by model id. */
export type AiModelPrices = Readonly<Record<string, { inputMicrosPerMTok: number; outputMicrosPerMTok: number }>>;

/**
 * Flux's price list (#1465): the standard input and output prices of Anthropic's, OpenAI's and Gemini's models, read every day from
 * {@link AI_PRICE_LIST_URL} by the worker, and shipped with the release as fetched on its build day. It prices a model; it never decides
 * which models exist (#1218). A model it lacks (OpenRouter's, an OpenAI-compatible endpoint's, a new or unusual one) is priced by its owner.
 */
export interface AiPriceList {
  /** The day the list was fetched (YYYY-MM-DD). */
  fetchedOn: string;
  /** Where it was fetched from. */
  source: string;
  prices: Partial<Record<AiProviderKind, AiModelPrices>>;
}

/** Flux's price list of one provider: what the Connect AI form and the model pickers price a model with. */
export interface AiProviderPriceList {
  fetchedOn: string;
  prices: AiModelPrices;
}

/**
 * The maintained public list Flux reads its prices from (#1465): LiteLLM's model price file (MIT licence), whose ids are the providers'
 * own and whose prices matched the providers' pricing pages on every sampled model (docs/product/research/2026-11-13-model-price-list.md).
 */
export const AI_PRICE_LIST_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
/** The worker's job that fetches Flux's price list (#1465): every day, and at start when the stored list is older than a day. */
export const AI_PRICE_LIST_JOB = 'ai-price-list.refresh.v1';
/** The providers whose prices Flux's list carries. */
export const AI_PRICE_LIST_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const satisfies readonly AiProviderKind[];

/** The price one provider's part of Flux's list gives a model, or null when the list does not know it. */
export function listPrice(list: AiProviderPriceList | null | undefined, model: string): AiPrice | null {
  if (!list || !Object.prototype.hasOwnProperty.call(list.prices, model)) return null;
  const row = list.prices[model]!;
  return { inputMicrosPerMTok: row.inputMicrosPerMTok, outputMicrosPerMTok: row.outputMicrosPerMTok, source: 'list', checkedOn: list.fetchedOn };
}

/**
 * The price a stored connection runs at (#1465): Flux's price list today when it knows the model, so a price that changed is used the
 * next day without anyone typing it; otherwise the price stored with the connection (the owner's, or the list's last one for a model
 * the list stopped carrying); null when there is neither.
 */
export function currentConnectionPrice(stored: AiPrice | null, model: string, list: AiProviderPriceList | null | undefined): AiPrice | null {
  return listPrice(list, model) ?? stored;
}

/** One provider's part of the whole list. */
export const providerPriceList = (list: AiPriceList | null | undefined, provider: AiProviderKind): AiProviderPriceList | null =>
  list ? { fetchedOn: list.fetchedOn, prices: list.prices[provider] ?? {} } : null;

const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';

/**
 * What one search of the provider's built-in web search costs (#954): $10 per 1,000 searches on Anthropic (docs.claude.com web search
 * tool, read 2026-11-08) and $10 per 1,000 calls of OpenAI's `web_search` (developers.openai.com pricing, read 2026-11-08), on top of
 * the result tokens, which the provider counts as input. A search that failed is not billed by Anthropic; Flux counts every one.
 * There is no limit on the searches of a request or a run (founder direction, Hubert, 2026-11-09, #1113): each is charged as the
 * provider reports it, and the key's daily budget is what stops spending.
 */
export const WEB_SEARCH_MICROS = 10_000;

/**
 * Prompt caching that Flux asks for (#1410): Anthropic caches what a request marks with `cache_control` (the tool definitions, the
 * brief, and the conversation of a tool run as it grows) for five minutes. A cache write costs 1.25× the input price and a read 0.1×
 * on every Claude model (0.05× on Claude Opus 5.5 and Sonnet 5.5, so 0.1× never charges less than the provider bills) (pricing page,
 * platform.claude.com/docs/en/about-claude/pricing, read 2026-11-13). OpenAI and Gemini cache a repeated prefix by themselves; Flux
 * asks nothing of them and charges their cached input at the full price, which it does not undercount.
 */
export const PROMPT_CACHE_RATES: Partial<Record<AiProviderKind, { write: number; read: number; checkedOn: string; source: string }>> = {
  anthropic: { write: 1.25, read: 0.1, checkedOn: '2026-11-13', source: ANTHROPIC_PRICING },
};

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

/**
 * Models of a provider that sees pictures which do not (#1217, C-59): an agent on one is not given `flux_view_image` and says it sees only
 * the names of attached files; the model list says "Can't see pictures". A dated table; recheck a row before relying on it after its date.
 */
export const AI_MODELS_WITHOUT_VISION: readonly { provider: AiProviderKind; model: string; checkedOn: string; reason: string }[] = [
  { provider: 'openai', model: 'o3-mini', checkedOn: '2026-11-12', reason: 'its model page lists text as its only input' },
];

/**
 * Whether a run on this provider and model can be given a picture as input (#1217). A run on the owner's Claude Code or Codex always can:
 * their models take pictures, and the CLI passes an MCP image result to its model (`engine: 'runtime'`).
 */
export const aiModelSeesPictures = (provider: AiProviderKind, model: string, engine: 'server' | 'runtime' = 'server'): boolean =>
  engine === 'runtime' || (AI_PROVIDERS[provider].seesPictures && !AI_MODELS_WITHOUT_VISION.some((entry) => entry.provider === provider && entry.model === model));

/**
 * `POST /api/v1/ai-model-lists`: the provider's models, fetched by the server (CA-2, #1218). OpenRouter and an OpenAI-compatible
 * endpoint are listed without a key. Anthropic, OpenAI and Gemini are listed with the key the person is adding (`apiKey`), and that
 * one call is also the key's test; without a key they answer `needs_key`.
 */
export const AI_MODEL_LISTS_PATH = '/api/v1/ai-model-lists';

export interface AiModelListQuery {
  provider: AiProviderKind;
  /** `openai_compatible` only. */
  baseUrl?: string;
  /** Anthropic, OpenAI and Gemini: the key being added. It is only sent to its provider, never stored or echoed. */
  apiKey?: string;
}

export interface AiListedModel {
  id: string;
  /** The provider's own display name ("Claude Opus 5.5"), or null where its list gives none. */
  name?: string | null;
  /** The family the picker groups it under ("Opus", "Sol", "Flash"); see `aiModelFamily`. */
  family?: string;
  /** When the provider released it (ISO), where its list says; the newest comes first. */
  createdAt?: string | null;
  /**
   * The provider's own listed price (OpenRouter), shown to the owner as a suggestion for the price
   * they enter. It is never a price source by itself (PROV-3).
   */
  price: { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | null;
}

export interface AiModelList {
  provider: AiProviderKind;
  /**
   * `listed`: the models below. `needs_key`: this provider lists models only with a key, and none was given. `key_refused`: the
   * provider refused the key (401 or 403), so it is not saved. `unavailable`: the endpoint could not be reached in time, failed, or
   * answered with something that is not a model list. `refused`: the base URL is not allowed here.
   */
  status: 'listed' | 'needs_key' | 'key_refused' | 'unavailable' | 'refused';
  models: AiListedModel[];
  /** When the list was read (YYYY-MM-DD). */
  checkedOn: string;
  /**
   * Flux's price list of this provider (#1465), so the form shows a model's price or asks for it; absent or null when Flux knows no
   * price for any model of the provider (OpenRouter, an OpenAI-compatible endpoint).
   */
  priceList?: AiProviderPriceList | null;
}
