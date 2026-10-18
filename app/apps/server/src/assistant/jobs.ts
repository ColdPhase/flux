import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  ASSISTANT_JOB_LIMITS, ASSISTANT_MORNING_SUMMARY_PATH, assistantJobHistoryPath, assistantJobNotePath, assistantJobPath, assistantJobPreviewPath, assistantJobRestorePath,
  assistantJobRunNowPath, assistantJobsPath, type AssistantMorningSummary, type CreateAssistantJob, type SetMorningSummaryByAssistant, type UpdateAssistantJob,
} from '@flux/contracts';
import {
  createAssistantJobs, createPersonalRunUseCases, setMorningSummaryByAssistant, todaysSummary, type AssistantReactionUnitOfWork, type Database, type PersonalConnectionLookup,
  type PersonalRuntimeAvailability,
} from '@flux/core';
import { assistantReactionRows, assistantJobRows, assistantSummaryRows, notificationPreferenceRows, personalRunRows, pushSubscriptionRepository } from '@flux/db';
import { expectedVersion } from '../http/commands.js';
import type { SessionResolver } from '../identity/index.js';
import { personalRunPorts, personalRunUnitOfWork, type PersonalRunQueueFactory } from '../personal-runs/adapters.js';
import { pgBossQueue } from '../push/adapters.js';
import { withTaskUseErrors } from '../work/task-use-errors.js';
import { registerAssistantReactionRoutes } from './reactions.js';
import { transactionEventSession } from '../work/transaction-events.js';

// "On a schedule" for its owner (F-027 AST-7, A8 #408). Every route resolves the owner from the session and the owner in the
// path must be that person: another member, a viewer or a guest gets the same 404 as for a schedule that does not exist. The
// server only prepares, changes and starts schedules; the worker's per-minute tick fires them.

interface Composition {
  queue: PersonalRunQueueFactory;
  connections?: PersonalConnectionLookup;
  providerEnabled?: boolean;
  toolTurns?: number;
  runtime?: PersonalRuntimeAvailability;
}

/** The server's unit of work for schedules: the personal-run ports a firing needs, plus the schedule rows. */
export function assistantJobUnitOfWork(db: Database, queue: PersonalRunQueueFactory, boss: Pick<PgBoss, 'send'>): AssistantReactionUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => withTaskUseErrors(() => work({
      ...personalRunPorts(tx, queue, session, session), jobs: assistantJobRows(tx), reactions: assistantReactionRows(tx),
      // The owner's own list settles an ended firing at once, like the worker's tick: a pause tells them once, with its push.
      inbox: { async tell(ownerUserId, projectId, title, body, url) {
        const id = await assistantJobRows(tx).notify(ownerUserId, projectId, title, body, url);
        for (const subscriptionId of await pushSubscriptionRepository(tx).deliverableIdsForUser(ownerUserId)) await pgBossQueue(boss)(tx).enqueuePushSend({ notificationId: id, subscriptionId, userId: ownerUserId });
        return id;
      } },
    })));
    await session.flushEvents();
    return result;
  }) };
}

export function assistantJobUseCases(db: Database, boss: Pick<PgBoss, 'send'>, { queue, connections, providerEnabled = false, toolTurns, runtime }: Composition) {
  const runs = createPersonalRunUseCases({ uow: personalRunUnitOfWork(db, queue), connections: connections ?? { resolve: async () => null }, providerEnabled,
    ...(toolTurns !== undefined ? { toolTurns } : {}), ...(runtime ? { runtime } : {}) });
  return createAssistantJobs({ uow: assistantJobUnitOfWork(db, queue, boss), startBackground: runs.startBackground });
}

const clock = { type: 'string', pattern: '^([01]?\\d|2[0-3]):[0-5]\\d$' } as const;
const schedule = { type: 'object', required: ['kind'], additionalProperties: false, properties: {
  kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'hourly', 'cron', 'once'] }, at: { type: 'string', maxLength: 40 }, weekday: { type: 'integer', minimum: 1, maximum: 7 },
  from: clock, to: clock, cron: { type: 'string', maxLength: 100 },
} } as const;
const common = {
  title: { type: 'string', maxLength: 200 }, text: { type: 'string', maxLength: 20_000 }, schedule, timeZone: { type: 'string', maxLength: 64 },
  postToConversation: { type: 'boolean' }, conversationId: { type: 'string', maxLength: 64 }, enabled: { type: 'boolean' }, noteVersion: { type: 'string', maxLength: 64 },
} as const;
const createBody = { type: 'object', required: ['projectId', 'text', 'schedule', 'timeZone'], additionalProperties: false, properties: { projectId: { type: 'string', maxLength: 64 }, ...common } } as const;
const updateBody = { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string', maxLength: 64 }, expectedVersion: { type: 'integer', minimum: 1 }, ...common } } as const;
const previewBody = { type: 'object', required: ['schedule', 'timeZone'], additionalProperties: false, properties: { schedule, timeZone: common.timeZone } } as const;
const summaryBody = { type: 'object', required: ['on'], additionalProperties: false, properties: { on: { type: 'boolean' }, noteVersion: { type: 'string', maxLength: 64 }, timeZone: { type: 'string', maxLength: 64 } } } as const;
void ASSISTANT_JOB_LIMITS;

export function registerAssistantJobRoutes(app: FastifyInstance, db: Database, sessions: SessionResolver, boss: Pick<PgBoss, 'send'>, composition: Composition) {
  registerAssistantReactionRoutes(app, assistantJobUnitOfWork(db, composition.queue, boss), sessions);
  const jobs = assistantJobUseCases(db, boss, composition);
  const who = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const noStore = { 'cache-control': 'no-store' };
  type Params = { workspaceId: string; ownerUserId: string };
  type JobParams = Params & { jobId: string };
  const collection = assistantJobsPath(':workspaceId', ':ownerUserId');
  const one = assistantJobPath(':workspaceId', ':ownerUserId', ':jobId');

  app.get<{ Params: Params }>(collection, async (request, reply) =>
    reply.headers(noStore).send({ items: await jobs.list(await who(request), request.params.workspaceId, request.params.ownerUserId) }));
  app.post<{ Params: Params; Body: CreateAssistantJob }>(collection, { schema: { body: createBody } }, async (request, reply) => {
    const created = await jobs.create(await who(request), request.params.workspaceId, request.params.ownerUserId, request.body);
    return reply.code(201).headers(noStore).send(created);
  });
  app.post<{ Params: Params; Body: { schedule: CreateAssistantJob['schedule']; timeZone: string } }>(assistantJobPreviewPath(':workspaceId', ':ownerUserId'), { schema: { body: previewBody } },
    async (request, reply) => reply.headers(noStore).send(await jobs.preview(await who(request), request.params.workspaceId, request.params.ownerUserId, request.body)));
  app.get<{ Params: Params }>(assistantJobNotePath(':workspaceId', ':ownerUserId'), async (request, reply) =>
    reply.headers(noStore).send(await jobs.note(await who(request), request.params.workspaceId, request.params.ownerUserId)));
  app.patch<{ Params: JobParams; Body: UpdateAssistantJob }>(one, { schema: { body: updateBody } }, async (request, reply) => {
    const body = { ...request.body, expectedVersion: request.body.expectedVersion ?? expectedVersion(request) } as UpdateAssistantJob;
    const updated = await jobs.update(await who(request), request.params.workspaceId, request.params.ownerUserId, request.params.jobId, body);
    return reply.headers(noStore).send(updated);
  });
  app.delete<{ Params: JobParams }>(one, async (request, reply) =>
    reply.headers(noStore).send(await jobs.remove(await who(request), request.params.workspaceId, request.params.ownerUserId, request.params.jobId)));
  app.post<{ Params: JobParams }>(assistantJobRestorePath(':workspaceId', ':ownerUserId', ':jobId'), async (request, reply) =>
    reply.headers(noStore).send(await jobs.restore(await who(request), request.params.workspaceId, request.params.ownerUserId, request.params.jobId)));
  app.post<{ Params: JobParams }>(assistantJobRunNowPath(':workspaceId', ':ownerUserId', ':jobId'), async (request, reply) =>
    reply.code(202).headers(noStore).send(await jobs.runNow(await who(request), request.params.workspaceId, request.params.ownerUserId, request.params.jobId)));
  app.get<{ Params: JobParams }>(assistantJobHistoryPath(':workspaceId', ':ownerUserId', ':jobId'), async (request, reply) =>
    reply.headers(noStore).send({ items: await jobs.history(await who(request), request.params.workspaceId, request.params.ownerUserId, request.params.jobId) }));

  // The morning summary written by the assistant: the person's own setting and today's line for the Home greeting.
  app.get(ASSISTANT_MORNING_SUMMARY_PATH, async (request, reply) => {
    const principal = await who(request);
    const body = await db.transaction(async (tx) => {
      const prefs = notificationPreferenceRows(tx);
      const stored = await prefs.find(principal.id);
      const today = await todaysSummary({ summaries: assistantSummaryRows(tx) }, principal.id, stored?.timeZone ?? 'UTC', new Date());
      return { byAssistant: !!stored?.summaryByAssistant && !!stored.summaryEnabled, line: today.line, day: today.day } satisfies AssistantMorningSummary;
    });
    return reply.headers(noStore).send(body);
  });
  app.put<{ Body: SetMorningSummaryByAssistant }>(ASSISTANT_MORNING_SUMMARY_PATH, { schema: { body: summaryBody } }, async (request, reply) => {
    const principal = await who(request);
    const result = await db.transaction((tx) => setMorningSummaryByAssistant(
      { runs: personalRunRows(tx), jobs: assistantJobRows(tx), prefs: { lock: (id) => notificationPreferenceRows(tx).lock(id), save: (id, values) => notificationPreferenceRows(tx).save(id, values) } },
      principal.id, { on: request.body.on, noteVersion: request.body.noteVersion, timeZone: request.body.timeZone }));
    return reply.headers(noStore).send(result);
  });
}
