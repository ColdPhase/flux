import type { FastifyInstance } from 'fastify';
import { pinsPath, type PinPlace } from '@flux/contracts';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { pinUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver }

/**
 * Pinned messages (C-74, #1615): `GET <conversation>/pins` lists them, `PUT` and `DELETE <conversation>/pins/:messageId` pin and unpin one
 * (`?part=prompt|answer` for a run of an agent's chat). Each answers the list. Pinning twice and unpinning what is not pinned change nothing,
 * so neither needs an Idempotency-Key. Only a signed-in person's session reaches them; agents read pins with `flux_list_pinned`.
 */
export async function pinRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const use = pinUseCases(db);
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const query = { type: 'object', additionalProperties: false, properties: { part: { type: 'string', enum: ['prompt', 'answer'] } } } as const;
  // Each address names its conversation with the parameter its other routes use (`:projectId`, `:dmId`, `:agentId`).
  for (const [type, param] of [['project', 'projectId'], ['dm', 'dmId'], ['agent', 'agentId']] as const) {
    const base = pinsPath({ type, id: `:${param}` } as PinPlace);
    const place = (id: string) => ({ type, id }) as PinPlace;
    app.get<{ Params: Record<string, string> }>(base, async (request, reply) =>
      reply.header('cache-control', 'no-store').send(await use.list(await principal(request), place(request.params[param]!))));
    app.put<{ Params: Record<string, string>; Querystring: { part?: string } }>(`${base}/:messageId`, { schema: { querystring: query } }, async (request) =>
      use.pin(await principal(request), place(request.params[param]!), request.params.messageId!, request.query.part));
    app.delete<{ Params: Record<string, string>; Querystring: { part?: string } }>(`${base}/:messageId`, { schema: { querystring: query } }, async (request) =>
      use.unpin(await principal(request), place(request.params[param]!), request.params.messageId!, request.query.part));
  }
}
