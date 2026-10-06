import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { FIXTURE_OAUTH_CLIENT_PATH, SAMPLE_COMMAND_PATH, type FixtureOauthClientCommand, type FixtureOauthClientRegistered, type SampleCommand } from '@flux/contracts';
import type { Database } from '@flux/core';
import { fixtureOauthClientRepository } from '@flux/db';
import type { FixtureConfig } from '../config.js';
import { createSample, ForcedRollbackError, InvalidSampleError } from './sample.js';

const MCP_SCOPES = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute', 'offline_access'];

/**
 * Test-deployment wiring in one place (#88). Nothing here exists without `FLUX_FIXTURE_TOKEN`:
 * the sample command and the test-only stream, search and OAuth client routes then answer 404.
 * Failure injection, the test-only stream and search routes and OAuth client registration (#287)
 * additionally need `FLUX_TEST_FAILURE_INJECTION=true`.
 */
export function fixtureFlags(config: FixtureConfig) {
  const enabled = config.token !== null;
  return {
    /** `GET /api/v1/stream/work` and `GET /api/v1/search/explain`. */
    exposeWork: enabled && config.failureInjection,
    /** `POST /api/v1/integration/oauth-clients` (#287): browser sessions cannot register OAuth clients. */
    registerOauthClients: enabled && config.failureInjection,
  };
}

/** The fixture bearer, compared in constant time. */
function bearerMatches(header: string | undefined, token: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

export function registerFixtureRoutes(app: FastifyInstance, { config, db, boss, publicOrigin }: { config: FixtureConfig; db: Database; boss: Pick<PgBoss, 'send'>; publicOrigin: string }) {
  const token = config.token;
  if (token === null) return;
  if (fixtureFlags(config).registerOauthClients) {
    const clients = fixtureOauthClientRepository(db);
    app.post<{ Body: FixtureOauthClientCommand }>(FIXTURE_OAUTH_CLIENT_PATH, {
      onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!bearerMatches(request.headers.authorization, token)) return reply.code(401).send({ error: 'Unauthorized' });
      },
      schema: { body: { type: 'object', required: ['name', 'redirectUris'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        redirectUris: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 2048 } },
        scopes: { type: 'array', minItems: 1, maxItems: MCP_SCOPES.length, uniqueItems: true, items: { type: 'string', enum: MCP_SCOPES } },
      } } },
    }, async (request, reply) => {
      for (const uri of request.body.redirectUris) {
        const url = URL.canParse(uri) ? new URL(uri) : null;
        if (!url || url.protocol !== 'http:' && url.protocol !== 'https:' || uri.includes('#'))
          return reply.code(400).send({ error: 'Each redirect URI must be an absolute http(s) URL without a fragment' });
      }
      const clientId = `flux-fixture-${randomUUID()}`;
      await clients.register({ clientId, name: request.body.name, redirectUris: request.body.redirectUris,
        scopes: request.body.scopes ?? MCP_SCOPES, resource: `${publicOrigin}/mcp` });
      return reply.code(201).send({ clientId } satisfies FixtureOauthClientRegistered);
    });
  }
  app.post<{ Body: SampleCommand }>(SAMPLE_COMMAND_PATH, {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string' } } } },
    preValidation: async (request, reply) => {
      // Fastify's default AJV removes unknown body fields before validation.
      if (request.body && typeof request.body === 'object' && 'failAfterInsert' in request.body) {
        return reply.code(400).send({ error: 'Unknown command field' });
      }
    },
  }, async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: 'Unauthorized' });
    try {
      const result = await createSample({ id: 'fixture', kind: 'fixture' }, request.body, db, boss,
        config.failureInjection && request.headers['x-flux-test-failure'] === 'after-insert');
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof ForcedRollbackError) return reply.code(409).send({ error: error.message });
      if (error instanceof InvalidSampleError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}
