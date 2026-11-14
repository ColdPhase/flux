import { createHash } from 'node:crypto';
import type { Database } from '@flux/db';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AI_BASE_URL_MAX_LENGTH, AI_LISTED_PRICE_PROVIDERS, AI_MODEL_LISTS_PATH, AI_PROVIDERS, providerPriceList, API_KEY_DAILY_BUDGET_CENTS, AI_PRICE_MAX_MICROS_PER_MTOK, AI_PROVIDER_KINDS, type AiModelList, type AiModelListQuery,
  type AiProviderKind, type AiProviderPriceList, type AssistantModelListing, type ConnectBackgroundComputeCommand, type SetApiKeyModelPriceCommand, type UpdateBackgroundComputeConnectionCommand } from '@flux/contracts';
import { aiPriceListRepository, backgroundConnectionRepository, personalConnectionLookup, sealBackgroundKey, storedProviderPriceList } from '@flux/db';
import { backgroundConnectionUseCases, heldPriceLog, openRouterPriceList, storeGuardedPriceList, baseUrlSyntaxProblem, ConflictError, DomainError, InvalidInputError, keyListing, NotFoundError, normalizeBaseUrl, RateLimitedError, validAiKey } from '@flux/core';
import type { ModelListRefresh } from './model-refresh.js';
import type { SessionResolver } from '../identity/index.js';
import { requireNotGuest } from '../access/guest-no-ai.js';
import { aiConnectionServerComposition, type AiConnectionServerComposition } from './ai-composition.js';
import { onePerPerson } from './one-listing.js';

// A person's own API keys (Connect AI, #854): added, listed, renamed, given a daily budget and removed. The key never comes back.

interface Options {
  db: Database; sessions: SessionResolver; backgroundMasterKey: Buffer | null; ai?: AiConnectionServerComposition;
  /** Called after a key was saved: connecting AI the first time gives the person Assistant (F-036 AG-1). */
  afterConnect?: (ownerUserId: string) => Promise<void>;
  /** Asks the worker to read a stored key's models again (#1218); absent: Try again answers from what is stored. */
  refresh?: ModelListRefresh;
}

const microsPerMTok = { type: 'integer', minimum: 0, maximum: AI_PRICE_MAX_MICROS_PER_MTOK };
const dailyBudget = { type: 'integer', minimum: API_KEY_DAILY_BUDGET_CENTS.min, maximum: API_KEY_DAILY_BUDGET_CENTS.max };

export async function aiKeyRoutes(app: FastifyInstance, { db, sessions, backgroundMasterKey, ai = aiConnectionServerComposition(process.env), afterConnect, refresh }: Options) {
  const keys = personalConnectionLookup(db);
  const listing = onePerPerson<AiModelList>();
  // The price lists (#1465), as last stored. OpenRouter's is what an OpenRouter key pays: it is read from OpenRouter's model list when a
  // key is connected, or the form lists OpenRouter's models, and the stored one is more than a day old.
  const priceLists = aiPriceListRepository(db);
  const keepOpenRouterPrices = async (list: AiModelList): Promise<AiProviderPriceList | null> => {
    const offered = openRouterPriceList(list);
    if (!offered) return null;
    // A price OpenRouter's list drops to 0 or a tenth of what Flux knows is not taken (#1270); the answer carries the guarded list.
    const { list: read, held } = await storeGuardedPriceList(priceLists, 'openrouter', offered);
    for (const line of heldPriceLog('openrouter', held)) app.log.warn(line, 'a price list price was held');
    return providerPriceList(read, 'openrouter');
  };
  const priceList = async (provider: AiProviderKind): Promise<AiProviderPriceList | null> => {
    if (!(AI_LISTED_PRICE_PROVIDERS as readonly AiProviderKind[]).includes(provider)) return null;
    if (provider === 'openrouter') {
      const stored = await priceLists.read('openrouter');
      if (stored && Date.now() - stored.storedAt.getTime() < 24 * 3600_000) return providerPriceList(stored, 'openrouter');
      return (await keepOpenRouterPrices(await ai.listModels('openrouter', null))) ?? providerPriceList(stored, 'openrouter');
    }
    return storedProviderPriceList(db, provider);
  };
  const connections = backgroundConnectionUseCases(backgroundConnectionRepository(db), {
    seal(plainKey, ownerUserId, connectionId) {
      if (!backgroundMasterKey) throw new ConflictError('Background key custody is unavailable on this instance', 'BACKGROUND_KEY_CUSTODY_UNAVAILABLE');
      return sealBackgroundKey(plainKey, ownerUserId, connectionId, backgroundMasterKey);
    },
  }, { ...ai.providers, priceList });
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof RateLimitedError) reply.header('retry-after', String(error.retryAfterSeconds));
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code, ...error.details });
    if ((error as FastifyError).statusCode === 401) return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });
  app.post<{ Body: ConnectBackgroundComputeCommand }>('/api/v1/background-compute-connections', {
    // An API key and its one daily budget (#854): no set-up attestations and no allowance of its own.
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['provider', 'apiKey', 'dailyBudgetCents'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        provider: { type: 'string', enum: [...AI_PROVIDER_KINDS] },
        // Without one (or empty) the use case answers 422 AI_MODEL_REQUIRED: Flux never picks a model for a key (#1218).
        model: { type: 'string', maxLength: 200 },
        baseUrl: { type: 'string', minLength: 1, maxLength: AI_BASE_URL_MAX_LENGTH },
        price: { type: 'object', additionalProperties: false, required: ['inputMicrosPerMTok', 'outputMicrosPerMTok'],
          properties: { inputMicrosPerMTok: microsPerMTok, outputMicrosPerMTok: microsPerMTok } },
        apiKey: { type: 'string', minLength: 8, maxLength: 512 },
        dailyBudgetCents: dailyBudget,
        timeZone: { type: 'string', minLength: 1, maxLength: 64 },
      } } },
  }, async (request, reply) => {
    const { principal } = await sessions.requirePrincipal(request);
    await requireNotGuest(db, principal.id);
    const connected = await connections.connect(principal, request.body);
    await afterConnect?.(principal.id);
    return reply.code(201).send(connected);
  });
  // PROV-1: all of the owner's own connections; never another person's.
  app.get('/api/v1/background-compute-connections', async (request) => connections.list(
    (await sessions.requirePrincipal(request)).principal));
  app.patch<{ Params: { connectionId: string }; Body: UpdateBackgroundComputeConnectionCommand }>('/api/v1/background-compute-connections/:connectionId', {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 }, dailyBudgetCents: dailyBudget } } },
  }, async (request) => connections.update((await sessions.requirePrincipal(request)).principal, request.params.connectionId, request.body));
  // A provider's models, listed by this server through the endpoint guard (PROV-1): OpenRouter and an endpoint without a key; Anthropic,
  // OpenAI and Gemini with the key being added, which is its test (CA-2, #1218). The key is never stored or echoed here.
  app.post<{ Body: AiModelListQuery }>(AI_MODEL_LISTS_PATH, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['provider'], properties: {
      provider: { type: 'string', enum: [...AI_PROVIDER_KINDS] },
      baseUrl: { type: 'string', minLength: 1, maxLength: AI_BASE_URL_MAX_LENGTH },
      apiKey: { type: 'string', minLength: 8, maxLength: 512 } } } },
  }, async (request) => {
    // A guest has no AI (AG-2): not even a look-up of a provider's models (#995).
    const { principal } = await sessions.requirePrincipal(request);
    await requireNotGuest(db, principal.id);
    const { provider, baseUrl } = request.body;
    if (provider === 'openai_compatible') {
      const problem = baseUrlSyntaxProblem(baseUrl);
      if (problem) throw new InvalidInputError(problem, 'AI_BASE_URL_INVALID');
    } else if (baseUrl !== undefined) throw new InvalidInputError('A named provider always uses its own public API address', 'AI_BASE_URL_INVALID');
    const apiKey = request.body.apiKey?.trim();
    if (apiKey !== undefined && !validAiKey(provider, apiKey))
      throw new InvalidInputError(`The key does not look like a key of this provider. ${AI_PROVIDERS[provider].keyHint}`, 'AI_KEY_FORMAT');
    const address = provider === 'openai_compatible' ? normalizeBaseUrl(baseUrl!) : null;
    // One listing at a time for this person: the same one shares it, another waits for it to end (#1347).
    const same = createHash('sha256').update(JSON.stringify([provider, address, apiKey ?? null])).digest('hex');
    const list = await listing(principal.id, same, () => ai.listModels(provider, address, apiKey));
    // The answer carries the provider's price list, so the form shows a model's price, or asks for it when Flux knows none (#1465).
    // OpenRouter's list just read is its price list of today.
    const prices = provider === 'openrouter' ? (await keepOpenRouterPrices(list)) ?? providerPriceList(await priceLists.read('openrouter'), 'openrouter')
      : await priceList(provider);
    return { ...list, priceList: prices };
  });
  /** How fresh one of the owner's keys' lists is, or 404. */
  async function listingOf(ownerUserId: string, connectionId: string): Promise<{ listing: AssistantModelListing | null }> {
    const key = (await keys.list(ownerUserId)).find((item) => item.id === connectionId);
    if (!key) throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
    return { listing: keyListing(key) ?? null };
  }
  // Try again (#1218): the worker reads the key's models again; the answer says how fresh the key's list is now.
  app.post<{ Params: { connectionId: string } }>('/api/v1/background-compute-connections/:connectionId/model-list', async (request) => {
    const { principal } = await sessions.requirePrincipal(request);
    await requireNotGuest(db, principal.id);
    const connectionId = request.params.connectionId.toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(connectionId)) throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
    if (refresh && !(await refresh.refreshNow(principal.id, connectionId))) throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
    return listingOf(principal.id, connectionId);
  });
  // The owner's price for a model of their key that Flux's price list does not price (PROV-3, #1218, #1465).
  app.put<{ Params: { connectionId: string }; Body: SetApiKeyModelPriceCommand }>('/api/v1/background-compute-connections/:connectionId/model-price', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['model', 'inputMicrosPerMTok', 'outputMicrosPerMTok'], properties: {
      model: { type: 'string', minLength: 1, maxLength: 200 }, inputMicrosPerMTok: microsPerMTok, outputMicrosPerMTok: microsPerMTok } } },
  }, async (request) => {
    const { principal } = await sessions.requirePrincipal(request);
    await requireNotGuest(db, principal.id);
    return connections.setModelPrice(principal, request.params.connectionId.toLowerCase(), request.body);
  });
  app.delete<{ Params: { connectionId: string } }>('/api/v1/background-compute-connections/:connectionId', async (request, reply) => {
    await connections.revoke((await sessions.requirePrincipal(request)).principal, request.params.connectionId);
    return reply.code(204).send();
  });
}
