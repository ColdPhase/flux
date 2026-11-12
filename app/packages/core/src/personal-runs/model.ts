import {
  ASSISTANT_PLAN_MODEL_PATTERN, ASSISTANT_PLAN_MODELS, AI_MODEL_ID_PATTERN, AI_PROVIDERS,
  assistantApiModels, assistantApiPrice, assistantModelName,
  type AiConnectionRef, type AssistantModelAccount, type AssistantModelListing, type AssistantModelChoice, type AssistantModelGroup, type AssistantModelOption, type AssistantModelPick,
} from '@flux/contracts';
import type { PersonalConnection, PersonalRuntimeClient } from './ports.js';

// The model of an agent (F-027 AST-11, #596; Connect AI #854): what the owner may choose on each of their connections, and
// how the choice reaches a run. Pure functions; the use cases in service.ts decide who may ask.

/** The provenance label of a run on a plan when no model id reached it (the CLI's own default). */
export const RUNTIME_MODEL = 'claude-code';
export const CODEX_RUNTIME_MODEL = 'codex';

/** Whether `model` is a well-formed id for the account's engine, before it is compared with the list. */
export const isModelId = (value: unknown, engine: 'runtime' | 'server'): value is string =>
  typeof value === 'string' && (engine === 'runtime' ? ASSISTANT_PLAN_MODEL_PATTERN : AI_MODEL_ID_PATTERN).test(value);

/** What a subscription's list holds and which model is preselected. */
export function planModels(client: PersonalRuntimeClient) {
  const plan = ASSISTANT_PLAN_MODELS[client];
  return {
    account: plan.account, company: plan.company, plan: plan.plan, default: plan.default,
    options: plan.models.map((model): AssistantModelOption => ({ ...model, callsTools: true })),
  };
}

export interface ModelAccount {
  engine: 'runtime' | 'server' | null;
  account: AssistantModelAccount | null;
  company: string | null;
  /** "Claude plan", "ChatGPT plan" or "API key's provider", for "Your Claude plan doesn't offer that model". */
  plan: string;
  default: string;
  options: AssistantModelOption[];
  /** An API key listed with its key (#1218): how fresh its list is. */
  listing?: AssistantModelListing;
}

export const NO_MODEL_ACCOUNT: ModelAccount = { engine: null, account: null, company: null, plan: 'account', default: '', options: [] };

/** The list of a signed-in subscription. */
export function runtimeModelAccount(client: PersonalRuntimeClient): ModelAccount {
  const plan = planModels(client);
  return { engine: 'runtime', account: plan.account, company: plan.company, plan: plan.plan, default: plan.default, options: plan.options };
}

/** Providers whose models Flux reads with the owner's key (#1218); the others list without one, in the key form. */
export const KEY_LISTED = new Set(['anthropic', 'openai', 'gemini']);

/** How fresh a key's list is, for the picker's "couldn't read the list · Try again" (#1218). */
export function keyListing(connection: Pick<PersonalConnection, 'provider' | 'models'>): AssistantModelListing | undefined {
  if (!KEY_LISTED.has(connection.provider)) return undefined;
  const models = connection.models;
  const checkedOn = models?.listedAt ? models.listedAt.toISOString().slice(0, 10) : null;
  if (!models?.status) return { state: 'not_listed', checkedOn };
  if (models.status === 'listed') return { state: 'listed', checkedOn };
  return { state: models.status === 'key_refused' ? 'key_refused' : 'unavailable', checkedOn };
}

/** The list of the owner's API key connection (F-020 PROV-1, CA-2): the provider's models by family, or its priced ones before a list. */
export function apiModelAccount(connection: Pick<PersonalConnection, 'provider' | 'model' | 'toolCalling' | 'price' | 'models'>): ModelAccount {
  const listing = keyListing(connection);
  return {
    engine: 'server', account: 'api_key', company: AI_PROVIDERS[connection.provider].label, plan: "API key's provider",
    default: connection.model, options: assistantApiModels(connection), ...(listing ? { listing } : {}),
  };
}

/** One of the owner's usable connections with what it offers: a plan's CLI, or an API key (its connection). */
export interface ConnectionModels {
  ref: AiConnectionRef;
  /** "Claude plan", "ChatGPT plan" or the key's name. */
  label: string;
  account: ModelAccount;
  /** The API key; null on a plan. */
  connection: PersonalConnection | null;
  /** When it was made: the first is Connect AI's default (#854). */
  since: number;
}

/** The picker's groups, in the order the connections were made. */
export function modelGroups(connections: readonly ConnectionModels[]): AssistantModelGroup[] {
  return [...connections].sort((a, b) => a.since - b.since).map((item) => ({
    connection: item.ref, account: item.account.account!, label: item.label, company: item.account.company ?? item.label, options: item.account.options,
    ...(item.account.listing ? { listing: item.account.listing } : {}),
  }));
}

/** Connect AI's default for a new agent (#854): the connection made first, at its default model. */
export function defaultPick(connections: readonly ConnectionModels[]): AssistantModelPick | null {
  const first = [...connections].sort((a, b) => a.since - b.since)[0];
  return first && first.account.default ? { connection: first.ref, model: first.account.default } : null;
}

/** The choice as the owner sees it: every connection's models, the model in force and Connect AI's default. */
export function modelChoice(connections: readonly ConnectionModels[], current: AssistantModelPick | null, saved: boolean): AssistantModelChoice {
  return { current: saved ? current : null, default: defaultPick(connections), groups: modelGroups(connections), saved };
}

/** The name of a model, for "It is still Sonnet." */
export const modelNameOf = (pick: Pick<AssistantModelPick, 'model'>) => assistantModelName(pick.model);

/** Whether the key's provider no longer offers `model` (#1218): it was in an earlier list and a later one lacks it. */
export const modelRetired = (connection: Pick<PersonalConnection, 'models'>, model: string | null): boolean =>
  !!model && !!connection.models?.retired.includes(model);

/**
 * The owner's connection on the model they chose (F-020 PROV-3): the connection's own model and price when the model is
 * its own, or another model of the same key at Flux's table price or the price its owner entered for it (#1218); null when
 * there is neither, so nothing can be reserved. A model the owner marked as unable to call tools applies to the connection's
 * own model only.
 */
export function connectionOnModel(connection: PersonalConnection, model: string | null): PersonalConnection | null {
  if (!model || model === connection.model) return connection;
  const price = assistantApiPrice(connection.provider, model, connection.models?.prices);
  if (!price) return null;
  const other: PersonalConnection = { ...connection, model, price };
  delete other.toolCalling;
  return other;
}

/**
 * The model a run on a plan is started with: the owner's choice, or nothing (the CLI's own default) when the run was
 * recorded with the engine's label. Only an id the protocol accepts ever becomes a flag value.
 */
export function runtimeModelFlag(model: string): string | undefined {
  return model === RUNTIME_MODEL || model === CODEX_RUNTIME_MODEL || !ASSISTANT_PLAN_MODEL_PATTERN.test(model) ? undefined : model;
}
