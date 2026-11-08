import { createHash, randomUUID } from 'node:crypto';
import { AI_PROVIDERS, API_KEY_DAILY_BUDGET_CENTS, apiKeyDefaultModel, assistantApiPrice, assistantModelName, isAiProviderKind, PERSONAL_RUN_LIMITS, type AiPrice, type BackgroundComputeConnection,
  type ConnectBackgroundComputeCommand, type UpdateBackgroundComputeConnectionCommand } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { refuseAllEndpoints, type AiEndpointPolicyPort } from '../ai/index.js';
import { requestReservationMicros, resolveConnectionPrice } from '../ai/price.js';
import { baseUrlSyntaxProblem, normalizeBaseUrl, validAiKey, validModelId, validPrice } from '../ai/validation.js';

export interface BackgroundKeySealer {
  seal(plainKey: string, ownerUserId: string, connectionId: string): string;
}
export interface BackgroundConnectionPort {
  /** Adds a connection (PROV-1: it never replaces another). It becomes the background one when asked or when the owner has none. */
  add(input: { id: string; ownerUserId: string; encryptedKey: string; keyLastFour: string; keyFingerprint: string;
    price: AiPrice | null; name: string; useForBackground: boolean; provider: BackgroundComputeConnection['provider']; model: string;
    baseUrl: string | null; dailyBudgetCents: number; timeZone: string }): Promise<BackgroundComputeConnection>;
  /** The owner's active connections, background one first, then newest. */
  list(ownerUserId: string): Promise<BackgroundComputeConnection[]>;
  /** The one background comparisons use, or null. */
  current(ownerUserId: string): Promise<BackgroundComputeConnection | null>;
  /**
   * `guard` runs inside the change, after the owner's assistant lock and the key's row lock are held, with the models the owner's agents use
   * on this key (none when they are on another connection); it throws to refuse (#909, #915).
   */
  update(ownerUserId: string, connectionId: string, change: { name?: string; dailyBudgetCents?: number; usedForBackground?: true },
    guard?: (agentModels: readonly string[]) => void): Promise<BackgroundComputeConnection | null>;
  revoke(ownerUserId: string, connectionId: string): Promise<boolean>;
}
/** What a connection save needs beyond storage (F-020): the endpoint policy of owner-set URLs. */
export interface BackgroundConnectionProviders {
  endpoints: AiEndpointPolicyPort;
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
function assertBudgetFitsRequest(price: AiPrice | null, budgetCents: number, model: string | null = null) {
  const largest = requestReservationMicros(price, PERSONAL_RUN_LIMITS.maxToolInputTokens, PERSONAL_RUN_LIMITS.maxOutputTokens);
  if (largest !== null && largest > budgetCents * 10_000)
    throw new InvalidInputError(`One request on ${model ? `${assistantModelName(model)}, one of your agents' models on this key,` : 'this model'} can cost up to $${(Math.ceil(largest / 10_000) / 100).toFixed(2)}, so the daily budget must be at least that`, 'AI_BUDGET_TOO_SMALL');
}
function connectionName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 80;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A key in the selected provider's format, a bounded model id (or the provider's default), one daily budget and, for an
 * OpenAI-compatible endpoint only, a well-formed base URL (#854: no set-up attestations, no allowance of its own). Whether
 * that URL's host may be reached is checked separately. Returns the model the key keeps.
 */
export function validateBackgroundConnection(input: ConnectBackgroundComputeCommand): string {
  if (!input || typeof input !== 'object' || !isAiProviderKind(input.provider))
    throw new InvalidInputError('Choose a supported provider', 'AI_PROVIDER_INVALID');
  if (!validAiKey(input.provider, input.apiKey))
    throw new InvalidInputError(`The key does not look like a key of this provider. ${AI_PROVIDERS[input.provider].keyHint}`, 'AI_KEY_FORMAT');
  const model = input.model ?? apiKeyDefaultModel(input.provider);
  if (model === null) throw new InvalidInputError('Name the model this key uses', 'AI_MODEL_INVALID');
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
  if (input.useForBackground !== undefined && typeof input.useForBackground !== 'boolean')
    throw new InvalidInputError('useForBackground is true or false');
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
      // PROV-3: Flux's dated table or the owner's price; a provider's listing is never a price source.
      const price = resolveConnectionPrice({ provider: input.provider, model, ownerPrice: input.price });
      assertBudgetFitsRequest(price, input.dailyBudgetCents);
      const id = randomUUID();
      const encryptedKey = sealer.seal(input.apiKey, ownerUserId, id);
      const keyFingerprint = createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16);
      const name = input.name ?? `${AI_PROVIDERS[input.provider].label} key`.slice(0, 80);
      return port.add({ id, ownerUserId, encryptedKey, keyLastFour: input.apiKey.slice(-4), keyFingerprint, price, name,
        useForBackground: input.useForBackground === true, provider: input.provider, model, baseUrl, dailyBudgetCents: input.dailyBudgetCents, timeZone });
    },
    list(principal: Principal): Promise<BackgroundComputeConnection[]> { return port.list(owner(principal)); },
    current(principal: Principal): Promise<BackgroundComputeConnection | null> { return port.current(owner(principal)); },
    async update(principal: Principal, connectionId: string, change: UpdateBackgroundComputeConnectionCommand): Promise<BackgroundComputeConnection> {
      const ownerUserId = owner(principal);
      if (!change || typeof change !== 'object' || (change.name === undefined && change.usedForBackground === undefined && change.dailyBudgetCents === undefined))
        throw new InvalidInputError('Change the name or the daily budget, or choose the connection for background comparisons');
      if (change.name !== undefined && !connectionName(change.name))
        throw new InvalidInputError('A connection name is 1–80 characters without leading or trailing spaces', 'AI_CONNECTION_NAME_INVALID');
      if (change.dailyBudgetCents !== undefined && !bounded(change.dailyBudgetCents, API_KEY_DAILY_BUDGET_CENTS.min, API_KEY_DAILY_BUDGET_CENTS.max))
        throw new InvalidInputError(budgetProblem, 'AI_BUDGET_INVALID');
      if (change.usedForBackground !== undefined && change.usedForBackground !== true)
        throw new InvalidInputError('Choose another connection for background comparisons by marking it');
      let guard: ((agentModels: readonly string[]) => void) | undefined;
      if (change.dailyBudgetCents !== undefined) {
        const cents = change.dailyBudgetCents;
        const key = (await port.list(ownerUserId)).find((item) => item.id === connectionId);
        if (key) {
          assertBudgetFitsRequest(key.price, cents);
          // An agent may run on another model of this key (F-027 AST-11): one request on that must fit too, or it would
          // stay paused on a budget too small for it (#909). A model with no table price cannot be reserved at all. The models are
          // read again inside the change, under the lock a model change also takes first (#915).
          guard = (models) => {
            for (const model of models) {
              const price = model !== key.model ? assistantApiPrice(key.provider, model) : null;
              if (price) assertBudgetFitsRequest(price, cents, model);
            }
          };
        }
      }
      const updated = typeof connectionId === 'string' && UUID.test(connectionId)
        ? await port.update(ownerUserId, connectionId, { ...(change.name !== undefined ? { name: change.name } : {}),
          ...(change.dailyBudgetCents !== undefined ? { dailyBudgetCents: change.dailyBudgetCents } : {}),
          ...(change.usedForBackground ? { usedForBackground: true as const } : {}) }, guard)
        : null;
      if (!updated) throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
      return updated;
    },
    async revoke(principal: Principal, connectionId: string): Promise<void> {
      const ownerUserId = owner(principal);
      if (typeof connectionId !== 'string' || !UUID.test(connectionId) || !await port.revoke(ownerUserId, connectionId))
        throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
    },
  };
}
