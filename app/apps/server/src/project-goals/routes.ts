import type { FastifyInstance } from 'fastify';
import { PROJECT_GOAL_MAX, projectGoalPath, projectGoalReachedPath, projectGoalsPath, type SetProjectGoalCommand } from '@flux/contracts';
import type { ResourceRef } from '@flux/core';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, expectedVersion, requires, useDomainErrors } from '../http/commands.js';
import { projectGoalUseCases } from './adapters.js';

interface Options { db: Database; sessions: SessionResolver }

/**
 * `/api/v1` routes of a project's optional goal (#520, F-028). Each handler resolves the current session
 * and calls one core use case, which authorizes (`project.write` and a signed-in person for changes,
 * `project.read` for the list). Every change needs `If-Match` with the project's version, answers the
 * project's new version as its ETag and accepts `Idempotency-Key`. Nothing here notifies anyone.
 */
export async function projectGoalRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const scope = (id: string): ResourceRef => ({ type: 'project', id });
  const replay = (id: string) => requires('project', 'project.read', () => id);
  const goals = projectGoalUseCases(db);
  const setGoal = { type: 'object', required: ['title'], additionalProperties: false, properties: {
    title: { type: 'string', maxLength: PROJECT_GOAL_MAX * 4 }, expectedVersion: { type: 'integer', minimum: 1 } } } as const;

  app.get<{ Params: { projectId: string } }>(projectGoalsPath(':projectId'), async (request) =>
    goals.list(await principal(request), request.params.projectId));
  app.put<{ Params: { projectId: string }; Body: SetProjectGoalCommand }>(projectGoalPath(':projectId'), { schema: { body: setGoal } },
    async (request, reply) => command(request, reply, {
      operation: `PUT ${projectGoalPath(':projectId')}`, scope: scope(request.params.projectId), etag: true,
      run: (actor, conn) => projectGoalUseCases(conn).set(actor, request.params.projectId, request.body, expectedVersion(request)),
      replay: replay(request.params.projectId),
    }));
  app.delete<{ Params: { projectId: string } }>(projectGoalPath(':projectId'),
    async (request, reply) => command(request, reply, {
      operation: `DELETE ${projectGoalPath(':projectId')}`, scope: scope(request.params.projectId), etag: true,
      run: (actor, conn) => projectGoalUseCases(conn).remove(actor, request.params.projectId, expectedVersion(request)),
      replay: replay(request.params.projectId),
    }));
  app.post<{ Params: { projectId: string } }>(projectGoalReachedPath(':projectId'),
    async (request, reply) => command(request, reply, {
      operation: `POST ${projectGoalReachedPath(':projectId')}`, scope: scope(request.params.projectId), etag: true,
      run: (actor, conn) => projectGoalUseCases(conn).reach(actor, request.params.projectId, expectedVersion(request)),
      replay: replay(request.params.projectId),
    }));
  app.delete<{ Params: { projectId: string } }>(projectGoalReachedPath(':projectId'),
    async (request, reply) => command(request, reply, {
      operation: `DELETE ${projectGoalReachedPath(':projectId')}`, scope: scope(request.params.projectId), etag: true,
      run: (actor, conn) => projectGoalUseCases(conn).reopen(actor, request.params.projectId, expectedVersion(request)),
      replay: replay(request.params.projectId),
    }));
}
