import { AI_LISTED_PRICE_PROVIDERS, AI_PRICE_LIST_PROVIDERS, AI_PRICE_LIST_URL, AI_PRICE_MAX_MICROS_PER_MTOK, AI_PRICE_MAX_TIERS, AI_PROVIDERS,
  type AiModelList, type AiModelPrices, type AiPriceList, type AiPriceTier, type AiProviderKind, type AiRate } from '@flux/contracts';
import { validModelId } from './validation.js';
import { SHIPPED_PRICE_FILE } from './price-list-snapshot.js';

// The price lists (#1465). Anthropic's, OpenAI's and Gemini's prices are read every day from LiteLLM's maintained model price file
// (AI_PRICE_LIST_URL) and shipped with each release as fetched on its build day; OpenRouter's are read from OpenRouter's own model
// list, what an OpenRouter key pays. This is the one place that turns either into Flux's prices; anything it cannot vouch for is left
// out (its owner then enters the price).

/** The most the fetched file may weigh: it was 4.1 MB on 2026-11-13; a larger answer is refused and the last good list kept. */
export const PRICE_LIST_MAX_BYTES = 16_000_000;
/** How long the fetch may take, end to end. */
export const PRICE_LIST_TIMEOUT_MS = 30_000;
/** The most models one provider may have in a list; the file had 24 Anthropic, 126 OpenAI and 47 Gemini text models on 2026-11-13. */
const MAX_MODELS_PER_PROVIDER = 2_000;
/** LiteLLM's modes of the models Flux calls: Messages and Chat Completions (`chat`) and OpenAI's Responses API (`responses`). */
const TEXT_MODES = new Set(['chat', 'responses']);
/** The prompt-length tiers LiteLLM writes as `input_cost_per_token_above_<N>k_tokens`, without a batch, flex or priority suffix. */
const TIER = /^(input|output)_cost_per_token_above_(\d{1,4})k_tokens$/;
/** Where OpenRouter's prices come from: its model list, read without a key. */
export const OPENROUTER_PRICE_SOURCE = `${AI_PROVIDERS.openrouter.baseUrl}/models`;

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

/**
 * The entry's standard price and its long-prompt prices, or null when any of its values is not a sane price. LiteLLM's "above 100k
 * tokens" is the provider's "over 100,000 tokens": a prompt of 100,001 tokens or more. A tier without its output (or input) price keeps
 * the standard one.
 */
function entryPrice(entry: Record<string, unknown>): AiRate | null {
  const input = microsPerMTok(entry.input_cost_per_token);
  const output = microsPerMTok(entry.output_cost_per_token);
  if (input === null || output === null) return null;
  const tiers = new Map<number, { input: number; output: number }>();
  for (const [field, value] of Object.entries(entry)) {
    const tier = TIER.exec(field);
    if (!tier) continue;
    const micros = microsPerMTok(value);
    if (micros === null) return null;
    const from = Number(tier[2]) * 1_000 + 1;
    const row = tiers.get(from) ?? { input, output };
    if (tier[1] === 'input') row.input = micros; else row.output = micros;
    tiers.set(from, row);
  }
  if (tiers.size > AI_PRICE_MAX_TIERS) return null;
  const sorted: AiPriceTier[] = [...tiers].sort(([a], [b]) => a - b)
    .map(([fromTokens, row]) => ({ fromTokens, inputMicrosPerMTok: row.input, outputMicrosPerMTok: row.output }));
  return { inputMicrosPerMTok: input, outputMicrosPerMTok: output, ...(sorted.length ? { tiers: sorted } : {}) };
}

const byId = <T>(rows: Record<string, T>) => Object.fromEntries(Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Flux's price list from LiteLLM's file, or null when the file is not one: not an object, or without a single priced model of any of
 * Anthropic, OpenAI and Gemini (a truncated or replaced file is refused whole, and the last good list stays). An entry is taken only
 * when it names one of those providers (`litellm_provider`), is a text model Flux calls (`mode` chat or responses), has a model id Flux
 * accepts, and its standard and long-prompt prices are numbers from 0 to {@link AI_PRICE_MAX_MICROS_PER_MTOK}. Batch, flex, priority,
 * regional and cache prices are not read.
 */
export function parsePriceList(raw: unknown, fetchedOn: string, source: string = AI_PRICE_LIST_URL): AiPriceList | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !/^\d{4}-\d{2}-\d{2}$/.test(fetchedOn)) return null;
  const prices: Partial<Record<AiProviderKind, Record<string, AiRate>>> = {};
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
  for (const provider of AI_PRICE_LIST_PROVIDERS) sorted[provider] = byId(prices[provider]!);
  return { fetchedOn, source, prices: sorted };
}

/**
 * OpenRouter's prices from its own model list (#1465: the price of the place the key pays), or null when the list was not read or
 * prices no model. A model with a variable price ("-1") has none and is priced by its owner.
 */
export function openRouterPriceList(list: AiModelList, source: string = OPENROUTER_PRICE_SOURCE): AiPriceList | null {
  if (list.provider !== 'openrouter' || list.status !== 'listed') return null;
  const rows: Record<string, AiRate> = {};
  for (const model of list.models) if (model.price && validModelId('openrouter', model.id)) rows[model.id] = model.price;
  const candidate: AiPriceList = { fetchedOn: list.checkedOn, source, prices: { openrouter: byId(rows) } };
  return Object.keys(rows).length && isPriceList(candidate) ? candidate : null;
}

const saneMicros = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= AI_PRICE_MAX_MICROS_PER_MTOK;
const saneRate = (row: AiRate | undefined) => !!row && saneMicros(row.inputMicrosPerMTok) && saneMicros(row.outputMicrosPerMTok)
  && (row.tiers === undefined || (Array.isArray(row.tiers) && row.tiers.length <= AI_PRICE_MAX_TIERS && row.tiers.every((tier) =>
    Number.isSafeInteger(tier?.fromTokens) && tier.fromTokens > 0 && saneMicros(tier.inputMicrosPerMTok) && saneMicros(tier.outputMicrosPerMTok))));

/** Whether a stored, shipped or read list is a well-formed price list: it is checked again before it is stored or used. */
export function isPriceList(value: unknown): value is AiPriceList {
  if (!value || typeof value !== 'object') return false;
  const list = value as Partial<AiPriceList>;
  if (typeof list.fetchedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(list.fetchedOn) || typeof list.source !== 'string'
    || !list.prices || typeof list.prices !== 'object') return false;
  return Object.entries(list.prices).every(([provider, rows]) => (AI_LISTED_PRICE_PROVIDERS as readonly string[]).includes(provider)
    && !!rows && typeof rows === 'object' && Object.keys(rows).length <= MAX_MODELS_PER_PROVIDER
    && Object.entries(rows).every(([id, row]) => validModelId(provider as AiProviderKind, id) && saneRate(row)));
}

/** A price Flux did not take from a refreshed list (#1270): the model, what Flux keeps and what the list offered. */
export interface HeldPrice {
  provider: AiProviderKind;
  model: string;
  /** The price Flux knew and keeps, or null when it knew none and the model is left out (its owner is asked for the price). */
  kept: AiRate | null;
  /** What the refreshed list offered. */
  offered: AiRate;
}

/** Whether a price fell to 0, or to a tenth or less of what Flux knows; a known 0 cannot fall. */
const fallsTooFar = (known: number, offered: number) => known > 0 && offered * 10 <= known;
/** OpenRouter's own naming of a model it bills nothing for. */
const openRouterFree = (provider: AiProviderKind, model: string) => provider === 'openrouter' && model.endsWith(':free');
const own = <T>(rows: Readonly<Record<string, T>> | undefined, id: string): T | undefined =>
  rows && Object.prototype.hasOwnProperty.call(rows, id) ? rows[id] : undefined;

/**
 * A refreshed list with what must not move at once held back (#1270). A list comes from a third party's repository (LiteLLM's `main`
 * branch) or OpenRouter's API and sets what a key's daily budget counts, so a wrong or poisoned file must not lower it without bound:
 * - a model Flux knows (in the list it has stored, else the shipped one) keeps its known price when the refreshed input or output
 *   price is 0 or a tenth or less of the known one; increases and smaller decreases apply;
 * - a model Flux does not know is never given a price of 0 (input or output): it is left out and its owner is asked, so a free
 *   model is free only when a stored or shipped list already had it at 0 (Gemini's free models);
 * - except an OpenRouter id ending in `:free`: OpenRouter bills that key and names the model free, so its own price is taken as
 *   listed, 0 included, on the first read too (coordinator decision, #1499).
 * `held` names each of them, for the log. The candidate is not changed.
 */
export function guardPriceList(candidate: AiPriceList, stored: AiPriceList | null | undefined, shipped: AiPriceList | null | undefined): { list: AiPriceList; held: HeldPrice[] } {
  const held: HeldPrice[] = [];
  const prices: Partial<Record<AiProviderKind, AiModelPrices>> = {};
  for (const [provider, rows] of Object.entries(candidate.prices) as [AiProviderKind, AiModelPrices][]) {
    const kept: [string, AiRate][] = [];
    for (const [model, offered] of Object.entries(rows)) {
      const known = own(stored?.prices[provider], model) ?? own(shipped?.prices[provider], model);
      if (openRouterFree(provider, model)) kept.push([model, offered]);
      else if (!known) {
        if (offered.inputMicrosPerMTok === 0 || offered.outputMicrosPerMTok === 0) held.push({ provider, model, kept: null, offered });
        else kept.push([model, offered]);
      } else if (fallsTooFar(known.inputMicrosPerMTok, offered.inputMicrosPerMTok) || fallsTooFar(known.outputMicrosPerMTok, offered.outputMicrosPerMTok)) {
        held.push({ provider, model, kept: known, offered });
        kept.push([model, known]);
      } else kept.push([model, offered]);
    }
    prices[provider] = Object.fromEntries(kept);
  }
  return { list: { ...candidate, prices }, held };
}

/** The most held prices one refresh writes to the log; a file that moves every price must not fill it. */
const MAX_HELD_LOGGED = 50;

/**
 * The log lines of a refresh's held prices (#1270), one object per model with both prices in micro-dollars per 1M tokens and no
 * secret in them, then one with the count that was not listed.
 */
export function heldPriceLog(list: string, held: readonly HeldPrice[]): Record<string, unknown>[] {
  const rate = (price: AiRate | null) => (price ? { inputMicrosPerMTok: price.inputMicrosPerMTok, outputMicrosPerMTok: price.outputMicrosPerMTok } : null);
  const lines = held.slice(0, MAX_HELD_LOGGED).map((row) => ({ event: 'price_list_held', list, provider: row.provider, model: row.model,
    action: row.kept ? 'kept_known_price' : 'left_out_free_price', kept: rate(row.kept), offered: rate(row.offered) }));
  return held.length > MAX_HELD_LOGGED ? [...lines, { event: 'price_list_held', list, more: held.length - MAX_HELD_LOGGED }] : lines;
}

/** The two stored lists' repository, as {@link storeGuardedPriceList} needs it. */
export interface PriceListStore {
  read(list: 'litellm' | 'openrouter'): Promise<AiPriceList | null>;
  store(list: 'litellm' | 'openrouter', value: AiPriceList): Promise<boolean>;
}

/**
 * Stores a refreshed list after {@link guardPriceList} (#1270): LiteLLM's against the stored list and the shipped one, OpenRouter's
 * against the stored one. Returns what was stored (the guarded list, also when a newer one made the store a no-op), whether it was
 * stored, and the prices held back, which the caller logs with {@link heldPriceLog}.
 */
export async function storeGuardedPriceList(store: PriceListStore, name: 'litellm' | 'openrouter', candidate: AiPriceList): Promise<{ list: AiPriceList; stored: boolean; held: HeldPrice[] }> {
  const { list, held } = guardPriceList(candidate, await store.read(name), name === 'litellm' ? shippedPriceList() : null);
  return { list, stored: await store.store(name, list), held };
}

/**
 * The list this release ships (#1465), as `scripts/update_price_list.py` fetched it on the build day: what a server without internet
 * prices with, and what the migrator stores when the database has no list or an older one.
 */
export function shippedPriceList(): AiPriceList {
  const list = parsePriceList(SHIPPED_PRICE_FILE.entries, SHIPPED_PRICE_FILE.fetchedOn, SHIPPED_PRICE_FILE.source);
  if (!list) throw new Error('The shipped price list is not a price list: run scripts/update_price_list.py again');
  return list;
}
