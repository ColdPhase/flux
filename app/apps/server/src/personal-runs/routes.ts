import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  AGENT_COLOURS,
  AGENT_LIMITS,
  FIRST_AGENT_NAME,
  MY_AGENTS_PATH,
  myAgentMemoryItemPath,
  myAgentMemoryPath,
  myAgentPath,
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
  PERSONAL_ASSISTANT_PATH,
  PERSONAL_RUN_LIMITS,
  projectAssistantProposalsPath,
  type AddAgentMemoryCommand,
  type AssistantModelPick,
  type CreateMyAgentCommand,
  type DecideAssistantProposalCommand,
  type EditAgentMemoryCommand,
  type InvokeAssistantRunCommand,
  type PageQuery,
  type RetryAssistantRunCommand,
  type UpdateMyAgentCommand,
} from '@flux/contracts';
import { createAgent, InvalidInputError, type PersonalConnectionLookup, type PersonalRuntimeAvailability } from '@flux/core';
import { accessPorts, type Database } from '@flux/db';
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
  /** The owner's own Claude Code and Codex in the agent runtime (F-022 AIM-3, #280). */
  runtime?: PersonalRuntimeAvailability;
}

const page = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } as const;
const version = { type: 'integer', minimum: 1 } as const;
/** One of the caller's connections (#854): a plan, or an API key's id. */
const connection = { type: 'string', minLength: 1, maxLength: 64 } as const;
const model = { type: 'string', minLength: 1, maxLength: 200 } as const;
const chooseModel = { type: 'object', required: ['connection', 'model'], additionalProperties: false, properties: { connection, model } } as const;
const colour = { type: 'string', enum: [...AGENT_COLOURS] } as const;
const instructions = { type: 'string', maxLength: AGENT_LIMITS.instructions } as const;
const createAgentBody = { type: 'object', additionalProperties: false, properties: {
  agentId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 80 }, workspaceId: { type: 'string' }, instructions, colour, connection, model,
} } as const;
const updateAgentBody = { type: 'object', additionalProperties: false, properties: {
  name: { type: 'string', minLength: 1, maxLength: 80 }, instructions, colour, connection, model,
} } as const;
const memoryBody = { type: 'object', required: ['body'], additionalProperties: false, properties: { body: { type: 'string', minLength: 1, maxLength: AGENT_LIMITS.memoryItem } } } as const;
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
export async function personalRunRoutes(app: FastifyInstance, { db, sessions, boss, connections, providerEnabled, runtime }: Options) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const queue = pgBossPersonalRunQueue(boss);
  const composition = { queue, connections, providerEnabled, ...(runtime ? { runtime } : {}) };
  const runs = personalRunUseCases(db, composition);
  const proposals = assistantProposalUseCases(db, queue);
  // The owner's schedules and morning summary (F-027 A8) run on the same composition: the same connection, switch and runtime.
  registerAssistantJobRoutes(app, db, sessions, boss, composition);

  app.get(PERSONAL_ASSISTANT_PATH, async (request) => runs.status(await principal(request)));
  // What a person may choose for an agent's model (F-027 AST-11, #854): every connection's list, never another person's.
  app.get(ASSISTANT_MODEL_PATH, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return runs.model(await principal(request));
  });
  // The ask bar's model chip changes the first agent's (Assistant's) model until `/ai` replaces the bar (#842); every agent's own is `PATCH /api/v1/my-agents/:id`.
  app.put<{ Body: AssistantModelPick }>(ASSISTANT_MODEL_PATH, { schema: { body: chooseModel } }, async (request, reply) => command(request, reply, {
    operation: `PUT ${ASSISTANT_MODEL_PATH}`, scope: 'account',
    run: (actor, conn) => personalRunUseCases(conn, composition).chooseModel(actor, request.body), replay: ownState,
  }));

  // A person's agents (F-036 AG-1, #857). Only their owner lists, reads or changes them; anyone else gets 404.
  app.get(MY_AGENTS_PATH, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { items: await runs.listAgents(await principal(request)) };
  });
  app.post<{ Body: CreateMyAgentCommand }>(MY_AGENTS_PATH, { schema: { body: createAgentBody } }, async (request, reply) => command(request, reply, {
    operation: `POST ${MY_AGENTS_PATH}`, scope: 'account', status: 201,
    run: (actor, conn) => conn.transaction(async (tx) => {
      const scoped = tx as unknown as Database;
      const uses = personalRunUseCases(scoped, composition);
      let agentId = request.body.agentId;
      if (!agentId) {
        // A new agent: its identity and its setup are made together or not at all. The first is Assistant (F-036 AG-1).
        if (!request.body.workspaceId) throw new InvalidInputError('workspaceId is required for a new agent');
        const first = (await uses.listAgents(actor)).length === 0;
        const name = request.body.name ?? (first ? FIRST_AGENT_NAME : null);
        if (!name) throw new InvalidInputError('Name the new agent');
        agentId = (await createAgent(actor, request.body.workspaceId, { name, owner: 'self' }, scoped, accessPorts)).id;
      }
      return uses.enable(actor, { ...request.body, agentId });
    }),
    replay: ownState,
  }));
  app.get<{ Params: { agentId: string } }>(myAgentPath(':agentId'), async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return runs.getAgent(await principal(request), request.params.agentId);
  });
  app.patch<{ Params: { agentId: string }; Body: UpdateMyAgentCommand }>(myAgentPath(':agentId'), { schema: { body: updateAgentBody } }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${myAgentPath(':agentId')}`, scope: 'account',
    run: (actor, conn) => personalRunUseCases(conn, composition).updateAgent(actor, request.params.agentId, request.body), replay: ownState,
  }));
  app.delete<{ Params: { agentId: string } }>(myAgentPath(':agentId'), async (request, reply) => command(request, reply, {
    operation: `DELETE ${myAgentPath(':agentId')}`, scope: 'account', status: 204,
    run: async (actor, conn) => { await personalRunUseCases(conn, composition).remove(actor, request.params.agentId); return null; }, replay: ownState,
  }));
  app.get<{ Params: { agentId: string } }>(myAgentMemoryPath(':agentId'), async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return runs.memory.list(await principal(request), request.params.agentId);
  });
  app.post<{ Params: { agentId: string }; Body: AddAgentMemoryCommand }>(myAgentMemoryPath(':agentId'), { schema: { body: memoryBody } }, async (request, reply) => command(request, reply, {
    operation: `POST ${myAgentMemoryPath(':agentId')}`, scope: 'account', status: 201,
    run: (actor, conn) => personalRunUseCases(conn, composition).memory.add(actor, request.params.agentId, request.body), replay: ownState,
  }));
  app.patch<{ Params: { agentId: string; itemId: string }; Body: EditAgentMemoryCommand }>(myAgentMemoryItemPath(':agentId', ':itemId'), { schema: { body: memoryBody } }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${myAgentMemoryItemPath(':agentId', ':itemId')}`, scope: 'account',
    run: (actor, conn) => personalRunUseCases(conn, composition).memory.edit(actor, request.params.agentId, request.params.itemId, request.body), replay: ownState,
  }));
  app.delete<{ Params: { agentId: string; itemId: string } }>(myAgentMemoryItemPath(':agentId', ':itemId'), async (request, reply) => command(request, reply, {
    operation: `DELETE ${myAgentMemoryItemPath(':agentId', ':itemId')}`, scope: 'account', status: 204,
    run: async (actor, conn) => { await personalRunUseCases(conn, composition).memory.remove(actor, request.params.agentId, request.params.itemId); return null; }, replay: ownState,
  }));

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
