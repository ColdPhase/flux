import type { FastifyInstance } from 'fastify';
import {
  DRAFTS_PATH,
  WORKSPACES_PATH,
  type CreateDraftCommand,
  type DraftListQuery,
  type MoveDraftCommand,
  type ShareDraftCommand,
  type UpdateDraftCommand,
} from '@flux/contracts';
import { createDraft, getDraft, listDrafts, moveDraft, shareDraft, updateDraft } from '@flux/core';
import { bodyId, expectedVersion, requires, versionEtag } from '../http/commands.js';
import { nameSchema, pageQuery, versionSchema } from '../http/schemas.js';
import type { AccessContext } from './context.js';

const visibilitySchema = { type: 'string', enum: ['private', 'project', 'workspace'] } as const;

/** Drafts (#85): list, create, read, update, share and move; changes need the version they saw. */
export function draftRoutes(app: FastifyInstance, { db, principal, command, workspaceScope, draftScope }: AccessContext) {
  app.get<{ Params: { workspaceId: string }; Querystring: DraftListQuery }>(`${WORKSPACES_PATH}/:workspaceId/drafts`, {
    schema: { querystring: { ...pageQuery, properties: { ...pageQuery.properties, projectId: { type: 'string' } } } },
  }, async (request) => listDrafts(await principal(request), request.params.workspaceId, request.query, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateDraftCommand }>(`${WORKSPACES_PATH}/:workspaceId/drafts`, {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: nameSchema, body: { type: 'string', maxLength: 100_000 }, projectId: { type: 'string' } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/drafts`, scope: workspaceScope(request.params.workspaceId), status: 201, etag: true,
    run: (actor, conn) => createDraft(actor, request.params.workspaceId, request.body, conn),
    replay: requires('draft', 'draft.read', bodyId),
  }));
  app.get<{ Params: { draftId: string } }>(`${DRAFTS_PATH}/:draftId`, async (request, reply) => {
    const draft = await getDraft(await principal(request), request.params.draftId, db);
    return reply.header('etag', versionEtag(draft)).send(draft);
  });
  app.patch<{ Params: { draftId: string }; Body: UpdateDraftCommand }>(`${DRAFTS_PATH}/:draftId`, {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: nameSchema, body: { type: 'string', maxLength: 100_000 }, expectedVersion: versionSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${DRAFTS_PATH}/:draftId`, scope: draftScope(request.params.draftId), etag: true,
    run: (actor, conn) => updateDraft(actor, request.params.draftId, { ...request.body, expectedVersion: expectedVersion(request) }, conn),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));
  app.post<{ Params: { draftId: string }; Body: ShareDraftCommand }>(`${DRAFTS_PATH}/:draftId/share`, {
    schema: { body: { type: 'object', required: ['scope'], additionalProperties: false, properties: { scope: visibilitySchema, projectId: { type: 'string' }, expectedVersion: versionSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${DRAFTS_PATH}/:draftId/share`, scope: draftScope(request.params.draftId), etag: true,
    run: (actor, conn) => shareDraft(actor, request.params.draftId, { ...request.body, expectedVersion: expectedVersion(request) }, conn),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));
  app.post<{ Params: { draftId: string }; Body: MoveDraftCommand }>(`${DRAFTS_PATH}/:draftId/move`, {
    schema: { body: { type: 'object', required: ['projectId', 'visibility'], additionalProperties: false, properties: { projectId: { type: ['string', 'null'] }, visibility: visibilitySchema, expectedVersion: versionSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${DRAFTS_PATH}/:draftId/move`, scope: draftScope(request.params.draftId), etag: true,
    run: (actor, conn) => moveDraft(actor, request.params.draftId, { ...request.body, expectedVersion: expectedVersion(request) }, conn),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));
}
