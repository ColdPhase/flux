import type { FastifyInstance } from 'fastify';
import {
  SKETCHES_PATH,
  THOUGHT_SHAPES,
  type CreateLinkCommand,
  type CreateSketchCommand,
  type CreatedThought,
  type CreateThoughtCommand,
  type MoveThoughtsCommand,
  type PromoteSketchCommand,
  type SketchListQuery,
  type UpdateSketchCommand,
  type UpdateThoughtCommand,
} from '@flux/contracts';
import type { Database, ResourceRef } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { bodyId, commandRunner, expectedVersion, requires, useDomainErrors, versionEtag } from '../http/commands.js';
import { sketchUseCases } from './adapters.js';

export interface SketchRouteOptions {
  db: Database;
  sessions: SessionResolver;
}

const id = { type: 'string', minLength: 1, maxLength: 64 } as const;
const number = { type: 'number' } as const;
const version = { type: 'integer', minimum: 1 } as const;
const label = { type: ['string', 'null'], maxLength: 200 } as const;
const shape = { type: 'string', enum: [...THOUGHT_SHAPES] } as const;
const WORKSPACE_SKETCHES = '/api/v1/workspaces/:workspaceId/sketches';
const SKETCH = `${SKETCHES_PATH}/:sketchId`;

/**
 * `/api/v1` sketch routes (issue #69). Handlers resolve the session on every request and call
 * one core use case, which authorizes through the access policy. POST/PATCH/DELETE accept
 * `Idempotency-Key`; renaming, editing, moving and removing thoughts need their version
 * (`If-Match` or `expectedVersion`; batch moves carry one per thought).
 */
export async function sketchRoutes(app: FastifyInstance, { db, sessions }: SketchRouteOptions) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const sketches = sketchUseCases(db);
  const sketchScope = (sketchId: string): ResourceRef => ({ type: 'sketch', id: sketchId });
  const readSketch = (sketchId: string) => requires('sketch', 'sketch.read', () => sketchId);
  const thoughtEtag = (body: unknown) => versionEtag((body as CreatedThought | null)?.thought ?? null);

  app.get<{ Params: { workspaceId: string }; Querystring: SketchListQuery }>(WORKSPACE_SKETCHES, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, offset: { type: 'integer' }, projectId: { type: 'string' }, dmId: { type: 'string' } } } },
  }, async (request) => sketches.list(await principal(request), request.params.workspaceId, request.query));

  app.post<{ Params: { workspaceId: string }; Body: CreateSketchCommand }>(WORKSPACE_SKETCHES, {
    schema: {
      body: {
        type: 'object', required: ['title', 'scope'], additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: 400 }, scope: { type: 'string', enum: ['project', 'private', 'dm'] }, projectId: id, dmId: id,
          fromMessageIds: { type: 'array', minItems: 1, maxItems: 50, items: id },
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACE_SKETCHES}`, scope: { type: 'workspace', id: request.params.workspaceId }, status: 201, etag: true,
    run: (actor, conn) => sketchUseCases(conn).create(actor, request.params.workspaceId, request.body),
    replay: requires('sketch', 'sketch.read', bodyId),
  }));

  app.get<{ Params: { sketchId: string } }>(SKETCH, async (request, reply) => {
    const sketch = await sketches.get(await principal(request), request.params.sketchId);
    return reply.header('etag', versionEtag(sketch)).send(sketch);
  });

  app.patch<{ Params: { sketchId: string }; Body: UpdateSketchCommand }>(SKETCH, {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', maxLength: 400 }, expectedVersion: version } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${SKETCH}`, scope: sketchScope(request.params.sketchId), etag: true,
    run: (actor, conn) => sketchUseCases(conn).rename(actor, request.params.sketchId, { ...request.body, expectedVersion: expectedVersion(request) }),
    replay: readSketch(request.params.sketchId),
  }));

  app.post<{ Params: { sketchId: string }; Body: CreateThoughtCommand }>(`${SKETCH}/thoughts`, {
    schema: {
      body: {
        type: 'object', required: ['text', 'x', 'y'], additionalProperties: false,
        properties: {
          id, text: { type: 'string', maxLength: 2000 }, x: number, y: number, width: number, height: number, shape,
          placement: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { type: 'string', enum: ['draft'] }, id } },
          linkFrom: { type: 'object', required: ['thoughtId'], additionalProperties: false, properties: { thoughtId: id, label, linkId: id } },
          sourceMessageId: id,
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${SKETCH}/thoughts`, scope: sketchScope(request.params.sketchId), status: 201, etag: thoughtEtag,
    run: (actor, conn) => sketchUseCases(conn).addThought(actor, request.params.sketchId, request.body),
    replay: readSketch(request.params.sketchId),
  }));

  app.patch<{ Params: { sketchId: string; thoughtId: string }; Body: UpdateThoughtCommand }>(`${SKETCH}/thoughts/:thoughtId`, {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { text: { type: 'string', maxLength: 2000 }, x: number, y: number, width: number, height: number, shape, expectedVersion: version },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${SKETCH}/thoughts/:thoughtId`, scope: sketchScope(request.params.sketchId), etag: true,
    run: (actor, conn) => sketchUseCases(conn).updateThought(actor, request.params.sketchId, request.params.thoughtId, { ...request.body, expectedVersion: expectedVersion(request) }),
    replay: readSketch(request.params.sketchId),
  }));

  app.delete<{ Params: { sketchId: string; thoughtId: string } }>(`${SKETCH}/thoughts/:thoughtId`, async (request, reply) => command(request, reply, {
    operation: `DELETE ${SKETCH}/thoughts/:thoughtId`, scope: sketchScope(request.params.sketchId), status: 204,
    run: (actor, conn) => sketchUseCases(conn).removeThought(actor, request.params.sketchId, request.params.thoughtId, expectedVersion(request)),
    replay: readSketch(request.params.sketchId),
  }));

  app.patch<{ Params: { sketchId: string }; Body: MoveThoughtsCommand }>(`${SKETCH}/positions`, {
    schema: {
      body: {
        type: 'object', required: ['moves'], additionalProperties: false,
        properties: {
          moves: {
            type: 'array', minItems: 1, maxItems: 200,
            items: { type: 'object', required: ['id', 'x', 'y'], additionalProperties: false, properties: { id, x: number, y: number, expectedVersion: version } },
          },
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${SKETCH}/positions`, scope: sketchScope(request.params.sketchId),
    run: (actor, conn) => sketchUseCases(conn).moveThoughts(actor, request.params.sketchId, request.body),
    replay: readSketch(request.params.sketchId),
  }));

  app.post<{ Params: { sketchId: string }; Body: CreateLinkCommand }>(`${SKETCH}/links`, {
    schema: { body: { type: 'object', required: ['fromId', 'toId'], additionalProperties: false, properties: { id, fromId: id, toId: id, label } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${SKETCH}/links`, scope: sketchScope(request.params.sketchId), status: 201,
    run: (actor, conn) => sketchUseCases(conn).addLink(actor, request.params.sketchId, request.body),
    replay: readSketch(request.params.sketchId),
  }));

  // #96: copying a DM sketch into a project. GET previews exactly who could open the copy and
  // what goes in; POST makes the copy when the preview's token still matches.
  app.get<{ Params: { sketchId: string }; Querystring: { target?: string; projectId?: string } }>(`${SKETCH}/promotion`, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { target: { type: 'string', enum: ['new'] }, projectId: { type: 'string' } } } },
  }, async (request) => sketches.previewPromotion(await principal(request), request.params.sketchId, request.query));

  app.post<{ Params: { sketchId: string }; Body: PromoteSketchCommand }>(`${SKETCH}/promotion`, {
    schema: {
      body: {
        type: 'object', required: ['target', 'token'], additionalProperties: false,
        properties: {
          token: { type: 'string', minLength: 1, maxLength: 200 },
          target: {
            type: 'object', required: ['kind'], additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['new', 'existing'] }, name: { type: 'string', maxLength: 400 }, projectId: id },
          },
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${SKETCH}/promotion`, scope: sketchScope(request.params.sketchId), status: 201,
    run: (actor, conn) => sketchUseCases(conn).promote(actor, request.params.sketchId, request.body),
    // A replay answers only while the caller can still open the copy it made.
    replay: requires('sketch', 'sketch.read', (body) => (body as { sketch?: { id?: string } } | null)?.sketch?.id ?? ''),
  }));

  app.delete<{ Params: { sketchId: string; linkId: string } }>(`${SKETCH}/links/:linkId`, async (request, reply) => command(request, reply, {
    operation: `DELETE ${SKETCH}/links/:linkId`, scope: sketchScope(request.params.sketchId), status: 204,
    run: (actor, conn) => sketchUseCases(conn).removeLink(actor, request.params.sketchId, request.params.linkId),
    replay: readSketch(request.params.sketchId),
  }));
}
