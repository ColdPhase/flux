import { AGENT_QUESTION_LIMITS, type AgentQuestion, type AgentQuestions, type AnswerAgentQuestionCommand } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import { derivedUuid } from '../task-discussions/identity.js';
import type { Principal } from '../types.js';

/**
 * An agent's question to a person with ready-made answers (F-026 S14, #347; docs/product/mcp-cowork.md "Stop and
 * questions"). The question is the agent's ordinary message in a project conversation, so the thread reads the same
 * without the card. Answering posts the chosen option (or the person's own words) as that person's reply in the same
 * conversation, once. An answer grants the agent nothing.
 */
export interface QuestionRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  taskId: string | null;
  agent: { id: string; name: string };
  askedUserId: string;
  question: string;
  options: string[];
  createdAt: Date;
  answer: { optionIndex: number | null; text: string; by: { id: string; name: string }; messageId: string; at: Date } | null;
}

export interface AgentQuestionPorts {
  /** Throws the access policy's 404/403 unless the principal may perform `action` on the project now. */
  requireProject(principal: Principal, projectId: string, action: 'project.read' | 'project.write'): Promise<{ workspaceId: string }>;
  /** Whether this person can read the project now (the asked person must). */
  canRead(userId: string, projectId: string): Promise<boolean>;
  /** The project conversation, or null; a direct message or another project's thread is never one. */
  conversation(conversationId: string): Promise<{ id: string; projectId: string; workspaceId: string } | null>;
  /** The canonical message command as `principal` (the agent for a question, the person for an answer). */
  postMessage(principal: Principal, conversationId: string, message: { body: string; clientMessageId: string }): Promise<{ id: string }>;
  rows: {
    taskOfConversation(conversationId: string): Promise<string | null>;
    insert(row: { workspaceId: string; projectId: string; conversationId: string; messageId: string; taskId: string | null; agentId: string;
      askedUserId: string; question: string; options: string[] }): Promise<string>;
    get(id: string, lock?: boolean): Promise<QuestionRecord | null>;
    list(projectId: string, limit: number): Promise<QuestionRecord[]>;
    answer(id: string, answer: { optionIndex: number | null; text: string; by: string; messageId: string }): Promise<boolean>;
  };
  events: { record(principal: Principal, workspaceId: string, kind: string, projectId: string, data: Record<string, unknown>): Promise<void> };
}

/** One transaction per use case. */
export interface AgentQuestionUnitOfWork {
  run<T>(work: (ports: AgentQuestionPorts) => Promise<T>): Promise<T>;
}

const RECENT_QUESTIONS = 100;

export function agentQuestionView(row: QuestionRecord): AgentQuestion {
  return { id: row.id, projectId: row.projectId, conversationId: row.conversationId, messageId: row.messageId, taskId: row.taskId,
    agent: row.agent, askedUserId: row.askedUserId, question: row.question, options: row.options, createdAt: row.createdAt.toISOString(),
    answer: row.answer ? { optionIndex: row.answer.optionIndex, text: row.answer.text, by: row.answer.by, messageId: row.answer.messageId,
      at: row.answer.at.toISOString() } : null };
}

/** The message text: the question, then the options as a list, so a reader without the card still sees them. */
export function questionMessageBody(question: string, options: readonly string[]): string {
  return `${question}\n\n${options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`;
}

function uuid(value: unknown, what: string, code: string): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new NotFoundError(what, code);
  return value.toLowerCase();
}

/** 1 to `max` code points once trimmed. */
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new InvalidInputError(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > max) throw new InvalidInputError(`${name} must be 1 to ${max} characters`);
  return trimmed;
}

export interface AskQuestionInput {
  conversationId: string;
  question: string;
  options: string[];
  /** A person who reads the project; the caller supplies the agent's owner when the agent names nobody. */
  askUserId: string;
  /** The agent's own command ID, so a retry computes the same message. */
  clientMessageId: string;
}

export function agentQuestionUseCases(uow: AgentQuestionUnitOfWork) {
  return {
    list: (principal: Principal, requestedProject: string): Promise<AgentQuestions> => uow.run(async (ports) => {
      const projectId = uuid(requestedProject, 'Project', 'PROJECT_NOT_FOUND');
      await ports.requireProject(principal, projectId, 'project.read');
      return { projectId, questions: (await ports.rows.list(projectId, RECENT_QUESTIONS)).map(agentQuestionView) };
    }),

    /** The agent posts the question as its message and stores the options. */
    ask: (agent: Principal, input: AskQuestionInput): Promise<AgentQuestion> => uow.run(async (ports) => {
      if (agent.kind !== 'agent') throw new ForbiddenError('Only an agent asks a question card', 'QUESTION_NEEDS_AGENT');
      const question = text(input.question, 'question', AGENT_QUESTION_LIMITS.question);
      const options = (Array.isArray(input.options) ? input.options : []).map((option) => text(option, 'an option', AGENT_QUESTION_LIMITS.option));
      if (options.length < AGENT_QUESTION_LIMITS.options.min || options.length > AGENT_QUESTION_LIMITS.options.max
        || new Set(options.map((option) => option.toLowerCase())).size !== options.length)
        throw new InvalidInputError(`Offer ${AGENT_QUESTION_LIMITS.options.min} to ${AGENT_QUESTION_LIMITS.options.max} different answers`, 'QUESTION_OPTIONS');
      const conversation = await ports.conversation(uuid(input.conversationId, 'Conversation', 'CONVERSATION_NOT_FOUND'));
      if (!conversation) throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
      await ports.requireProject(agent, conversation.projectId, 'project.write');
      if (!await ports.canRead(input.askUserId, conversation.projectId))
        throw new InvalidInputError('That person cannot read this project, so they cannot be asked here', 'QUESTION_PERSON_UNAVAILABLE');
      const sent = await ports.postMessage(agent, conversation.id, { body: questionMessageBody(question, options), clientMessageId: input.clientMessageId });
      const existing = await ports.rows.get(await ports.rows.insert({ workspaceId: conversation.workspaceId, projectId: conversation.projectId,
        conversationId: conversation.id, messageId: sent.id, taskId: await ports.rows.taskOfConversation(conversation.id), agentId: agent.id,
        askedUserId: input.askUserId, question, options }));
      if (!existing) throw new InvalidInputError('The question was not stored');
      await ports.events.record(agent, conversation.workspaceId, 'project.question_asked.v1', conversation.projectId, { questionId: existing.id, messageId: sent.id });
      return agentQuestionView(existing);
    }),

    /** The asked person answers once, with an option or their own words; the same answer again is the stored one. */
    answer: (principal: Principal, requestedQuestion: string, command: AnswerAgentQuestionCommand): Promise<AgentQuestion> => uow.run(async (ports) => {
      if (principal.kind !== 'human') throw new ForbiddenError('Only the person asked can answer', 'QUESTION_NEEDS_PERSON');
      const questionId = uuid(requestedQuestion, 'Question', 'QUESTION_NOT_FOUND');
      const found = await ports.rows.get(questionId);
      if (!found) throw new NotFoundError('Question', 'QUESTION_NOT_FOUND');
      // A reader who cannot read the project does not learn that the question exists.
      await ports.requireProject(principal, found.projectId, 'project.read');
      const question = (await ports.rows.get(questionId, true))!;
      if (question.askedUserId !== principal.id) throw new ForbiddenError('This question was asked of someone else', 'QUESTION_NOT_FOR_YOU');
      const hasOption = command?.optionIndex !== undefined, hasText = command?.text !== undefined;
      if (hasOption === hasText) throw new InvalidInputError('Answer with one of the options or with your own words', 'QUESTION_ANSWER_SHAPE');
      let optionIndex: number | null = null;
      let reply: string;
      if (hasOption) {
        const index = command.optionIndex;
        if (!Number.isInteger(index) || index! < 0 || index! >= question.options.length) throw new InvalidInputError('That option does not exist', 'QUESTION_OPTION');
        optionIndex = index!;
        reply = question.options[optionIndex]!;
      } else {
        reply = text(command.text, 'The answer', AGENT_QUESTION_LIMITS.answer);
      }
      if (question.answer) {
        if (question.answer.optionIndex === optionIndex && question.answer.text === reply) return agentQuestionView(question);
        throw new ConflictError('This question was answered already', 'QUESTION_ANSWERED');
      }
      const { workspaceId } = await ports.requireProject(principal, question.projectId, 'project.write');
      const posted = await ports.postMessage(principal, question.conversationId,
        { body: reply, clientMessageId: derivedUuid('flux.agent-question-answer.v1', question.id) });
      if (!await ports.rows.answer(question.id, { optionIndex, text: reply, by: principal.id, messageId: posted.id }))
        throw new ConflictError('This question was answered already', 'QUESTION_ANSWERED');
      await ports.events.record(principal, workspaceId, 'project.question_answered.v1', question.projectId, { questionId: question.id, messageId: posted.id });
      return agentQuestionView((await ports.rows.get(question.id))!);
    }),
  };
}
