import { aiModelCallsTools, aiModelSeesPictures, tablePrice, type AiPrice, type AiProviderKind } from './ai-providers.js';
import type { AiConnectionRef } from './personal-runs.js';

// The model of each agent (F-027 AST-11, #596; Connect AI #854): picked from any of the person's connections, with the
// picker grouped by connection ("Claude plan: Opus · Sonnet · Haiku"). Connect AI sets the default: the connection the
// person made first, at its default model. The server accepts only a model in a connection's list. Nothing here is an
// id a person types.

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
  /** False: the model can't see pictures, so its agent sees attached files only by name (#1217, C-58). Absent: it sees them. */
  seesPictures?: boolean;
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
  'claude-sonnet-5': 'Sonnet 5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5', 'claude-fable-5-1': 'Fable 5.1',
  'gemini-3.5-flash': 'Gemini 3.5 Flash', 'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite', 'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
};
/** The short name of a model, or its id for one Flux does not know (an owner's own endpoint or model). */
export const assistantModelName = (model: string) => NAMES[model] ?? model;

/**
 * The models of a subscription, from the vendor's own pages, read 2026-10-17 (AST-11): Claude Code's
 * `--model` aliases, and Codex's `-m` ids. Fable is not listed: it can bill to usage credits that Flux cannot see.
 */
export const ASSISTANT_PLAN_MODELS: Record<'claude_code' | 'codex', { account: AssistantModelAccount; company: string; plan: string; default: string; models: readonly Omit<AssistantModelOption, 'callsTools'>[] }> = {
  claude_code: {
    account: 'claude_plan', company: 'Claude', plan: 'Claude plan', default: 'sonnet',
    models: [
      { id: 'sonnet', name: 'Sonnet', note: 'Everyday work' },
      { id: 'opus', name: 'Opus', note: 'Harder requests' },
      { id: 'haiku', name: 'Haiku', note: 'Quick, simple requests' },
    ],
  },
  codex: {
    account: 'chatgpt_plan', company: 'ChatGPT', plan: 'ChatGPT plan', default: 'gpt-6.1-sol',
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', note: 'Everyday work' },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', note: 'The hardest requests' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', note: 'Quick, simple requests' },
    ],
  },
};

/**
 * Models offered for a provider's API key besides the connection's own: only ones with a price in Flux's table. The first
 * is the key's default model when its owner names none (#854: the key form asks only for the key and its daily budget).
 */
const API_MODELS: Partial<Record<AiProviderKind, readonly string[]>> = {
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
  openai: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
  gemini: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
};

/** The default model of a new key of a named provider, or null where the owner must name one (OpenRouter, an own endpoint). */
export const apiKeyDefaultModel = (provider: AiProviderKind): string | null => API_MODELS[provider]?.[0] ?? null;

const dollars = (micros: number) => {
  const value = micros / 1_000_000;
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
};
const priceNote = (price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>) =>
  `Input ${dollars(price.inputMicrosPerMTok)}, output ${dollars(price.outputMicrosPerMTok)} per 1M tokens`;

/** The list for the owner's API key connection (F-020 PROV-1): its own model first, then the provider's priced models. */
export function assistantApiModels(connection: { provider: AiProviderKind; model: string; toolCalling?: boolean | undefined }): AssistantModelOption[] {
  const own: AssistantModelOption = {
    id: connection.model, name: assistantModelName(connection.model), note: "Your connection's model",
    callsTools: connection.toolCalling !== false && aiModelCallsTools(connection.provider, connection.model),
    ...(aiModelSeesPictures(connection.provider, connection.model) ? {} : { seesPictures: false }),
  };
  const others = (API_MODELS[connection.provider] ?? []).filter((id) => id !== connection.model).flatMap((id) => {
    const row = tablePrice(connection.provider, id);
    return row ? [{ id, name: assistantModelName(id), note: priceNote(row), callsTools: aiModelCallsTools(connection.provider, id),
      ...(aiModelSeesPictures(connection.provider, id) ? {} : { seesPictures: false }) }] : [];
  });
  return [own, ...others];
}

/** The table price of an API model the owner may choose besides the connection's own, or null when there is none. */
export function assistantApiPrice(provider: AiProviderKind, model: string): AiPrice | null {
  const row = tablePrice(provider, model);
  return row ? { inputMicrosPerMTok: row.inputMicrosPerMTok, outputMicrosPerMTok: row.outputMicrosPerMTok, source: 'table', checkedOn: row.checkedOn } : null;
}
