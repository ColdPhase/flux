import {
  ASSISTANT_PLAN_DEFAULT, ASSISTANT_PLAN_DEFAULT_OPTION, ASSISTANT_PLAN_MODEL_PATTERN, ASSISTANT_PLAN_MODELS, AI_MODEL_ID_PATTERN, AI_PROVIDERS,
  assistantApiModels, assistantApiPrice, assistantModelName,
  type AssistantModelChoice, type AssistantModelOption,
} from '@flux/contracts';
import type { PersonalConnection, PersonalRuntimeClient } from './ports.js';

// The assistant's model (F-027 AST-11, #596): what the owner may choose on their account, and how the choice reaches
// a run. Pure functions; the use cases in service.ts decide who may ask.

/** The provenance label of a run on a plan whose owner chose no model (kept as before AST-11). */
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
  account: AssistantModelChoice['account'];
  company: string | null;
  /** "Claude plan", "ChatGPT plan" or "API key's provider", for "Your Claude plan doesn't offer that model". */
  plan: string;
  default: string;
  options: AssistantModelOption[];
}

export const NO_MODEL_ACCOUNT: ModelAccount = { engine: null, account: null, company: null, plan: 'account', default: '', options: [] };

/** The list of a signed-in subscription. */
export function runtimeModelAccount(client: PersonalRuntimeClient): ModelAccount {
  const plan = planModels(client);
  return { engine: 'runtime', account: plan.account, company: plan.company, plan: plan.plan, default: plan.default, options: plan.options };
}

/** The list of the owner's API key connection (F-020 PROV-1): its own model first, then the provider's priced models. */
export function apiModelAccount(connection: Pick<PersonalConnection, 'provider' | 'model' | 'toolCalling'>): ModelAccount {
  return {
    engine: 'server', account: 'api_key', company: AI_PROVIDERS[connection.provider].label, plan: "API key's provider",
    default: connection.model, options: assistantApiModels(connection),
  };
}

/** The choice as the owner sees it. A legacy assistant (no model stored on a plan) sees one extra, ticked row. */
export function modelChoice(account: ModelAccount, stored: string | null, saved: boolean): AssistantModelChoice {
  const legacy = account.engine === 'runtime' && saved && stored === null;
  const current = saved ? (stored ?? (account.engine === 'runtime' ? ASSISTANT_PLAN_DEFAULT : account.default)) : account.default;
  return {
    engine: account.engine, account: account.account, company: account.company, current, default: account.default, saved,
    options: legacy ? [ASSISTANT_PLAN_DEFAULT_OPTION, ...account.options] : account.options,
  };
}

/** The name of the model in force, for "It is still Sonnet." */
export const modelNameOf = (choice: Pick<AssistantModelChoice, 'current'>) =>
  choice.current === ASSISTANT_PLAN_DEFAULT ? ASSISTANT_PLAN_DEFAULT_OPTION.name : assistantModelName(choice.current);

/**
 * The owner's connection on the model they chose (F-020 PROV-3): the connection's own model and price when the model is
 * its own, or the provider's table price for another model of the same provider; null when Flux has no price for it, so
 * nothing can be reserved. A model the owner marked as unable to call tools applies to the connection's own model only.
 */
export function connectionOnModel(connection: PersonalConnection, model: string | null): PersonalConnection | null {
  if (!model || model === connection.model) return connection;
  const price = assistantApiPrice(connection.provider, model);
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
  return model === RUNTIME_MODEL || model === CODEX_RUNTIME_MODEL || model === ASSISTANT_PLAN_DEFAULT || !ASSISTANT_PLAN_MODEL_PATTERN.test(model) ? undefined : model;
}
