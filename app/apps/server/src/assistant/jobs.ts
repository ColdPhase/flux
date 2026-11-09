import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  ASSISTANT_JOB_LIMITS, assistantJobHistoryPath, assistantJobNotePath, assistantJobPath, assistantJobRestorePath,
  assistantJobRunNowPath, assistantJobsPath, type CreateAssistantJob, type UpdateAssistantJob,
} from '@flux/contracts';
import {
  createAssistantJobs, createPersonalRunUseCases, noPersonalConnections, type AssistantJobUnitOfWork, type PersonalConnectionLookup,
  type PersonalRuntimeAvailability,
} from '@flux/core';
import { assistantJobRows, type Database } from '@flux/db';
import { expectedVersion } from '../http/commands.js';
import type { SessionResolver } from '../identity/index.js';
import { personalRunPorts, personalRunUnitOfWork, type PersonalRunQueueFactory } from '../personal-runs/adapters.js';
import { withTaskUseErrors } from '../work/task-use-errors.js';
import { transactionEventSession } from '../work/transaction-events.js';

// An agent's schedules for its owner (F-036 AG-9, #858). Every route resolves the owner from the session and the agent in the path
// must be theirs: another member or a guest gets the same 404 as for a schedule that does not exist. The server only prepares,
// changes and starts schedules; the worker's per-minute tick fires them.

interface Composition {
  queue: PersonalRunQueueFactory;
  connections?: PersonalConnectionLookup;
  providerEnabled?: boolean;
  runtime?: PersonalRuntimeAvailability;
}

/** The server's unit of work for schedules: the personal-run ports a firing needs, plus the schedule rows. */
export function assistantJobUnitOfWork(db: Database, queue: PersonalRunQueueFactory): AssistantJobUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => withTaskUseErrors(() => work({ ...personalRunPorts(tx, queue, session, session), jobs: assistantJobRows(tx) })));
    await session.flushEvents();
    return result;
  }) };
}

export function assistantJobUseCases(db: Database, boss: Pick<PgBoss, 'send'>, { queue, connections, providerEnabled = false, runtime }: Composition) {
  const runs = createPersonalRunUseCases({ uow: personalRunUnitOfWork(db, queue), connections: connections ?? noPersonalConnections, providerEnabled,
    ...(runtime ? { runtime } : {}) });
  return createAssistantJobs({ uow: assistantJobUnitOfWork(db, queue), startBackground: runs.startBackground });
}

const clock = { type: 'string', pattern: '^([01]?\\d|2[0-3]):[0-5]\\d$' } as const;
const schedule = { type: 'object', required: ['kind'], additionalProperties: false, properties: {
  kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'hourly', 'cron', 'once'] }, at: { type: 'string', maxLength: 40 }, weekday: { type: 'integer', minimum: 1, maximum: 7 },
  from: clock, to: clock, cron: { type: 'string', maxLength: 100 },
} } as const;
const common = {
  title: { type: 'string', maxLength: 200 }, text: { type: 'string', maxLength: 20_000 }, schedule, timeZone: { type: 'string', maxLength: 64 },
  enabled: { type: 'boolean' }, noteVersion: { type: 'string', maxLength: 64 },
} as const;
const createBody = { type: 'object', required: ['text', 'schedule', 'timeZone'], additionalProperties: false, properties: common } as const;
const updateBody = { type: 'object', additionalProperties: false, properties: { expectedVersion: { type: 'integer', minimum: 1 }, ...common } } as const;
void ASSISTANT_JOB_LIMITS;

export function registerAssistantJobRoutes(app: FastifyInstance, db: Database, sessions: SessionResolver, boss: Pick<PgBoss, 'send'>, composition: Composition) {
  const jobs = assistantJobUseCases(db, boss, composition);
  const who = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const noStore = { 'cache-control': 'no-store' };
  type Params = { agentId: string };
  type JobParams = Params & { jobId: string };
  const collection = assistantJobsPath(':agentId');
  const one = assistantJobPath(':agentId', ':jobId');

  app.get<{ Params: Params }>(collection, async (request, reply) => reply.headers(noStore).send({ items: await jobs.list(await who(request), request.params.agentId) }));
  app.post<{ Params: Params; Body: CreateAssistantJob }>(collection, { schema: { body: createBody } }, async (request, reply) => {
    const created = await jobs.create(await who(request), request.params.agentId, request.body);
    return reply.code(201).headers(noStore).send(created);
  });
  app.get<{ Params: Params }>(assistantJobNotePath(':agentId'), async (request, reply) => reply.headers(noStore).send(await jobs.note(await who(request), request.params.agentId)));
  app.patch<{ Params: JobParams; Body: UpdateAssistantJob }>(one, { schema: { body: updateBody } }, async (request, reply) => {
    const body = { ...request.body, expectedVersion: request.body.expectedVersion ?? expectedVersion(request) } as UpdateAssistantJob;
    return reply.headers(noStore).send(await jobs.update(await who(request), request.params.agentId, request.params.jobId, body));
  });
  app.delete<{ Params: JobParams }>(one, async (request, reply) => reply.headers(noStore).send(await jobs.remove(await who(request), request.params.agentId, request.params.jobId)));
  app.post<{ Params: JobParams }>(assistantJobRestorePath(':agentId', ':jobId'), async (request, reply) =>
    reply.headers(noStore).send(await jobs.restore(await who(request), request.params.agentId, request.params.jobId)));
  app.post<{ Params: JobParams }>(assistantJobRunNowPath(':agentId', ':jobId'), async (request, reply) =>
    reply.code(202).headers(noStore).send(await jobs.runNow(await who(request), request.params.agentId, request.params.jobId)));
  app.get<{ Params: JobParams }>(assistantJobHistoryPath(':agentId', ':jobId'), async (request, reply) =>
    reply.headers(noStore).send({ items: await jobs.history(await who(request), request.params.agentId, request.params.jobId) }));
}
