import type { FastifyInstance } from 'fastify';
import { SEARCH_FILTER_TYPES, SEARCH_LIMITS, SEARCH_PATH, type SearchQuery } from '@flux/contracts';
import type { Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, useDomainErrors } from '../http/commands.js';
import { searchUseCases } from './adapters.js';
import { SearchCursorCodec } from './cursor.js';

interface Options {
  db: Database;
  sessions: SessionResolver;
  cursorSecret: string;
  /** Test only (the fixture module: a fixture token and FLUX_TEST_FAILURE_INJECTION): `GET /api/v1/search/explain` returns the rows examined. */
  exposeWork: boolean;
}

const querystring = {
  type: 'object', required: ['q'], additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: SEARCH_LIMITS.query * 4 },
    type: { type: 'string', enum: [...SEARCH_FILTER_TYPES] },
    place: { type: 'string', maxLength: 80 },
    author: { type: 'string', maxLength: 80 },
    cursor: { type: 'string', maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMITS.pageMax },
  },
} as const;

/**
 * `GET /api/v1/search` (#114). The handler resolves the session and calls the core use case,
 * which asks the access policy for the reader's audiences on every request. Answers are never
 * cached: a revocation applies to the next search.
 */
export async function searchRoutes(app: FastifyInstance, { db, sessions, cursorSecret, exposeWork }: Options) {
  useDomainErrors(app);
  const { principal } = commandRunner(db, sessions);
  const search = searchUseCases(db, new SearchCursorCodec(cursorSecret));
  app.get<{ Querystring: SearchQuery }>(SEARCH_PATH, { schema: { querystring } }, async (request, reply) => {
    const answer = await search.search(await principal(request), request.query);
    return reply.header('cache-control', 'no-store').send(answer);
  });
  if (exposeWork) {
    app.get<{ Querystring: SearchQuery }>(`${SEARCH_PATH}/explain`, { schema: { querystring } }, async (request) =>
      search.explain(await principal(request), request.query));
  }
}
