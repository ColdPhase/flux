import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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
import { DomainError,ServiceUnavailableError,derivedUuid, requestHash, type Database, type FileStorage, type Principal, type ResourceRef,type LiveMapBackend } from '@flux/core';
import type { SessionContext, SessionResolver } from '../identity/index.js';
import { bodyId, commandRunner, expectedVersion, requires, useDomainErrors, versionEtag } from '../http/commands.js';
import { sketchUseCases } from './adapters.js';
import { EditingHTTPAdmission } from '../editing/http-admission.js';
import { apiEditingOutputBudget } from '../editing/output.js';
import { editingMapContextCharge } from '../editing/context-charge.js';
import { editingJSONSize } from '../editing/json-size.js';
import { editingHTTPLifetime, type EditingHTTPLifetime } from '../editing/http-lifetime.js';
import type { CommandSpec } from '../http/commands.js';

export interface SketchRouteOptions {
  db: Database;
  sessions: SessionResolver;
  /** The files volume: a new thought may take the caller's staged image (#252). */
  storage: FileStorage;
  developmentEditing?:boolean;liveBackend?:()=>LiveMapBackend|null;
}

const id = { type: 'string', minLength: 1, maxLength: 64 } as const;
const number = { type: 'number' } as const;
const version = { type: 'integer', minimum: 1 } as const;
const label = { type: ['string', 'null'], maxLength: 200 } as const;
const shape = { type: 'string', enum: [...THOUGHT_SHAPES] } as const;
const WORKSPACE_SKETCHES = '/api/v1/workspaces/:workspaceId/sketches';
const SKETCH = `${SKETCHES_PATH}/:sketchId`;
const routeUrl=(request:FastifyRequest)=>{const url=request.routeOptions.url;if(typeof url!=='string'||!url)throw new ServiceUnavailableError('The native command route is unavailable','EDITING_MAP_CAPACITY');return url;};

/**
 * `/api/v1` sketch routes (issue #69). Handlers resolve the session on every request and call
 * one core use case, which authorizes through the access policy. POST/PATCH/DELETE accept
 * `Idempotency-Key`; renaming, editing, moving and removing thoughts need their version
 * (`If-Match` or `expectedVersion`; batch moves carry one per thought).
 */
export async function sketchRoutes(app: FastifyInstance, { db, sessions, storage,developmentEditing=false,liveBackend }: SketchRouteOptions) {
  useDomainErrors(app);
  const domainErrors=app.errorHandler;
  app.setErrorHandler(function(error,request,reply) {
    // Preserve the original error and healthy postimages; a real terminal HTTP
    // response must not enter the ordinary protected error serializer again.
    if(error instanceof DomainError&&(reply.raw.writableFinished||'closed' in reply.raw&&reply.raw.closed===true))return reply.hijack();
    return domainErrors.call(this,error,request,reply);
  });
  const runner=commandRunner(db,sessions);const {principal}=runner;
  const preparation=new EditingHTTPAdmission(apiEditingOutputBudget);app.addHook('onClose',async()=>preparation.close());
  const lifetimes=new WeakMap<FastifyReply,EditingHTTPLifetime>();
  async function command(request:FastifyRequest,reply:FastifyReply,spec:CommandSpec) {
    let owner:EditingHTTPLifetime|undefined;
    try {
      const lifetime=editingHTTPLifetime(reply.raw,apiEditingOutputBudget,{deferCharge:!developmentEditing});owner=lifetime;lifetimes.set(reply,lifetime);
      if(!developmentEditing) {
        const response=await runner.runCommand(request,spec);
        if(!lifetime.canSend)return reply.hijack();
        return runner.sendCommand(reply,response);
      }
      lifetime.retain(apiEditingOutputBudget.reserve(editingMapContextCharge({params:request.params,headers:request.headers,body:request.body,query:request.query})));
      lifetime.retain(await preparation.admit(0));
      const response=await runner.runCommand(request,spec);
      const session=await sessions.requirePrincipal(request);const backend=liveBackend?.();
      if(!backend)throw new ServiceUnavailableError('The live map adapter is closing','EDITING_MAP_CAPACITY');
      const params=request.params as {sketchId?:string};const body=response.body as {id?:string;sketch?:{id?:string}}|null;
      const target=routeUrl(request).endsWith('/promotion')?body?.sketch?.id:params.sketchId??body?.id;
      if(!target)throw new ServiceUnavailableError('The native map receipt has no target','EDITING_MAP_CAPACITY');
      await backend.deliverNative({sessionId:session.sessionId,actorId:session.principal.id},target,response.body,current=>{
        if(!lifetime.canSend)return;
        const size=response.status===204?0:editingJSONSize(current).bytes;const text=response.status===204?'':JSON.stringify(current);
        if(Buffer.byteLength(text)!==size)throw new ServiceUnavailableError('The protected native response is too large','EDITING_OUTPUT_CAPACITY');
        const owned=Buffer.allocUnsafeSlow(size);owned.write(text);
        const headers:Record<string,string|number>={'cache-control':'no-store','content-length':size};
        if(response.status!==204)headers['content-type']='application/json; charset=utf-8';
        if(response.etag)headers.etag=response.etag;if(response.replayed)headers['idempotent-replayed']='true';
        reply.hijack();reply.raw.writeHead(response.status,headers);reply.raw.end(owned);
      });
    } catch(error) {
      if(!developmentEditing)throw error;
      if(error instanceof Error&&'code' in error&&['EDITING_MAP_CAPACITY','EDITING_OUTPUT_CAPACITY'].includes(String(error.code))) {
        const refusal=new ServiceUnavailableError('The finite native map capacity is busy',String(error.code));refusal.details={outcome:'refused',retryable:true};throw refusal;
      }
      if(error instanceof DomainError)error.details={};throw error;
    }
    finally {owner?.settled();lifetimes.delete(reply);}
  }
  const sketches = sketchUseCases(db);
  function native(conn:Database,actor:Principal,request:FastifyRequest,session:SessionContext,reply:import('fastify').FastifyReply) {
    const key=request.headers['idempotency-key'];const original=typeof key==='string'?key:null;
    const url=routeUrl(request);
    const uuid=original&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(original)?original.toLowerCase():original?derivedUuid('flux.map.legacy-key.v1',actor.kind,actor.id,request.method,url,original):undefined;
    const lifetime=lifetimes.get(reply);if(!lifetime)throw new Error('Native HTTP work has no response owner');
    return sketchUseCases(conn,storage,{context:{params:request.params,body:request.body,query:request.query,headers:request.headers,session},prepared:developmentEditing,resourceId:(request.params as {sketchId?:string}).sketchId,principal:actor,sessionId:session.sessionId,commandId:uuid,protectLifetime:()=>lifetime.protect(),retainUntil:(release)=>lifetime.retain(release),
      operation:`native:${request.method} ${url}`,fingerprint:requestHash({params:request.params,body:request.body??null,query:request.query,ifMatch:request.headers['if-match']??null})});
  }
  const sketchScope = (sketchId: string): ResourceRef => ({ type: 'sketch', id: sketchId });
  const readSketch = (sketchId: string) => requires('sketch', 'sketch.read', () => sketchId);
  const thoughtEtag = (body: unknown) => versionEtag((body as CreatedThought | null)?.thought ?? null);

  app.get<{ Params: { workspaceId: string }; Querystring: SketchListQuery }>(WORKSPACE_SKETCHES, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, offset: { type: 'integer' }, projectId: { type: 'string' }, dmId: { type: 'string' }, scope: { type: 'string', enum: ['private'] } } } },
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
    run: (actor, conn, session) => native(conn,actor,request,session,reply).create(actor, request.params.workspaceId, request.body),
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
    run: (actor, conn, session) => native(conn,actor,request,session,reply).rename(actor, request.params.sketchId, { ...request.body, expectedVersion: expectedVersion(request) }),
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
          sourceMessageId: id, fileId: id,
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${SKETCH}/thoughts`, scope: sketchScope(request.params.sketchId), status: 201, etag: thoughtEtag,
    run: (actor, conn, session) => native(conn,actor,request,session,reply).addThought(actor, request.params.sketchId, request.body),
    replay: readSketch(request.params.sketchId),
  }));

  app.patch<{ Params: { sketchId: string; thoughtId: string }; Body: UpdateThoughtCommand }>(`${SKETCH}/thoughts/:thoughtId`, {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { text: { type: 'string', maxLength: 2000 }, x: number, y: number, width: number, height: number, shape, expectedVersion: version, leaseId:id },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${SKETCH}/thoughts/:thoughtId`, scope: sketchScope(request.params.sketchId), etag: true,
    run: (actor, conn, session) => native(conn,actor,request,session,reply).updateThought(actor, request.params.sketchId, request.params.thoughtId, { ...request.body, expectedVersion: expectedVersion(request) }),
    replay: readSketch(request.params.sketchId),
  }));

  app.delete<{ Params: { sketchId: string; thoughtId: string } }>(`${SKETCH}/thoughts/:thoughtId`, async (request, reply) => command(request, reply, {
    operation: `DELETE ${SKETCH}/thoughts/:thoughtId`, scope: sketchScope(request.params.sketchId), status: 204,
    run: (actor, conn, session) => native(conn,actor,request,session,reply).removeThought(actor, request.params.sketchId, request.params.thoughtId, expectedVersion(request)),
    replay: readSketch(request.params.sketchId),
  }));

  app.patch<{ Params: { sketchId: string }; Body: MoveThoughtsCommand }>(`${SKETCH}/positions`, {
    schema: {
      body: {
        type: 'object', required: ['moves'], additionalProperties: false,
        properties: {
          leaseId:id, moves: {
            type: 'array', minItems: 1, maxItems: 200,
            items: { type: 'object', required: ['id', 'x', 'y'], additionalProperties: false, properties: { id, x: number, y: number, expectedVersion: version } },
          },
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${SKETCH}/positions`, scope: sketchScope(request.params.sketchId),
    run: (actor, conn, session) => native(conn,actor,request,session,reply).moveThoughts(actor, request.params.sketchId, request.body),
    replay: readSketch(request.params.sketchId),
  }));

  app.post<{ Params: { sketchId: string }; Body: CreateLinkCommand }>(`${SKETCH}/links`, {
    schema: { body: { type: 'object', required: ['fromId', 'toId'], additionalProperties: false, properties: { id, fromId: id, toId: id, label } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${SKETCH}/links`, scope: sketchScope(request.params.sketchId), status: 201,
    run: (actor, conn, session) => native(conn,actor,request,session,reply).addLink(actor, request.params.sketchId, request.body),
    replay: readSketch(request.params.sketchId),
  }));

  // #96: copying a DM sketch into a project. GET previews exactly who could open the copy and
  // what goes in; POST makes the copy when the preview's token still matches. `participants`
  // (#188) says whether a new project is granted to the DM's other participants.
  const participantsSchema = { type: 'string', enum: ['grant', 'none'] } as const;
  app.get<{ Params: { sketchId: string }; Querystring: { target?: string; projectId?: string; participants?: string } }>(`${SKETCH}/promotion`, {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { target: { type: 'string', enum: ['new'] }, projectId: { type: 'string' }, participants: participantsSchema } } },
  }, async (request) => sketches.previewPromotion(await principal(request), request.params.sketchId, request.query));

  app.post<{ Params: { sketchId: string }; Body: PromoteSketchCommand }>(`${SKETCH}/promotion`, {
    schema: {
      body: {
        type: 'object', required: ['target', 'token'], additionalProperties: false,
        properties: {
          token: { type: 'string', minLength: 1, maxLength: 200 },
          participants: participantsSchema,
          target: {
            type: 'object', required: ['kind'], additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['new', 'existing'] }, name: { type: 'string', maxLength: 400 }, projectId: id },
          },
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${SKETCH}/promotion`, scope: sketchScope(request.params.sketchId), status: 201,
    run: (actor, conn, session) => native(conn,actor,request,session,reply).promote(actor, request.params.sketchId, request.body),
    // A replay answers only while the caller can still open the copy it made.
    replay: requires('sketch', 'sketch.read', (body) => (body as { sketch?: { id?: string } } | null)?.sketch?.id ?? ''),
  }));

  app.delete<{ Params: { sketchId: string; linkId: string } }>(`${SKETCH}/links/:linkId`, async (request, reply) => command(request, reply, {
    operation: `DELETE ${SKETCH}/links/:linkId`, scope: sketchScope(request.params.sketchId), status: 204,
    run: (actor, conn, session) => native(conn,actor,request,session,reply).removeLink(actor, request.params.sketchId, request.params.linkId),
    replay: readSketch(request.params.sketchId),
  }));
}
