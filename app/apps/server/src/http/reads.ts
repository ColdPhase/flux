import type { FastifyInstance } from 'fastify';
import { READS_LIMIT, READS_PATH, foldableRead, type FoldedReadAnswer } from '@flux/contracts';

/**
 * Several reads in one request (#862, `GET /api/v1/reads?path=…&path=…`). The web client folds the reads a view asks for in the same
 * moment; each is answered here by its own route, in this process (`inject`), with the caller's cookie and address: the same session, the
 * same access rules and refusals, the same limits (each read counts against the caller's budget as its own request would) and the same
 * logs. Only the reads `foldableRead` names (JSON reads of the API, nothing that leaves it), at most READS_LIMIT, and only by GET. A cookie
 * a read sets (a session renewed) is set on this answer, so nothing a route does for the caller is lost.
 */
export function useFoldedReads(app: FastifyInstance) {
  app.get<{ Querystring: { path?: string | string[] } }>(READS_PATH, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { path: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } } } },
  }, async (request, reply) => {
    const raw = request.query.path;
    const paths = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (!paths.length || paths.length > READS_LIMIT || !paths.every(foldableRead))
      return reply.code(400).send({ error: `path names 1 to ${READS_LIMIT} reads that are folded`, code: 'READS_INVALID' });
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const name of ['cookie', 'user-agent', 'accept-language'] as const) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const cookies: string[] = [];
    const answers = await Promise.all(paths.map(async (url): Promise<FoldedReadAnswer> => {
      const answer = await app.inject({ method: 'GET', url, headers, remoteAddress: request.ip });
      const set = answer.headers['set-cookie'];
      if (set) cookies.push(...(Array.isArray(set) ? set : [String(set)]));
      const json = /^application\/json\b/i.test(String(answer.headers['content-type'] ?? ''));
      return { status: answer.statusCode, body: json ? answer.body : '' };
    }));
    if (cookies.length) reply.header('set-cookie', cookies);
    return { answers };
  });
}
