import type { FastifyInstance } from 'fastify';
import { ownWorkingAgentsPath, projectAgentStopsPath, type StopAgentCommand } from '@flux/contracts';
import { agentStopRows } from '@flux/db';
import { agentStopUseCases, enforce, evaluateProject, recordEvent, type AgentStopPorts, type AgentStopUnitOfWork, type Database, type Transaction } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, requires, useDomainErrors } from '../http/commands.js';
import { eventPorts } from '../events.js';
import { nativeWorkInTransaction } from '../work/adapters.js';

function stopPorts(tx: Transaction): AgentStopPorts {
  return {
    async requireProject(principal, projectId, action) {
      const checked = enforce(await evaluateProject(principal, action, projectId, tx, { lock: action === 'project.write' }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    async canRead(principal, projectId) {
      return (await evaluateProject(principal, 'project.read', projectId, tx)).allowed;
    },
    async isManager(principal, projectId) {
      return (await evaluateProject(principal, 'project.manage', projectId, tx)).allowed;
    },
    // The canonical task update, so the version, history and events are the ordinary ones. The task goes back to
    // nobody; a task that is merely open or blocked keeps its status.
    async releaseTask(principal, task) {
      const work = nativeWorkInTransaction(tx);
      await work.updateWork(principal, task.id, { owner: null, ...(task.status === 'in_progress' ? { status: 'open' as const } : {}) }, task.version);
      await work.flushEvents();
    },
    rows: agentStopRows(tx),
    events: { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, projectId, data); } },
  };
}

/** The stop use cases over one transaction; a command passes its own connection, so an idempotent stop commits with its key. */
export function agentStopUnitOfWork(db: Database): AgentStopUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(stopPorts(tx))) };
}

/**
 * `GET` / `POST /api/v1/projects/:projectId/agent-stops` (#347 S13): project readers see who stopped which agent's work;
 * a manager, the agent's owner or the task's creator stops an agent that holds a task now.
 */
export async function agentStopRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: SessionResolver }) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const stops = agentStopUseCases(agentStopUnitOfWork(db));
  app.get(ownWorkingAgentsPath, async (request, reply) =>
    reply.header('cache-control', 'no-store').send(await stops.working(await principal(request))));
  app.get<{ Params: { projectId: string } }>(projectAgentStopsPath(':projectId'), async (request, reply) =>
    reply.header('cache-control', 'no-store').send(await stops.list(await principal(request), request.params.projectId)));
  app.post<{ Params: { projectId: string }; Body: StopAgentCommand }>(projectAgentStopsPath(':projectId'), {
    schema: { body: { type: 'object', additionalProperties: false, required: ['taskId', 'agentId'],
      properties: { taskId: { type: 'string' }, agentId: { type: 'string' } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${projectAgentStopsPath(':projectId')}`, scope: { type: 'project', id: request.params.projectId }, status: 201,
    run: (actor, conn) => agentStopUseCases(agentStopUnitOfWork(conn)).stop(actor, request.params.projectId, request.body),
    replay: requires('project', 'project.read', () => request.params.projectId),
  }));
}
