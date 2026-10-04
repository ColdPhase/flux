import type { FastifyInstance, FastifyRequest } from 'fastify';
import { projectWorkSummaryPath, projectWorkViewPath, projectWorkAssociationsPath, projectWorkRelationsPath, projectWorkReferenceRowsPath, projectWorkThoughtTasksPath } from '@flux/contracts';
import type { Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { nativeWorkReadUseCases } from './adapters.js';

/** Read raw fields so schema coercion/unknown-key removal cannot hide duplicate selectors. */
const query = (request: FastifyRequest) => new URL(request.raw.url ?? '', 'http://flux.invalid').searchParams;
export async function workReadRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: SessionResolver }) {
  useDomainErrors(app);
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'private, no-store'); });
  const prepare = async (request: FastifyRequest) => {
    const session = await sessions.requirePrincipal(request);
    return { reads: nativeWorkReadUseCases(db, sessions, session, request.headers), principal: session.principal };
  };
  app.get<{ Params: { projectId: string } }>(projectWorkSummaryPath(':projectId'), async (request) => {
    const { reads, principal } = await prepare(request); return reads.summary(principal, request.params.projectId, query(request));
  });
  app.get<{ Params: { projectId: string } }>(projectWorkReferenceRowsPath(':projectId'), async (request) => {
    const { reads, principal } = await prepare(request); return reads.references(principal, request.params.projectId, query(request));
  });
  app.get<{ Params: { projectId: string } }>(projectWorkThoughtTasksPath(':projectId'), async (request) => {
    const { reads, principal } = await prepare(request); return reads.thoughtTasks(principal, request.params.projectId, query(request));
  });
  app.get<{ Params: { projectId: string } }>(projectWorkViewPath(':projectId'), async (request) => {
    const { reads, principal } = await prepare(request); return reads.view(principal, request.params.projectId, query(request));
  });
  app.get<{ Params: { projectId: string } }>(projectWorkAssociationsPath(':projectId'), async (request) => {
    const { reads, principal } = await prepare(request); return reads.associations(principal, request.params.projectId, query(request));
  });
  app.get<{ Params: { projectId: string } }>(projectWorkRelationsPath(':projectId'), async (request) => {
    const { reads, principal } = await prepare(request); return reads.relations(principal, request.params.projectId, query(request));
  });
  app.get<{ Params: { projectId: string; kind: string; id: string } }>('/api/v1/projects/:projectId/work-objects/:kind/:id', async (request) => {
    const { reads, principal } = await prepare(request); return reads.detail(principal, request.params.projectId, request.params.kind, request.params.id, query(request));
  });
}
