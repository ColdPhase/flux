import type { FastifyInstance } from 'fastify';
import {
  DOC_LIMITS,
  docPath,
  docSectionsPath,
  docVersionPath,
  docVersionsPath,
  projectDocPreviewPath,
  projectDocsPath,
  workspaceDocsPath,
  type AddDocSectionCommand,
  type CreateDocCommand,
  type DocPreviewCommand,
  type PageQuery,
  type UpdateDocCommand,
} from '@flux/contracts';
import { assertAuthorized, type DocTaskUseMemory, type Database, type ResourceRef } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, expectedVersion, useDomainErrors, versionEtag, type CommandSpec, type ReplayCheck } from '../http/commands.js';
import { prepareDocWrite } from './preparation.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { docUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver }

const page = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } as const;
const title = { type: 'string', minLength: 1, maxLength: DOC_LIMITS.title } as const;
const body = { type: 'string', maxLength: DOC_LIMITS.body } as const;
const state = { type: 'string', enum: ['draft', 'published'] } as const;
const reason = { type: 'string', maxLength: DOC_LIMITS.reason } as const;
const source = { type: 'object', required: ['type', 'id'], additionalProperties: false,
  properties: { type: { type: 'string', enum: ['result', 'decision'] }, id: { type: 'string' } } } as const;
const version = { type: 'integer', minimum: 1 } as const;

const createDoc = { type: 'object', required: ['title'], additionalProperties: false, properties: { title, body, state, reason, from: source } } as const;
const updateDoc = { type: 'object', additionalProperties: false, minProperties: 1, properties: { title, body, state, reason, expectedVersion: version } } as const;
const addSection = { type: 'object', required: ['from'], additionalProperties: false, properties: { from: source, expectedVersion: version } } as const;
const preview = { type: 'object', required: ['body'], additionalProperties: false, properties: { body } } as const;

/** A replay needs current read access to the project named in the stored response. */
const projectReader: ReplayCheck = (principal, stored, db) =>
  assertAuthorized(principal, 'project.read', { type: 'project', id: String((stored as { projectId?: unknown } | null)?.projectId ?? '') }, db);

/**
 * `/api/v1` doc routes (#112). Each handler resolves the current session and calls one core use
 * case, which authorizes. POST/PATCH accept `Idempotency-Key`; an edit and "Add to docs" on an
 * existing doc need `If-Match` (or `expectedVersion`). Responses with a version carry `ETag`.
 */
export async function docRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const { principal, runCommand, sendCommand } = commandRunner(db, sessions);
  async function command(request: FastifyRequest, reply: FastifyReply, spec: (memory: DocTaskUseMemory) => CommandSpec) {
    const preparation = await prepareDocWrite({params: request.params, headers: request.headers, body: request.body});
    let sqlSettled = false; let responseSettled = reply.raw.destroyed || reply.raw.writableFinished;
    const release = () => { responseSettled = true; if (sqlSettled) preparation.release(); };
    reply.raw.once('finish', release); reply.raw.once('close', release);
    try {
      const result = await runCommand(request, spec(preparation.memory));
      sqlSettled = true;
      if (responseSettled) { preparation.release(); return reply; }
      return sendCommand(reply, result);
    } catch (error) {
      sqlSettled = true;
      if (responseSettled) preparation.release();
      // A protected conflict postimage remains owned through the error response.
      throw error;
    }
  }
  const docs = docUseCases(db);
  const projectScope = (id: string): ResourceRef => ({ type: 'project', id });

  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>(projectDocsPath(':projectId'), { schema: { querystring: page } },
    async (request) => docs.listProjectDocs(await principal(request), request.params.projectId, request.query));
  app.post<{ Params: { projectId: string }; Body: CreateDocCommand }>(projectDocsPath(':projectId'), { schema: { body: createDoc } },
    async (request, reply) => command(request, reply, memory => ({
      operation: `POST ${projectDocsPath(':projectId')}`, scope: projectScope(request.params.projectId), status: 201, etag: true,
      run: (actor, conn) => docUseCases(conn, memory).createDoc(actor, request.params.projectId, request.body),
      replay: projectReader,
    })));
  app.post<{ Params: { projectId: string }; Body: DocPreviewCommand }>(projectDocPreviewPath(':projectId'), { schema: { body: preview } },
    async (request) => docs.preview(await principal(request), request.params.projectId, request.body));

  app.get<{ Params: { docId: string } }>(docPath(':docId'), async (request, reply) => {
    const doc = await docs.getDoc(await principal(request), request.params.docId);
    return reply.header('etag', versionEtag(doc)).send(doc);
  });
  app.patch<{ Params: { docId: string }; Body: UpdateDocCommand }>(docPath(':docId'), { schema: { body: updateDoc } },
    async (request, reply) => command(request, reply, memory => ({
      operation: `PATCH ${docPath(':docId')}`, scope: null, etag: true,
      run: (actor, conn) => docUseCases(conn, memory).updateDoc(actor, request.params.docId, request.body, expectedVersion(request)),
      replay: projectReader,
    })));
  app.post<{ Params: { docId: string }; Body: AddDocSectionCommand }>(docSectionsPath(':docId'), { schema: { body: addSection } },
    async (request, reply) => command(request, reply, memory => ({
      operation: `POST ${docSectionsPath(':docId')}`, scope: null, etag: true,
      run: (actor, conn) => docUseCases(conn, memory).addSection(actor, request.params.docId, request.body, expectedVersion(request)),
      replay: projectReader,
    })));
  app.get<{ Params: { docId: string }; Querystring: PageQuery }>(docVersionsPath(':docId'), { schema: { querystring: page } },
    async (request) => docs.listVersions(await principal(request), request.params.docId, request.query));
  app.get<{ Params: { docId: string; version: string } }>(docVersionPath(':docId', ':version' as unknown as number),
    async (request) => docs.getVersion(await principal(request), request.params.docId, request.params.version));

  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(workspaceDocsPath(':workspaceId'), { schema: { querystring: page } },
    async (request) => docs.listWorkspaceDocs(await principal(request), request.params.workspaceId, request.query));
}
