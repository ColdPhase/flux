import type { FastifyInstance } from 'fastify';
import {
  decisionAcceptPath,
  decisionPath,
  projectDecisionsPath,
  projectLinksPath,
  projectResultsPath,
  projectWorkPath,
  resultPath,
  WORK_LIMITS,
  WORK_STATUSES,
  workItemPath,
  workspaceAssignedWorkPath,
  type AcceptDecisionCommand,
  type CreateObjectLinkCommand,
  type CreateResultCommand,
  type CreateWorkCommand,
  type PageQuery,
  type ProposeDecisionCommand,
  type UpdateWorkCommand,
} from '@flux/contracts';
import { assertAuthorized, type Database, type ResourceRef } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, expectedVersion, useDomainErrors, versionEtag, type ReplayCheck } from '../http/commands.js';
import { workUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver }

const page = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } as const;
const title = { type: 'string', minLength: 1, maxLength: WORK_LIMITS.title } as const;
const principalRef = { type: ['object', 'null'], required: ['kind', 'id'], additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['human', 'agent'] }, id: { type: 'string', minLength: 1 } } } as const;
const objectRef = { type: 'object', required: ['type', 'id'], additionalProperties: false,
  properties: { type: { type: 'string', enum: ['message', 'thought', 'material', 'work', 'decision', 'result'] }, id: { type: 'string' }, version: { type: 'integer' } } } as const;
const refs = { type: 'array', maxItems: WORK_LIMITS.links, items: objectRef } as const;
const ids = { type: 'array', maxItems: WORK_LIMITS.links, items: { type: 'string' } } as const;
const status = { type: 'string', enum: [...WORK_STATUSES] } as const;
const version = { type: 'integer', minimum: 1 } as const;

const createWork = { type: 'object', required: ['title'], additionalProperties: false, properties: {
  title, outcome: { type: 'string', maxLength: WORK_LIMITS.outcome }, owner: principalRef, status,
  blocker: { type: 'string', maxLength: WORK_LIMITS.blocker }, sources: refs, related: refs,
} } as const;
const updateWork = { type: 'object', additionalProperties: false, minProperties: 1, properties: {
  title, outcome: { type: 'string', maxLength: WORK_LIMITS.outcome }, owner: principalRef, status,
  blocker: { type: ['string', 'null'], maxLength: WORK_LIMITS.blocker }, parked: { type: 'boolean', enum: [false] }, expectedVersion: version,
} } as const;
const proposeDecision = { type: 'object', required: ['title'], additionalProperties: false, properties: {
  title, rationale: { type: 'string', maxLength: WORK_LIMITS.rationale }, supersedes: { type: 'string' }, sources: refs, affects: ids,
} } as const;
const acceptDecision = { type: 'object', additionalProperties: false, properties: { stillApplies: ids, park: ids, expectedVersion: version } } as const;
const createResult = { type: 'object', required: ['title', 'finding'], additionalProperties: false, properties: {
  title, finding: { type: 'string', enum: ['positive', 'negative'] }, evidence: { type: 'string', maxLength: WORK_LIMITS.evidence },
  sources: refs, work: ids, decisions: ids, finishes: { type: 'object', required: ['id', 'expectedVersion'], additionalProperties: false, properties: { id: { type: 'string' }, expectedVersion: version } },
} } as const;
const createLink = { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: {
  from: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { type: 'string', enum: ['work', 'decision', 'result'] }, id: { type: 'string' } } },
  to: objectRef,
} } as const;

/** A replay needs current read access to the project named in the stored response. */
const projectReader: ReplayCheck = (principal, body, db) =>
  assertAuthorized(principal, 'project.read', { type: 'project', id: String((body as { projectId?: unknown } | null)?.projectId ?? '') }, db);

/**
 * `/api/v1` work, decision and result routes (#101). Each handler resolves the current session
 * and calls one core use case, which authorizes. Every POST/PATCH accepts `Idempotency-Key`;
 * changing work and accepting a decision need `If-Match` (or `expectedVersion`).
 */
export async function workRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const work = workUseCases(db);
  const projectScope = (id: string): ResourceRef => ({ type: 'project', id });

  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>(projectWorkPath(':projectId'), { schema: { querystring: page } },
    async (request) => work.listWork(await principal(request), request.params.projectId, request.query));
  app.post<{ Params: { projectId: string }; Body: CreateWorkCommand }>(projectWorkPath(':projectId'), { schema: { body: createWork } },
    async (request, reply) => command(request, reply, {
      operation: `POST ${projectWorkPath(':projectId')}`, scope: projectScope(request.params.projectId), status: 201, etag: true,
      run: (actor, conn) => workUseCases(conn).createWork(actor, request.params.projectId, request.body),
      replay: projectReader,
    }));
  app.get<{ Params: { workId: string } }>(workItemPath(':workId'), async (request, reply) => {
    const item = await work.getWork(await principal(request), request.params.workId);
    return reply.header('etag', versionEtag(item)).send(item);
  });
  app.patch<{ Params: { workId: string }; Body: UpdateWorkCommand }>(workItemPath(':workId'), { schema: { body: updateWork } },
    async (request, reply) => command(request, reply, {
      operation: `PATCH ${workItemPath(':workId')}`, scope: null, etag: true,
      run: (actor, conn) => workUseCases(conn).updateWork(actor, request.params.workId, request.body, expectedVersion(request)),
      replay: projectReader,
    }));

  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>(projectDecisionsPath(':projectId'), { schema: { querystring: page } },
    async (request) => work.listDecisions(await principal(request), request.params.projectId, request.query));
  app.post<{ Params: { projectId: string }; Body: ProposeDecisionCommand }>(projectDecisionsPath(':projectId'), { schema: { body: proposeDecision } },
    async (request, reply) => command(request, reply, {
      operation: `POST ${projectDecisionsPath(':projectId')}`, scope: projectScope(request.params.projectId), status: 201, etag: true,
      run: (actor, conn) => workUseCases(conn).proposeDecision(actor, request.params.projectId, request.body),
      replay: projectReader,
    }));
  app.get<{ Params: { decisionId: string } }>(decisionPath(':decisionId'), async (request, reply) => {
    const decision = await work.getDecision(await principal(request), request.params.decisionId);
    return reply.header('etag', versionEtag(decision)).send(decision);
  });
  app.post<{ Params: { decisionId: string }; Body: AcceptDecisionCommand }>(decisionAcceptPath(':decisionId'), { schema: { body: acceptDecision } },
    async (request, reply) => command(request, reply, {
      operation: `POST ${decisionAcceptPath(':decisionId')}`, scope: null, etag: true,
      run: (actor, conn) => workUseCases(conn).acceptDecision(actor, request.params.decisionId, request.body ?? {}, expectedVersion(request)),
      replay: projectReader,
    }));

  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>(projectResultsPath(':projectId'), { schema: { querystring: page } },
    async (request) => work.listResults(await principal(request), request.params.projectId, request.query));
  app.post<{ Params: { projectId: string }; Body: CreateResultCommand }>(projectResultsPath(':projectId'), { schema: { body: createResult } },
    async (request, reply) => command(request, reply, {
      operation: `POST ${projectResultsPath(':projectId')}`, scope: projectScope(request.params.projectId), status: 201,
      run: (actor, conn) => workUseCases(conn).createResult(actor, request.params.projectId, request.body),
      replay: projectReader,
    }));
  app.get<{ Params: { resultId: string } }>(resultPath(':resultId'), async (request) => work.getResult(await principal(request), request.params.resultId));

  app.post<{ Params: { projectId: string }; Body: CreateObjectLinkCommand }>(projectLinksPath(':projectId'), { schema: { body: createLink } },
    async (request, reply) => command(request, reply, {
      operation: `POST ${projectLinksPath(':projectId')}`, scope: projectScope(request.params.projectId), status: 201,
      run: (actor, conn) => workUseCases(conn).createLink(actor, request.params.projectId, request.body),
      replay: projectReader,
    }));

  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(workspaceAssignedWorkPath(':workspaceId'), { schema: { querystring: page } },
    async (request) => work.listAssigned(await principal(request), request.params.workspaceId, request.query));
}
