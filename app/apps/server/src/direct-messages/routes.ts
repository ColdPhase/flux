import type { FastifyInstance } from 'fastify';
import {
  DMS_PATH,
  type ConversationWindowQuery,
  type CreateDmCommand,
  type PageQuery,
  type SendDmMessageCommand,
  type UpdateDmCommand,
} from '@flux/contracts';
import type { Database, ResourceRef } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { bodyId, commandRunner, expectedVersion, requires, useDomainErrors, versionEtag } from '../http/commands.js';
import { dmUseCases } from './adapters.js';

export interface DmRouteOptions {
  db: Database;
  sessions: SessionResolver;
}

const WORKSPACE_DMS = '/api/v1/workspaces/:workspaceId/dms';
const DM = `${DMS_PATH}/:dmId`;
const id = { type: 'string', minLength: 1, maxLength: 64 } as const;

/**
 * `/api/v1` direct-message routes (issue #107). Handlers resolve the session on every request
 * and call one core use case, which authorizes through the access policy (`dm` resources). POST
 * and PATCH accept `Idempotency-Key`; renaming a group needs its version (`If-Match` or
 * `expectedVersion`). Messages also keep the #36 `clientMessageId` retry rule.
 */
export async function dmRoutes(app: FastifyInstance, { db, sessions }: DmRouteOptions) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const dms = dmUseCases(db);
  const dmScope = (dmId: string): ResourceRef => ({ type: 'dm', id: dmId });
  const readDm = (dmId: string) => requires('dm', 'dm.read', () => dmId);

  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(WORKSPACE_DMS, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } },
  }, async (request) => dms.list(await principal(request), request.params.workspaceId, request.query));

  app.post<{ Params: { workspaceId: string }; Body: CreateDmCommand }>(WORKSPACE_DMS, {
    schema: {
      body: {
        type: 'object', required: ['participantIds'], additionalProperties: false,
        properties: { participantIds: { type: 'array', minItems: 1, maxItems: 20, items: id }, title: { type: ['string', 'null'], maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    let created = true;
    return command(request, reply, {
      operation: `POST ${WORKSPACE_DMS}`, scope: { type: 'workspace', id: request.params.workspaceId }, etag: true,
      // A new DM answers 201; the pair's existing 1:1 DM answers 200.
      status: () => (created ? 201 : 200),
      run: async (actor, conn) => {
        const result = await dmUseCases(conn).create(actor, request.params.workspaceId, request.body);
        created = result.created;
        return result.dm;
      },
      replay: requires('dm', 'dm.read', bodyId),
    });
  });

  app.get<{ Params: { dmId: string }; Querystring: ConversationWindowQuery }>(DM, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, beforeSequence: { type: 'integer' } } } },
  }, async (request, reply) => {
    const dm = await dms.get(await principal(request), request.params.dmId, request.query);
    return reply.header('etag', versionEtag(dm)).send(dm);
  });

  app.patch<{ Params: { dmId: string }; Body: UpdateDmCommand }>(DM, {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: ['string', 'null'], maxLength: 200 }, expectedVersion: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${DM}`, scope: dmScope(request.params.dmId), etag: true,
    run: (actor, conn) => dmUseCases(conn).rename(actor, request.params.dmId, { ...request.body, expectedVersion: expectedVersion(request) }),
    replay: readDm(request.params.dmId),
  }));

  app.post<{ Params: { dmId: string }; Body: SendDmMessageCommand }>(`${DM}/messages`, {
    schema: {
      body: {
        type: 'object', required: ['body', 'clientMessageId'], additionalProperties: false,
        // `source` is accepted only to answer 422 DM_SOURCE_UNSUPPORTED instead of a generic 400.
        properties: { body: { type: 'string', minLength: 1, maxLength: 100_000 }, clientMessageId: { type: 'string' }, source: { type: 'object' } },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${DM}/messages`, scope: dmScope(request.params.dmId), status: 201,
    run: (actor, conn) => dmUseCases(conn).send(actor, request.params.dmId, request.body),
    replay: readDm(request.params.dmId),
  }));

  app.post<{ Params: { dmId: string } }>(`${DM}/leave`, async (request, reply) => command(request, reply, {
    operation: `POST ${DM}/leave`, scope: dmScope(request.params.dmId), status: 204,
    run: (actor, conn) => dmUseCases(conn).leave(actor, request.params.dmId),
    // After leaving the DM is invisible, so a retry answers 404 like any other request for it.
    replay: readDm(request.params.dmId),
  }));
}
