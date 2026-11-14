import { createHash, randomUUID } from 'node:crypto';
import { AI_PROVIDERS, API_KEY_DAILY_BUDGET_CENTS, assistantApiPrice, assistantModelName, isAiProviderKind, listPrice, PERSONAL_RUN_LIMITS, personalRunMaxInputTokens, aiModelSearchesWeb, type AiPrice, type AiProviderKind, type BackgroundComputeConnection,
  type AiModelList, type AiProviderPriceList, type ConnectBackgroundComputeCommand, type UpdateBackgroundComputeConnectionCommand } from '@flux/contracts';
import { InvalidInputError, NotFoundError, RuleViolationError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { refuseAllEndpoints, toolsRequired, type AiEndpointPolicyPort, type ToolCheck } from '../ai/index.js';
import { requestReservationMicros, resolveConnectionPrice } from '../ai/price.js';
import { baseUrlSyntaxProblem, normalizeBaseUrl, validAiKey, validModelId, validPrice } from '../ai/validation.js';

export interface BackgroundKeySealer {
  seal(plainKey: string, ownerUserId: string, connectionId: string): string;
}
export interface BackgroundConnectionPort {
  /** Adds a connection (PROV-1: it never replaces another). */
  add(input: { id: string; ownerUserId: string; encryptedKey: string; keyLastFour: string; keyFingerprint: string;
    price: AiPrice | null; name: string; provider: BackgroundComputeConnection['provider']; model: string;
    baseUrl: string | null; dailyBudgetCents: number; timeZone: string; modelList?: AiModelList | null;
    /** The check that the model called tools (#1441), saved in the same transaction as the key; absent when the model has no known price to check it with. */
    check?: { model: string; chargedMicros: number } }): Promise<BackgroundComputeConnection>;
  /** The owner's active connections, newest first. */
  list(ownerUserId: string): Promise<BackgroundComputeConnection[]>;
  /**
   * `guard` runs inside the change, after the owner's assistant lock and the key's row lock are held, with the models the owner's agents use
   * on this key (none when they are on another connection); it throws to refuse (#909, #915).
   */
  update(ownerUserId: string, connectionId: string, change: { name?: string; dailyBudgetCents?: number },
    guard?: (agentModels: readonly string[]) => void): Promise<BackgroundComputeConnection | null>;
  revoke(ownerUserId: string, connectionId: string): Promise<boolean>;
  /** The owner's price for one model of their key, or null to remove it (#1218); false when the key is not theirs. */
  setModelPrice?(ownerUserId: string, connectionId: string, model: string, price: { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | null): Promise<boolean>;
}
/** What a connection save needs beyond storage (F-020): the endpoint policy of owner-set URLs. */
export interface BackgroundConnectionProviders {
  endpoints: AiEndpointPolicyPort;
  /**
   * The models a key being added can use, read from its provider with that key (CA-2, #1218); the same call is the key's test. Only
   * for providers listed with a key (Anthropic, OpenAI, Gemini): `needs_key` for the others. Absent: nothing is listed.
   */
  keyModels?(provider: AiProviderKind, apiKey: string): Promise<AiModelList>;
  /**
   * The check that the key's model calls tools (RT-1 rule 2, #1441), sent with the key being added, after its listing and the price and budget
   * checks. Absent: nothing is checked (only a composition that can reach the providers has it).
   */
  toolCheck?: ToolCheck;
  /** The price list of a provider as it stands now (#1465); absent or null: Flux knows no price, and the owner enters it. */
  priceList?(provider: AiProviderKind): Promise<AiProviderPriceList | null>;
}

function owner(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}
function bounded(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
}
const budgetProblem = 'The daily budget is whole cents from $0.10 to $1,000';
/**
 * A budget below one request at the price of a model that runs on the key would wait for a day that never comes (#854): it is
 * refused when saved. `model` names the assistant's model when that is the one that does not fit (#909).
 */
function assertBudgetFitsRequest(price: AiPrice | null, budgetCents: number, provider: AiProviderKind, checked: string, model: string | null = null) {
  // With the provider's own web search a request has room for its results (#954); a model never offered it has none. The searches
  // themselves are charged as reported and not reserved (#1113), so a small budget stays usable.
  const largest = requestReservationMicros(price, personalRunMaxInputTokens(true, aiModelSearchesWeb(provider, checked)), PERSONAL_RUN_LIMITS.maxOutputTokens);
  if (largest !== null && largest > budgetCents * 10_000)
    throw new InvalidInputError(`One request on ${model ? `${assistantModelName(model)}, your assistant's model on this key,` : 'this model'} can cost up to $${(Math.ceil(largest / 10_000) / 100).toFixed(2)}, so the daily budget must be at least that`, 'AI_BUDGET_TOO_SMALL');
}
/** Why a key on a model Flux has no price for is not saved (#1424): the same words as the Connect AI form. */
export const AI_PRICE_REQUIRED = 'Enter this model’s price to use it with a daily budget: from your provider’s pricing, or 0 for a self-hosted server you pay for otherwise.';
function connectionName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 80;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A key in the selected provider's format, a bounded model id the owner chose, one daily budget and, for an
 * OpenAI-compatible endpoint only, a well-formed base URL (#854: no set-up attestations, no allowance of its own). Whether
 * that URL's host may be reached is checked separately. Returns the model the key keeps.
 */
export function validateBackgroundConnection(input: ConnectBackgroundComputeCommand): string {
  if (!input || typeof input !== 'object' || !isAiProviderKind(input.provider))
    throw new InvalidInputError('Choose a supported provider', 'AI_PROVIDER_INVALID');
  if (!validAiKey(input.provider, input.apiKey))
    throw new InvalidInputError(`The key does not look like a key of this provider. ${AI_PROVIDERS[input.provider].keyHint}`, 'AI_KEY_FORMAT');
  // Flux never picks a model for a key: the models are the provider's own, so the owner chooses one from the list of their key
  // (or names it), and a command without one is refused rather than saved on a model nobody chose (#1218).
  const model = input.model;
  if (model === undefined || model === null || model === '')
    throw new RuleViolationError('Choose the model this key uses. Flux lists the models of a key once it has read it.', 'AI_MODEL_REQUIRED');
  if (!validModelId(input.provider, model))
    throw new InvalidInputError('The model id must be 1–200 letters, digits or . _ : / @ + - and no provider-hosted tool variant', 'AI_MODEL_INVALID');
  if (input.provider === 'openai_compatible') {
    const problem = baseUrlSyntaxProblem(input.baseUrl);
    if (problem) throw new InvalidInputError(problem, 'AI_BASE_URL_INVALID');
  } else if (input.baseUrl !== undefined) {
    throw new InvalidInputError('A named provider always uses its own public API address', 'AI_BASE_URL_INVALID');
  }
  if (input.name !== undefined && !connectionName(input.name))
    throw new InvalidInputError('A connection name is 1–80 characters without leading or trailing spaces', 'AI_CONNECTION_NAME_INVALID');
  if (input.price !== undefined && !validPrice(input.price))
    throw new InvalidInputError('Prices are whole micro-dollars per 1M tokens, from 0 to 1,000,000,000', 'AI_PRICE_INVALID');
  if (!bounded(input.dailyBudgetCents, API_KEY_DAILY_BUDGET_CENTS.min, API_KEY_DAILY_BUDGET_CENTS.max))
    throw new InvalidInputError(budgetProblem, 'AI_BUDGET_INVALID');
  return model;
}

/** An IANA time zone, or UTC when none is given. */
function zoneOf(value: unknown): string {
  if (value === undefined) return 'UTC';
  if (typeof value !== 'string' || !value || value.length > 64) throw new InvalidInputError('timeZone must be an IANA time zone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new InvalidInputError('timeZone must be an IANA time zone');
  }
}

export function backgroundConnectionUseCases(port: BackgroundConnectionPort, sealer: BackgroundKeySealer,
  providers: BackgroundConnectionProviders = { endpoints: refuseAllEndpoints }) {
  return {
    async connect(principal: Principal, input: ConnectBackgroundComputeCommand): Promise<BackgroundComputeConnection> {
      const ownerUserId = owner(principal);
      const model = validateBackgroundConnection(input);
      const timeZone = zoneOf(input.timeZone);
      const baseUrl = input.provider === 'openai_compatible' ? normalizeBaseUrl(input.baseUrl!) : null;
      // Checked when saved and again at every dispatch (PROV-4); nothing is sent to it here.
      if (baseUrl) {
        const refused = await providers.endpoints.check(baseUrl);
        if (refused) throw new InvalidInputError(`This endpoint cannot be used: ${refused}`, 'AI_ENDPOINT_REFUSED');
      }
      // PROV-3: the price list of the place the key pays (#1465: LiteLLM's for Anthropic, OpenAI and Gemini, OpenRouter's own list for
      // OpenRouter), or the owner's price when no list knows the model.
      const list = await providers.priceList?.(input.provider) ?? null;
      const price = resolveConnectionPrice({ model, ownerPrice: input.price, list });
      // A key on a model with no price could never be used, since the daily budget prices every request before it is sent: it is not saved,
      // through the form or the API, and the owner is asked for the price (#1424). 0 is a price (a server paid for otherwise).
      if (!price) throw new RuleViolationError(AI_PRICE_REQUIRED, 'AI_PRICE_REQUIRED');
      assertBudgetFitsRequest(price, input.dailyBudgetCents, input.provider, model);
      // The key's test is the listing of its models (#1218): a key its provider refuses is not saved. A list that couldn't be read
      // leaves the key to be saved with the model typed.
      const modelList = providers.keyModels ? await providers.keyModels(input.provider, input.apiKey) : null;
      if (modelList?.status === 'key_refused')
        throw new InvalidInputError(`This key was refused by ${AI_PROVIDERS[input.provider].label}`, 'AI_KEY_REFUSED');
      const id = randomUUID();
      // Sealed first: a server that cannot keep the key (no instance key) refuses it before a request is sent for it.
      const encryptedKey = sealer.seal(input.apiKey, ownerUserId, id);
      // RT-1 rule 2 (#1441): only a model that calls tools can be an agent, decided by one small request on this model with the new key. It needs
      // the model's price to be charged (CA-3), which every saved key has (#1424: a key without one is refused above). A model that does not call `ping`, or a request that failed, refuses the key and nothing is saved. That
      // request has no connection to be charged to, so a refused key costs its check without it counting on any key's day; one that passes is
      // recorded with the key in one transaction, and so is counted from its first moment.
      let check: { model: string; chargedMicros: number } | undefined;
      if (providers.toolCheck && price) {
        const checked = await providers.toolCheck({ provider: input.provider, baseUrl, model, price, key: { apiKey: input.apiKey } });
        if (!checked.callsTools) throw toolsRequired();
        check = { model, chargedMicros: checked.chargedMicros };
      }
      const keyFingerprint = createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16);
      const name = input.name ?? `${AI_PROVIDERS[input.provider].label} key`.slice(0, 80);
      return port.add({ id, ownerUserId, encryptedKey, keyLastFour: input.apiKey.slice(-4), keyFingerprint, price, name,
        provider: input.provider, model, baseUrl, dailyBudgetCents: input.dailyBudgetCents, timeZone,
        modelList: modelList?.status === 'listed' || modelList?.status === 'unavailable' ? modelList : null, ...(check ? { check } : {}) });
    },
    list(principal: Principal): Promise<BackgroundComputeConnection[]> { return port.list(owner(principal)); },
    async update(principal: Principal, connectionId: string, change: UpdateBackgroundComputeConnectionCommand): Promise<BackgroundComputeConnection> {
      const ownerUserId = owner(principal);
      if (!change || typeof change !== 'object' || (change.name === undefined && change.dailyBudgetCents === undefined))
        throw new InvalidInputError('Change the name or the daily budget');
      if (change.name !== undefined && !connectionName(change.name))
        throw new InvalidInputError('A connection name is 1–80 characters without leading or trailing spaces', 'AI_CONNECTION_NAME_INVALID');
      if (change.dailyBudgetCents !== undefined && !bounded(change.dailyBudgetCents, API_KEY_DAILY_BUDGET_CENTS.min, API_KEY_DAILY_BUDGET_CENTS.max))
        throw new InvalidInputError(budgetProblem, 'AI_BUDGET_INVALID');
      let guard: ((agentModels: readonly string[]) => void) | undefined;
      if (change.dailyBudgetCents !== undefined) {
        const cents = change.dailyBudgetCents;
        const key = (await port.list(ownerUserId)).find((item) => item.id === connectionId);
        if (key) {
          assertBudgetFitsRequest(key.price, cents, key.provider, key.model);
          // An agent may run on another model of this key (F-027 AST-11): one request on that must fit too, or it would
          // stay paused on a budget too small for it (#909). A model with no known price cannot be reserved at all. The models are
          // read again inside the change, under the lock a model change also takes first (#915).
          const list = await providers.priceList?.(key.provider) ?? null;
          guard = (models) => {
            for (const model of models) {
              const price = model !== key.model ? assistantApiPrice(model, key.modelPrices, list) : null;
              if (price) assertBudgetFitsRequest(price, cents, key.provider, model, model);
            }
          };
        }
      }
      const updated = typeof connectionId === 'string' && UUID.test(connectionId)
        ? await port.update(ownerUserId, connectionId, { ...(change.name !== undefined ? { name: change.name } : {}),
          ...(change.dailyBudgetCents !== undefined ? { dailyBudgetCents: change.dailyBudgetCents } : {}) }, guard)
        : null;
      if (!updated) throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
      return updated;
    },
    /**
     * The owner's price for one of their key's models that Flux's price list does not price (PROV-3, #1218, #1465), so an agent can use
     * it with the daily budget. A model the list prices keeps the list's price. One request at the price must fit the key's budget.
     */
    async setModelPrice(principal: Principal, connectionId: string, input: { model?: unknown; inputMicrosPerMTok?: unknown; outputMicrosPerMTok?: unknown }): Promise<BackgroundComputeConnection> {
      const ownerUserId = owner(principal);
      const key = typeof connectionId === 'string' && UUID.test(connectionId) ? (await port.list(ownerUserId)).find((item) => item.id === connectionId) : undefined;
      if (!key || !port.setModelPrice) throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
      if (!validModelId(key.provider, input?.model))
        throw new InvalidInputError('The model id must be 1–200 letters, digits or . _ : / @ + - and no provider-hosted tool variant', 'AI_MODEL_INVALID');
      const price = { inputMicrosPerMTok: input.inputMicrosPerMTok, outputMicrosPerMTok: input.outputMicrosPerMTok };
      if (!validPrice(price)) throw new InvalidInputError('Prices are whole micro-dollars per 1M tokens, from 0 to 1,000,000,000', 'AI_PRICE_INVALID');
      if (listPrice(await providers.priceList?.(key.provider), input.model) || input.model === key.model)
        throw new InvalidInputError('Flux’s price list or this key already prices this model', 'AI_PRICE_ALREADY_KNOWN');
      const priced: AiPrice = { inputMicrosPerMTok: price.inputMicrosPerMTok as number, outputMicrosPerMTok: price.outputMicrosPerMTok as number, source: 'owner', checkedOn: null };
      assertBudgetFitsRequest(priced, key.dailyBudgetCents, key.provider, input.model);
      if (!await port.setModelPrice(ownerUserId, connectionId, input.model, { inputMicrosPerMTok: priced.inputMicrosPerMTok, outputMicrosPerMTok: priced.outputMicrosPerMTok }))
        throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
      return (await port.list(ownerUserId)).find((item) => item.id === connectionId)!;
    },
    async revoke(principal: Principal, connectionId: string): Promise<void> {
      const ownerUserId = owner(principal);
      if (typeof connectionId !== 'string' || !UUID.test(connectionId) || !await port.revoke(ownerUserId, connectionId))
        throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
    },
  };
}
