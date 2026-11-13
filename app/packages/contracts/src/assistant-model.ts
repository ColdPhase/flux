import { AI_PROVIDERS, aiModelCallsTools, aiModelSeesPictures, tablePrice, type AiPrice, type AiProviderKind } from './ai-providers.js';
import { aiModelFamily, groupModelsByFamily } from './ai-model-families.js';
import type { AiConnectionRef } from './personal-runs.js';

// The model of each agent (F-027 AST-11, #596; Connect AI #854): picked from any of the person's connections, with the
// picker grouped by connection ("Claude plan: Opus · Sonnet · Haiku"). Connect AI sets the default: the connection the
// person made first, at its default model. The server accepts only a model in a connection's list. Nothing here is an
// id a person types. A plan's list is the signed-in CLI's own (#1332) and an API key's the provider's (#1218); Flux holds none.

/** `GET` the caller's own choices: every connection's models and Connect AI's default; `PUT` changes the first agent's model (the ask bar). An agent's own model is `PATCH /api/v1/my-agents/:id`. */
export const ASSISTANT_MODEL_PATH = '/api/v1/personal-assistant/model';
/** What a plan model id may look like before it reaches a command template (never a flag, a path or a space). */
export const ASSISTANT_PLAN_MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export interface AssistantModelOption {
  /** What Flux stores and passes on: `sonnet`, `gpt-6.1-sol`, or an API model id. Never shown to a person. */
  id: string;
  /** "Sonnet", "GPT-6.1 Sol". */
  name: string;
  /** One short phrase, or the price of an API model. */
  note: string;
  /** False: the model can answer but can't make changes (AST-8.3). */
  callsTools: boolean;
  /** False: the model can't see pictures, so its agent sees attached files only by name (#1217, C-59). Absent: it sees them. */
  seesPictures?: boolean;
  /** An API key's model: the family the picker groups it under ("Opus", "Sol"), newest family first (#1218). */
  family?: string;
  /**
   * False: Flux doesn't know this API model's price yet, so it can be chosen only after its owner enters one (PROV-3, #1218).
   * Absent on a plan's models, which have no price.
   */
  priced?: boolean;
  /** True: the provider no longer offers it; agents on it are paused until another model is chosen (#1218). */
  retired?: boolean;
}

/**
 * How fresh an API key's list is (#1218). `listed`: read from the provider (`checkedOn`). `unavailable`: the last reading failed, so
 * the list may be old or Flux's own; Try again reads it again. `key_refused`: the provider refused the key at the last reading.
 * `not_listed`: never read (a key added before v0.2.1, or a provider listed without a key).
 */
export interface AssistantModelListing {
  state: 'listed' | 'unavailable' | 'key_refused' | 'not_listed';
  /** When the provider's list now shown was read (YYYY-MM-DD); null when none was. */
  checkedOn: string | null;
}

/** `claude_plan` and `chatgpt_plan`: the owner's subscription through its CLI; `api_key`: the owner's own key. */
export type AssistantModelAccount = 'claude_plan' | 'chatgpt_plan' | 'api_key';

/** One connection's models in the picker: "Claude plan: Opus · Sonnet · Haiku". */
export interface AssistantModelGroup {
  connection: AiConnectionRef;
  account: AssistantModelAccount;
  /** "Claude plan", "ChatGPT plan" or the API key's name. */
  label: string;
  /** "Claude", "ChatGPT" or the API provider's name, for "Your Claude plan didn't accept Opus". */
  company: string;
  options: AssistantModelOption[];
  /** An API key whose provider lists its models with the key (#1218); absent on a plan. */
  listing?: AssistantModelListing;
}

/** A model of one connection. */
export interface AssistantModelPick { connection: AiConnectionRef; model: string }

/** What the caller may choose for an agent's model, from every connection they have. Never another person's. */
export interface AssistantModelChoice {
  /** The model of the caller's first agent (Assistant); null while they have none. */
  current: AssistantModelPick | null;
  /** Connect AI's default for a new agent: the connection made first, at its default model; null without a connection. */
  default: AssistantModelPick | null;
  /** One group per usable connection, in the order they were made. */
  groups: AssistantModelGroup[];
  /** The caller has an agent, so `current` is its stored model. */
  saved: boolean;
}

/** Everything a person may read about a model: the names of the models Flux knows. */
const NAMES: Record<string, string> = {
  sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku',
  'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6-astra': 'GPT-6 Astra', 'gpt-6-luna': 'GPT-6 Luna', 'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6.1-terra': 'GPT-6.1 Terra',
  'claude-opus-5-5': 'Opus 5.5', 'claude-opus-5': 'Opus 5', 'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5', 'claude-fable-5-2': 'Fable 5.2', 'claude-fable-5-1': 'Fable 5.1',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite', 'gemini-3.1-pro-preview': 'Gemini 3.1 Pro', 'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
};
/** The short name of a model, or its id for one Flux does not know (an owner's own endpoint or model). */
export const assistantModelName = (model: string) => (Object.prototype.hasOwnProperty.call(NAMES, model) ? NAMES[model]! : model);

/** What names each subscription: its connection kind, who it is from and what Connect AI calls it. Its models are not here: the signed-in CLI lists them (#1332). */
export const ASSISTANT_PLANS: Record<'claude_code' | 'codex', { account: AssistantModelAccount; company: string; plan: string }> = {
  claude_code: { account: 'claude_plan', company: 'Claude', plan: 'Claude plan' },
  codex: { account: 'chatgpt_plan', company: 'ChatGPT', plan: 'ChatGPT plan' },
};

/** One model of a plan's stored list, as the runtime's supervisor reduced the CLI's own (#1332): the id the CLI's model option takes, its name and note. */
export interface PlanModelEntry { id: string; name: string; note: string; default: boolean; seesPictures: boolean }

/**
 * What Flux knows of a plan's models (#1332, CA-2): the last list the signed-in CLI gave, the models an earlier list had that the latest lacks
 * (the plan stopped offering them) and whether the last reading worked. `unavailable`: the CLI could not be read, so the list shown is the last
 * known one. There is no list in Flux: before the first reading the plan has no models.
 */
export interface PlanModels { listed: readonly PlanModelEntry[]; retired: readonly { id: string; name: string }[]; state: 'listed' | 'unavailable'; checkedOn: string }

/** Fable can bill usage credits that Flux cannot see (founder direction, 2026-11-12, #1332): no plan offers it, whatever its CLI lists. */
export const isFableModel = (id: string) => /fable/i.test(id);

/**
 * A plan's choices: exactly what its CLI listed, in the CLI's order and under the names it gave, without Fable and an id a command could
 * misread; then the models it stopped offering, as `retired` (an agent on one is paused, CA-2). The default is the CLI's own, else the first
 * listed. Nothing here is a model written into Flux: without a reading there are no options and no default.
 */
export function assistantPlanModels(models: PlanModels | null | undefined): { options: AssistantModelOption[]; default: string } {
  const listed = (models?.listed ?? []).filter((entry) => ASSISTANT_PLAN_MODEL_PATTERN.test(entry.id) && !isFableModel(entry.id) && !isFableModel(entry.name));
  const options: AssistantModelOption[] = listed.map((entry) => ({
    id: entry.id, name: entry.name, note: entry.note, callsTools: true, ...(entry.seesPictures ? {} : { seesPictures: false }),
  }));
  const shown = new Set(listed.map((entry) => entry.id));
  for (const { id, name } of models?.retired ?? []) {
    if (!shown.has(id) && ASSISTANT_PLAN_MODEL_PATTERN.test(id) && !isFableModel(id)) options.push({ id, name: name || assistantModelName(id), note: '', callsTools: true, retired: true });
  }
  return { options, default: (listed.find((entry) => entry.default) ?? listed[0])?.id ?? '' };
}

const dollars = (micros: number) => {
  const value = micros / 1_000_000;
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
};
const priceNote = (price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>) =>
  `Input ${dollars(price.inputMicrosPerMTok)}, output ${dollars(price.outputMicrosPerMTok)} per 1M tokens`;

/** An owner's price per 1M tokens for one model of their key (PROV-3, #1218). */
export type ApiKeyModelPrices = Readonly<Record<string, { inputMicrosPerMTok: number; outputMicrosPerMTok: number }>>;

/** What an API key knows of its models (#1218): the provider's last list, the owner's prices and the models no longer offered. */
export interface ApiKeyModels {
  /** Null while the provider has not listed them yet. */
  listed: readonly { id: string; name: string | null; family: string; createdAt: string | null }[] | null;
  prices: ApiKeyModelPrices;
  retired: readonly string[];
}

/** "Flux doesn't know this model's price yet" (#1218): the note of a listed model without one. */
export const PRICE_UNKNOWN_NOTE = 'Price unknown, enter it';

/**
 * The list for the owner's API key connection (F-020 PROV-1, CA-2). It comes only from the provider's own list, read with the key
 * (founder direction, Hubert, 2026-11-12, #1218): its chat models by family, newest first, each with its price or "Price unknown,
 * enter it", and the key's own model where the list doesn't have it ("Other model id…", or one no longer offered). Flux's price
 * table only prices a listed model; it never adds one. Until the provider's list is read, the key offers only its own model.
 * A model of an earlier list that the provider stopped offering stays in the list as `retired` (CA-2: "no longer offered by
 * Anthropic"), so an agent on it shows why it is paused, and a stale pick of it says so.
 * A listed model is named as its provider names it ("Claude Opus 5.5"), on every surface; Flux's short names serve a model the
 * list does not name (the key's own, a retired one).
 */
export function assistantApiModels(connection: { provider: AiProviderKind; model: string; toolCalling?: boolean | undefined; price?: AiPrice | null;
  models?: ApiKeyModels | null | undefined }): AssistantModelOption[] {
  const { provider } = connection;
  const prices = connection.models?.prices ?? {};
  const retired = new Set(connection.models?.retired ?? []);
  const option = (id: string, name: string | null, family: string): AssistantModelOption => {
    const own = id === connection.model;
    const price = own && connection.price !== undefined ? connection.price : assistantApiPrice(provider, id, prices);
    return {
      id, name: name ?? assistantModelName(id), note: price ? priceNote(price) : PRICE_UNKNOWN_NOTE,
      callsTools: (!own || connection.toolCalling !== false) && aiModelCallsTools(provider, id),
      ...(aiModelSeesPictures(provider, id) ? {} : { seesPictures: false }),
      family, priced: !!price, ...(retired.has(id) ? { retired: true } : {}),
    };
  };
  const options = groupModelsByFamily(connection.models?.listed ?? []).flatMap((group) => group.models.map((model) => option(model.id, model.name, group.family)));
  // The key's own model stays shown when the list lacks it: an id the owner typed, one the provider no longer offers, or a key
  // whose list has not been read yet. So does every other model the provider stopped offering.
  const shown = new Set(options.map((entry) => entry.id));
  const own = shown.has(connection.model) ? [] : [option(connection.model, null, aiModelFamily(provider, connection.model))];
  const gone = [...retired].filter((id) => id !== connection.model && !shown.has(id)).sort().map((id) => option(id, null, aiModelFamily(provider, id)));
  return [...own, ...options, ...gone];
}

/**
 * The price of an API model the owner may choose besides the connection's own: Flux's table, else the price its owner entered for
 * it on this key (#1218); null when there is neither.
 */
export function assistantApiPrice(provider: AiProviderKind, model: string, prices: ApiKeyModelPrices = {}): AiPrice | null {
  const row = tablePrice(provider, model);
  if (row) return { inputMicrosPerMTok: row.inputMicrosPerMTok, outputMicrosPerMTok: row.outputMicrosPerMTok, source: 'table', checkedOn: row.checkedOn };
  const owner = Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined;
  return owner ? { inputMicrosPerMTok: owner.inputMicrosPerMTok, outputMicrosPerMTok: owner.outputMicrosPerMTok, source: 'owner', checkedOn: null } : null;
}

/** "no longer offered by Claude" (#1218, #1332): a plan names its company, an API key its provider. */
export const noLongerOfferedBy = (company: string) => `no longer offered by ${company}`;
/** "no longer offered by Anthropic" (#1218). */
export const noLongerOffered = (provider: AiProviderKind) => noLongerOfferedBy(AI_PROVIDERS[provider].label);
