import type { Database } from '@flux/db';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AI_BASE_URL_MAX_LENGTH, AI_MODEL_LISTS_PATH, API_KEY_DAILY_BUDGET_CENTS, AI_PRICE_MAX_MICROS_PER_MTOK, AI_PROVIDER_KINDS, type AiModelListQuery,
  type ConnectBackgroundComputeCommand, type UpdateBackgroundComputeConnectionCommand } from '@flux/contracts';
import { backgroundConnectionRepository, sealBackgroundKey } from '@flux/db';
import { backgroundConnectionUseCases, baseUrlSyntaxProblem, ConflictError, DomainError, InvalidInputError, normalizeBaseUrl } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { requireNotGuest } from '../access/guest-no-ai.js';
import { aiConnectionServerComposition, type AiConnectionServerComposition } from './ai-composition.js';

// A person's own API keys (Connect AI, #854): added, listed, renamed, given a daily budget and removed. The key never comes back.

interface Options {
  db: Database; sessions: SessionResolver; backgroundMasterKey: Buffer | null; ai?: AiConnectionServerComposition;
  /** Called after a key was saved: connecting AI the first time gives the person Assistant (F-036 AG-1). */
  afterConnect?: (ownerUserId: string) => Promise<void>;
}

const microsPerMTok = { type: 'integer', minimum: 0, maximum: AI_PRICE_MAX_MICROS_PER_MTOK };
const dailyBudget = { type: 'integer', minimum: API_KEY_DAILY_BUDGET_CENTS.min, maximum: API_KEY_DAILY_BUDGET_CENTS.max };

export async function aiKeyRoutes(app: FastifyInstance, { db, sessions, backgroundMasterKey, ai = aiConnectionServerComposition(process.env), afterConnect }: Options) {
  const connections = backgroundConnectionUseCases(backgroundConnectionRepository(db), {
    seal(plainKey, ownerUserId, connectionId) {
      if (!backgroundMasterKey) throw new ConflictError('Background key custody is unavailable on this instance', 'BACKGROUND_KEY_CUSTODY_UNAVAILABLE');
      return sealBackgroundKey(plainKey, ownerUserId, connectionId, backgroundMasterKey);
    },
  }, ai.providers);
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
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
        model: { type: 'string', minLength: 1, maxLength: 200 },
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
  // A provider's models, listed by this server without a key and through the endpoint guard (PROV-1).
  app.post<{ Body: AiModelListQuery }>(AI_MODEL_LISTS_PATH, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['provider'], properties: {
      provider: { type: 'string', enum: [...AI_PROVIDER_KINDS] },
      baseUrl: { type: 'string', minLength: 1, maxLength: AI_BASE_URL_MAX_LENGTH } } } },
  }, async (request) => {
    // A guest has no AI (AG-2): not even a look-up of a provider's models (#995).
    await requireNotGuest(db, (await sessions.requirePrincipal(request)).principal.id);
    const { provider, baseUrl } = request.body;
    if (provider === 'openai_compatible') {
      const problem = baseUrlSyntaxProblem(baseUrl);
      if (problem) throw new InvalidInputError(problem, 'AI_BASE_URL_INVALID');
    } else if (baseUrl !== undefined) throw new InvalidInputError('A named provider always uses its own public API address', 'AI_BASE_URL_INVALID');
    return ai.listModels(provider, provider === 'openai_compatible' ? normalizeBaseUrl(baseUrl!) : null);
  });
  app.delete<{ Params: { connectionId: string } }>('/api/v1/background-compute-connections/:connectionId', async (request, reply) => {
    await connections.revoke((await sessions.requirePrincipal(request)).principal, request.params.connectionId);
    return reply.code(204).send();
  });
}
