import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AGENT_OPERATION_CLASSES, AGENT_QUESTION_LIMITS, agentQuestionAnswerPath, projectAgentQuestionsPath, type AgentJsonValue, type AnswerAgentQuestionCommand } from '@flux/contracts';
import { agentQuestionRows, schema } from '@flux/db';
import { agentQuestionUseCases, conversationUseCases, derivedUuid, enforce, evaluateProject, type AgentQuestionPorts, type AgentQuestionUnitOfWork, type Database, type Principal, type Transaction } from '@flux/core';
import { eq } from 'drizzle-orm';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, requires, useDomainErrors } from '../http/commands.js';
import { conversationStore } from '../conversation/store.js';
import { transactionEventSession } from '../work/transaction-events.js';
import { actionAnnotations as annotations, actionId as id, actionInput, nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

type Post = AgentQuestionPorts['postMessage'];
type Record_ = AgentQuestionPorts['events']['record'];

function questionPorts(tx: Transaction, post: Post, record: Record_): AgentQuestionPorts {
  return {
    async requireProject(principal, projectId, action) {
      const checked = enforce(await evaluateProject(principal, action, projectId, tx, { lock: action === 'project.write' }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    async canRead(userId, projectId) { return (await evaluateProject({ kind: 'human', id: userId }, 'project.read', projectId, tx)).allowed; },
    async conversation(conversationId) {
      const [row] = await tx.select({ id: schema.projectConversations.id, projectId: schema.projectConversations.projectId,
        workspaceId: schema.projectConversations.workspaceId }).from(schema.projectConversations).where(eq(schema.projectConversations.id, conversationId));
      return row ?? null;
    },
    postMessage: post,
    rows: agentQuestionRows(tx),
    events: { record },
  };
}

/** The question use cases over one transaction, posting through the canonical conversation commands. */
export function agentQuestionUnitOfWork(db: Database): AgentQuestionUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const conversations = conversationUseCases(conversationStore(tx, { events: session, agentAuthors: true }));
    const result = await session.run(() => work(questionPorts(tx,
      async (principal, conversationId, message) => { const sent = await conversations.sendMessage(principal, conversationId, message); return { id: sent.id }; },
      async (principal, workspaceId, kind, projectId, data) => { await session.record(principal, workspaceId, kind, projectId, data); })));
    await session.flushEvents();
    return result;
  }) };
}

/**
 * `GET /api/v1/projects/:projectId/agent-questions` (project readers) and `POST /api/v1/agent-questions/:questionId/answer`
 * (the person asked), #347 S14. The answer is that person's reply in the question's conversation, recorded once.
 */
export async function agentQuestionRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: SessionResolver }) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const questions = agentQuestionUseCases(agentQuestionUnitOfWork(db));
  app.get<{ Params: { projectId: string } }>(projectAgentQuestionsPath(':projectId'), async (request, reply) =>
    reply.header('cache-control', 'no-store').send(await questions.list(await principal(request), request.params.projectId)));
  app.post<{ Params: { questionId: string }; Body: AnswerAgentQuestionCommand }>(agentQuestionAnswerPath(':questionId'), {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
      properties: { optionIndex: { type: 'integer', minimum: 0, maximum: AGENT_QUESTION_LIMITS.options.max - 1 },
        text: { type: 'string', maxLength: AGENT_QUESTION_LIMITS.answer * 2 } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${agentQuestionAnswerPath(':questionId')}`, scope: null, status: 200,
    run: (actor, conn) => agentQuestionUseCases(agentQuestionUnitOfWork(conn)).answer(actor, request.params.questionId, request.body),
    replay: (actor, body, conn) => requires('project', 'project.read', (stored) => String((stored as { projectId?: unknown } | null)?.projectId ?? ''))(actor, body, conn),
  }));
}

const execution = actionInput(['execute', 'plan']);

/**
 * `flux_ask_question` (#347 S14): a question with two to four ready answers, posted as the agent's message in a project
 * conversation under the existing `conversation.reply` grant. Only the asked person's answer ends it.
 */
export function registerAgentQuestionActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);
  tools.forScope('flux.action.execute', { operation: 'conversation.reply', classes: AGENT_OPERATION_CLASSES['conversation.reply'] }).registerTool('flux_ask_question', {
    title: 'Ask a person a question with ready answers under a standing grant',
    description: 'Ask one person in an existing project conversation (including a task\'s discussion thread) a question and offer two to four '
      + 'ready answers; they answer with one tap or in their own words, and their answer is the next message of the thread. Needs a live '
      + 'conversation.reply grant and the runtime from flux_bootstrap. The question is your message; the person gets a question notification. '
      + 'An answer never grants you anything. Ask only what you truly cannot decide, and carry on with other authorized work meanwhile.',
    inputSchema: z.strictObject({ ...execution,
      conversationId: id.describe('A conversation of this project, from flux_list_conversations or a task.'),
      question: z.string().min(1).max(AGENT_QUESTION_LIMITS.question).describe('One clear question.'),
      options: z.array(z.string().min(1).max(AGENT_QUESTION_LIMITS.option)).min(AGENT_QUESTION_LIMITS.options.min).max(AGENT_QUESTION_LIMITS.options.max)
        .describe('Two to four short, different ready answers.'),
      askUserId: z.string().min(1).max(200).optional().describe('The person to ask; by default the owner of this connection. They must read the project.') }), annotations,
  }, ({ conversationId, question, options, askUserId, ...input }) => run(() => execute(input, 'conversation.reply', conversationId,
    { question, options, ...(askUserId ? { askUserId } : {}) } as unknown as AgentJsonValue, async ({ transaction, events, conversations, agent, runtime }) => {
      const ports = questionPorts(transaction,
        async (principal: Principal, target, message) => { const sent = await conversations.sendMessage(principal, target, message); return { id: sent.id }; },
        async (principal, workspaceId, kind, projectId, data) => { await events.record(principal, workspaceId, kind, projectId, data); });
      const asked = await agentQuestionUseCases({ run: (work) => work(ports) }).ask(agent, { conversationId, question, options,
        askUserId: askUserId ?? runtime.ownerUserId, clientMessageId: derivedMessageId(runtime.connectionId, input.clientCommandId) });
      return { value: { questionId: asked.id, conversationId: asked.conversationId, messageId: asked.messageId, taskId: asked.taskId },
        postconditions: [{ kind: 'message', id: asked.messageId }] };
    })));
}

const derivedMessageId = (connectionId: string, commandId: string) =>
  derivedUuid('flux.agent-conversation-message.v1', connectionId.toLowerCase(), commandId.toLowerCase());
