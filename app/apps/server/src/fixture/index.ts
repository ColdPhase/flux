import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { SAMPLE_COMMAND_PATH, type SampleCommand } from '@flux/contracts';
import type { Database } from '@flux/core';
import type { FixtureConfig } from '../config.js';
import { createSample, ForcedRollbackError, InvalidSampleError } from './sample.js';

/**
 * Test-deployment wiring in one place (#88). Nothing here exists without `FLUX_FIXTURE_TOKEN`:
 * the sample command and the test-only stream and search routes then answer 404. Failure
 * injection additionally needs `FLUX_TEST_FAILURE_INJECTION=true`.
 */
export function fixtureFlags(config: FixtureConfig) {
  const enabled = config.token !== null;
  return {
    /** `GET /api/v1/stream/work` and `GET /api/v1/search/explain`. */
    exposeWork: enabled && config.failureInjection,
  };
}

export function registerFixtureRoutes(app: FastifyInstance, { config, db, boss }: { config: FixtureConfig; db: Database; boss: Pick<PgBoss, 'send'> }) {
  const token = config.token;
  if (token === null) return;
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
