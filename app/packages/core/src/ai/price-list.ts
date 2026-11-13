import { AI_PRICE_LIST_PROVIDERS, AI_PRICE_LIST_URL, AI_PRICE_MAX_MICROS_PER_MTOK, personalRunMaxInputTokens, type AiModelPrices, type AiPriceList,
  type AiProviderKind } from '@flux/contracts';
import { validModelId } from './validation.js';
import { SHIPPED_PRICE_FILE } from './price-list-snapshot.js';

// Flux's price list (#1465): read every day from LiteLLM's maintained model price file (AI_PRICE_LIST_URL) and shipped with each
// release as fetched on its build day. This is the one place that turns that file into Flux's prices; the worker's daily job and the
// build-day snapshot script both use it, and anything it cannot vouch for is left out (its owner then enters the price).

/** The most the fetched file may weigh: it was 4.1 MB on 2026-11-13; a larger answer is refused and the last good list kept. */
export const PRICE_LIST_MAX_BYTES = 16_000_000;
/** How long the fetch may take, end to end. */
export const PRICE_LIST_TIMEOUT_MS = 30_000;
/** The most models one provider may have in the list; the file had 24 Anthropic, 126 OpenAI and 47 Gemini text models on 2026-11-13. */
const MAX_MODELS_PER_PROVIDER = 2_000;
/** LiteLLM's modes of the models Flux calls: Messages and Chat Completions (`chat`) and OpenAI's Responses API (`responses`). */
const TEXT_MODES = new Set(['chat', 'responses']);
/** The prompt-length tiers LiteLLM writes as `input_cost_per_token_above_<N>k_tokens`, without a batch, flex or priority suffix. */
const TIER = /^(input|output)_cost_per_token_above_(\d{1,4})k_tokens$/;

/**
 * The prompt length Flux's largest server request can reach: a tool run's input with the provider's web search results (64,000 + 50,000).
 * A model priced by prompt length is priced at the highest tier below it, so a request is counted high, never low (PROV-3).
 */
export const PRICE_LIST_LARGEST_PROMPT_TOKENS = personalRunMaxInputTokens(true, true);

/** The model id in Flux's terms, or null for an entry of another provider or a key Flux does not call. */
function modelIdOf(provider: AiProviderKind, key: string): string | null {
  const id = provider === 'gemini' ? (key.startsWith('gemini/') ? key.slice('gemini/'.length) : null) : key;
  return id && !id.includes('/') && validModelId(provider, id) ? id : null;
}

/** USD per token as LiteLLM writes it, in micro-dollars per 1M tokens; null for anything not a sane price. */
function microsPerMTok(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const micros = Math.round(value * 1e12);
  return Number.isSafeInteger(micros) && micros <= AI_PRICE_MAX_MICROS_PER_MTOK ? micros : null;
}

/** The entry's price at the highest tier Flux's largest request can reach, or null when any of its values is not a sane price. */
function entryPrice(entry: Record<string, unknown>): { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | null {
  let input = microsPerMTok(entry.input_cost_per_token);
  let output = microsPerMTok(entry.output_cost_per_token);
  if (input === null || output === null) return null;
  for (const [field, value] of Object.entries(entry)) {
    const tier = TIER.exec(field);
    if (!tier || Number(tier[2]) * 1_000 >= PRICE_LIST_LARGEST_PROMPT_TOKENS) continue;
    const micros = microsPerMTok(value);
    if (micros === null) return null;
    if (tier[1] === 'input') input = Math.max(input, micros);
    else output = Math.max(output, micros);
  }
  return { inputMicrosPerMTok: input, outputMicrosPerMTok: output };
}

/**
 * Flux's price list from LiteLLM's file, or null when the file is not one: not an object, or without a single priced model of any of
 * Anthropic, OpenAI and Gemini (a truncated or replaced file is refused whole, and the last good list stays). An entry is taken only
 * when it names one of those providers (`litellm_provider`), is a text model Flux calls (`mode` chat or responses), has a model id Flux
 * accepts, and both its standard prices (and any tier it reaches) are numbers from 0 to {@link AI_PRICE_MAX_MICROS_PER_MTOK}. Batch,
 * flex, priority, regional and cache prices are not read.
 */
export function parsePriceList(raw: unknown, fetchedOn: string, source: string = AI_PRICE_LIST_URL): AiPriceList | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !/^\d{4}-\d{2}-\d{2}$/.test(fetchedOn)) return null;
  const prices: Partial<Record<AiProviderKind, Record<string, { inputMicrosPerMTok: number; outputMicrosPerMTok: number }>>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const provider = AI_PRICE_LIST_PROVIDERS.find((kind) => kind === entry.litellm_provider);
    if (!provider || !TEXT_MODES.has(String(entry.mode))) continue;
    const id = modelIdOf(provider, key);
    const price = id ? entryPrice(entry) : null;
    if (!id || !price) continue;
    const rows = (prices[provider] ??= {});
    if (Object.keys(rows).length >= MAX_MODELS_PER_PROVIDER) continue;
    rows[id] = price;
  }
  if (!AI_PRICE_LIST_PROVIDERS.every((provider) => Object.keys(prices[provider] ?? {}).length > 0)) return null;
  const sorted: Partial<Record<AiProviderKind, AiModelPrices>> = {};
  for (const provider of AI_PRICE_LIST_PROVIDERS)
    sorted[provider] = Object.fromEntries(Object.entries(prices[provider]!).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { fetchedOn, source, prices: sorted };
}

const saneMicros = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= AI_PRICE_MAX_MICROS_PER_MTOK;

/** Whether a stored or shipped list is a well-formed Flux price list: it is checked again before it is used. */
export function isPriceList(value: unknown): value is AiPriceList {
  if (!value || typeof value !== 'object') return false;
  const list = value as Partial<AiPriceList>;
  if (typeof list.fetchedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(list.fetchedOn) || typeof list.source !== 'string'
    || !list.prices || typeof list.prices !== 'object') return false;
  return Object.entries(list.prices).every(([provider, rows]) => (AI_PRICE_LIST_PROVIDERS as readonly string[]).includes(provider)
    && !!rows && typeof rows === 'object' && Object.keys(rows).length <= MAX_MODELS_PER_PROVIDER
    && Object.entries(rows).every(([id, row]) => validModelId(provider as AiProviderKind, id) && saneMicros(row?.inputMicrosPerMTok) && saneMicros(row?.outputMicrosPerMTok)));
}

/**
 * The list this release ships (#1465), as `scripts/update_price_list.py` fetched it on the build day: what a server without internet
 * prices with, and what the worker stores when the database has no list or an older one.
 */
export function shippedPriceList(): AiPriceList {
  const list = parsePriceList(SHIPPED_PRICE_FILE.entries, SHIPPED_PRICE_FILE.fetchedOn, SHIPPED_PRICE_FILE.source);
  if (!list) throw new Error('The shipped price list is not a price list: run scripts/update_price_list.py again');
  return list;
}
