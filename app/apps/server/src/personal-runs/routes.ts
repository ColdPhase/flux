import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  ASSISTANT_RUNS_PATH,
  assistantProposalAcceptPath,
  assistantProposalDismissPath,
  assistantProposalPath,
  assistantRunPath,
  assistantRunRetryPath,
  assistantRunStopPath,
  ASSISTANT_MODEL_PATH,
  conversationAssistantAnswersPath,
  conversationAssistantRunsPath,
  PERSONAL_ASSISTANT_AGENTS_PATH,
  PERSONAL_ASSISTANT_PATH,
  PERSONAL_ASSISTANT_PAUSE_PATH,
  PERSONAL_ASSISTANT_RESUME_PATH,
  PERSONAL_RUN_LIMITS,
  projectAssistantProposalsPath,
  type ChangeAssistantModelCommand,
  type DecideAssistantProposalCommand,
  type EnablePersonalRunsCommand,
  type InvokeAssistantRunCommand,
  type PageQuery,
  type RetryAssistantRunCommand,
  type SelectPersonalAgentCommand,
  type UpdatePersonalRunsCommand,
} from '@flux/contracts';
import type { Database, PersonalConnectionLookup, PersonalRuntimeAvailability } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, expectedVersion, useDomainErrors, versionEtag, type ReplayCheck } from '../http/commands.js';
import { registerAssistantJobRoutes } from '../assistant/jobs.js';
import { assistantProposalUseCases, personalRunUseCases, pgBossPersonalRunQueue } from './adapters.js';

interface Options {
  db: Database;
  sessions: SessionResolver;
  boss: Pick<PgBoss, 'send'>;
  /** Production leaves both out: no connection lookup (#124) and the provider switch off. */
  connections?: PersonalConnectionLookup;
  providerEnabled?: boolean;
  /** The most requests of one run when the worker runs the tool loop (F-027 AST-8, #484). */
  toolTurns?: number;
  /** The owner's own Claude Code in the agent runtime (F-022 AIM-3, #280). */
  runtime?: PersonalRuntimeAvailability;
}

const page = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } as const;
const cents = (range: { min: number; max: number }) => ({ type: 'integer', minimum: range.min, maximum: range.max }) as const;
const version = { type: 'integer', minimum: 1 } as const;
const enable = { type: 'object', required: ['consentVersion', 'agentId'], additionalProperties: false, properties: {
  consentVersion: { type: 'string', maxLength: 64 }, agentId: { type: 'string' }, connectionId: { type: 'string' }, engine: { type: 'string', enum: ['server', 'runtime'] },
  perRunCents: cents(PERSONAL_RUN_LIMITS.perRunCents), dailyCapCents: cents(PERSONAL_RUN_LIMITS.dailyCapCents), timeZone: { type: 'string', maxLength: 64 },
  model: { type: 'string', minLength: 1, maxLength: 200 },
} } as const;
const update = { type: 'object', additionalProperties: false, properties: {
  perRunCents: cents(PERSONAL_RUN_LIMITS.perRunCents), dailyCapCents: cents(PERSONAL_RUN_LIMITS.dailyCapCents),
  timeZone: { type: 'string', maxLength: 64 }, expectedVersion: version,
} } as const;
const chooseModel = { type: 'object', required: ['model'], additionalProperties: false, properties: { model: { type: 'string', minLength: 1, maxLength: 200 } } } as const;
const selectAgent = { type: 'object', required: ['agentId'], additionalProperties: false, properties: { agentId: { type: 'string' } } } as const;
const invoke = { type: 'object', required: ['clientRunId', 'kind', 'prompt'], additionalProperties: false, properties: {
  clientRunId: { type: 'string' }, kind: { type: 'string', enum: ['ask', 'summarize', 'map_thought'] },
  prompt: { type: 'string', minLength: 1, maxLength: PERSONAL_RUN_LIMITS.prompt },
  target: { type: 'object', required: ['type', 'sketchId', 'thoughtId'], additionalProperties: false,
    properties: { type: { type: 'string', enum: ['thought'] }, sketchId: { type: 'string' }, thoughtId: { type: 'string' } } },
  continuesRunId: { type: 'string' },
  // Accepted only to refuse them: they never select an owner, agent or connection.
  ownerId: { type: 'string' }, connectionId: { type: 'string' }, agentId: { type: 'string' },
} } as const;
const retry = { type: 'object', required: ['clientRunId'], additionalProperties: false, properties: { clientRunId: { type: 'string' } } } as const;
const decide = { type: 'object', additionalProperties: false, properties: { expectedVersion: version } } as const;

/** Stored responses of these commands are the caller's own state; the principal scopes the key. */
const ownState: ReplayCheck = async () => undefined;

/**
 * `/api/v1` personal assistant routes (#68, O-008). Each handler resolves the current session and
 * calls one core use case. Nothing here reads an owner, agent or connection from the request:
 * the session is the owner. The server only queues runs; the worker dispatches them.
 */
export async function personalRunRoutes(app: FastifyInstance, { db, sessions, boss, connections, providerEnabled, toolTurns, runtime }: Options) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const queue = pgBossPersonalRunQueue(boss);
  const composition = { queue, connections, providerEnabled, ...(toolTurns !== undefined ? { toolTurns } : {}), ...(runtime ? { runtime } : {}) };
  const runs = personalRunUseCases(db, composition);
  const proposals = assistantProposalUseCases(db, queue);
  // The owner's schedules and morning summary (F-027 A8) run on the same composition: the same connection, switch and runtime.
  registerAssistantJobRoutes(app, db, sessions, boss, composition);

  app.get(PERSONAL_ASSISTANT_PATH, async (request) => runs.status(await principal(request)));
  app.post<{ Body: EnablePersonalRunsCommand }>(PERSONAL_ASSISTANT_PATH, { schema: { body: enable } },
    async (request, reply) => command(request, reply, {
      operation: `POST ${PERSONAL_ASSISTANT_PATH}`, scope: 'account', status: 201,
      run: (actor, conn) => personalRunUseCases(conn, composition).enable(actor, request.body), replay: ownState,
    }));
  app.patch<{ Body: UpdatePersonalRunsCommand }>(PERSONAL_ASSISTANT_PATH, { schema: { body: update } },
    async (request, reply) => command(request, reply, {
      operation: `PATCH ${PERSONAL_ASSISTANT_PATH}`, scope: 'account',
      run: (actor, conn) => personalRunUseCases(conn, composition).update(actor, request.body ?? {}, expectedVersion(request)), replay: ownState,
    }));
  // The assistant's model (F-027 AST-11): the caller's own choice and list, never another person's.
  app.get<{ Querystring: { connectionId?: string } }>(ASSISTANT_MODEL_PATH, { schema: { querystring: { type: 'object', additionalProperties: false, properties: { connectionId: { type: 'string', maxLength: 64 } } } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return runs.model(await principal(request), request.query.connectionId);
    });
  app.put<{ Body: ChangeAssistantModelCommand }>(ASSISTANT_MODEL_PATH, { schema: { body: chooseModel } },
    async (request, reply) => command(request, reply, {
      operation: `PUT ${ASSISTANT_MODEL_PATH}`, scope: 'account',
      run: (actor, conn) => personalRunUseCases(conn, composition).chooseModel(actor, request.body), replay: ownState,
    }));
  app.put<{ Body: SelectPersonalAgentCommand }>(PERSONAL_ASSISTANT_AGENTS_PATH, { schema: { body: selectAgent } },
    async (request, reply) => command(request, reply, {
      operation: `PUT ${PERSONAL_ASSISTANT_AGENTS_PATH}`, scope: 'account',
      run: (actor, conn) => personalRunUseCases(conn, composition).selectAgent(actor, request.body), replay: ownState,
    }));
  app.post(PERSONAL_ASSISTANT_PAUSE_PATH, async (request, reply) => command(request, reply, {
    operation: `POST ${PERSONAL_ASSISTANT_PAUSE_PATH}`, scope: 'account',
    run: (actor, conn) => personalRunUseCases(conn, composition).pause(actor), replay: ownState,
  }));
  app.post(PERSONAL_ASSISTANT_RESUME_PATH, async (request, reply) => command(request, reply, {
    operation: `POST ${PERSONAL_ASSISTANT_RESUME_PATH}`, scope: 'account',
    run: (actor, conn) => personalRunUseCases(conn, composition).resume(actor), replay: ownState,
  }));
  app.delete(PERSONAL_ASSISTANT_PATH, async (request, reply) => {
    await runs.remove(await principal(request));
    return reply.code(204).send();
  });

  app.post<{ Params: { conversationId: string }; Body: InvokeAssistantRunCommand }>(conversationAssistantRunsPath(':conversationId'), { schema: { body: invoke } },
    async (request, reply) => {
      // 202 for a new run; 200 when the same clientRunId returns the existing one.
      let created = false;
      return command(request, reply, {
        operation: `POST ${conversationAssistantRunsPath(':conversationId')}`, scope: 'account', status: () => (created ? 202 : 200),
        run: async (actor, conn) => {
          const started = await personalRunUseCases(conn, composition).invoke(actor, request.params.conversationId, request.body);
          created = started.created;
          return started.run;
        },
        replay: ownState,
      });
    });
  app.get<{ Params: { conversationId: string }; Querystring: PageQuery }>(conversationAssistantAnswersPath(':conversationId'), { schema: { querystring: page } },
    async (request) => runs.listAnswers(await principal(request), request.params.conversationId, request.query));
  app.get<{ Querystring: PageQuery }>(ASSISTANT_RUNS_PATH, { schema: { querystring: page } },
    async (request) => runs.listOwn(await principal(request), request.query));
  app.get<{ Params: { runId: string } }>(assistantRunPath(':runId'), async (request) => runs.get(await principal(request), request.params.runId));
  app.post<{ Params: { runId: string } }>(assistantRunStopPath(':runId'), async (request, reply) => command(request, reply, {
    operation: `POST ${assistantRunStopPath(':runId')}`, scope: 'account',
    run: (actor, conn) => personalRunUseCases(conn, composition).stop(actor, request.params.runId), replay: ownState,
  }));
  app.post<{ Params: { runId: string }; Body: RetryAssistantRunCommand }>(assistantRunRetryPath(':runId'), { schema: { body: retry } },
    async (request, reply) => {
      let created = false;
      return command(request, reply, {
        operation: `POST ${assistantRunRetryPath(':runId')}`, scope: 'account', status: () => (created ? 202 : 200),
        run: async (actor, conn) => {
          const started = await personalRunUseCases(conn, composition).retry(actor, request.params.runId, request.body);
          created = started.created;
          return started.run;
        },
        replay: ownState,
      });
    });

  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>(projectAssistantProposalsPath(':projectId'), { schema: { querystring: page } },
    async (request) => proposals.list(await principal(request), request.params.projectId, request.query));
  app.get<{ Params: { proposalId: string } }>(assistantProposalPath(':proposalId'), async (request, reply) => {
    const proposal = await proposals.get(await principal(request), request.params.proposalId);
    return reply.header('etag', versionEtag(proposal)).send(proposal);
  });
  for (const [path, verb] of [[assistantProposalAcceptPath(':proposalId'), 'accept'], [assistantProposalDismissPath(':proposalId'), 'dismiss']] as const) {
    app.post<{ Params: { proposalId: string }; Body: DecideAssistantProposalCommand }>(path, { schema: { body: decide } },
      async (request, reply) => command(request, reply, {
        operation: `POST ${path}`, scope: 'account', etag: true,
        run: (actor, conn) => assistantProposalUseCases(conn, queue)[verb](actor, request.params.proposalId, request.body ?? {}, expectedVersion(request)),
        // A replay needs current read access to the proposal's project.
        replay: async (actor, body, conn) => { await assistantProposalUseCases(conn, queue).get(actor, String((body as { id?: unknown } | null)?.id ?? '')); },
      }));
  }
}
