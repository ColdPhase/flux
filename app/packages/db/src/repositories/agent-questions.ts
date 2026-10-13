import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for an agent's questions with ready-made answers (#347 S14, migration 0065). The question is the
 * agent's ordinary project message; core decides who may ask and answer. An answer is stored once: the conditional
 * update only writes while the question is still open.
 */
const q = schema.agentQuestions;

export interface AgentQuestionRow {
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

export function agentQuestionRows(tx: DbExecutor) {
  const a = schema.authUsers;
  const select = () => tx.select({ q, agentName: schema.agents.name, answeredByName: a.name }).from(q)
    .innerJoin(schema.agents, eq(schema.agents.id, q.agentId)).leftJoin(a, eq(a.id, q.answeredBy));
  const view = (row: { q: typeof q.$inferSelect; agentName: string; answeredByName: string | null }): AgentQuestionRow => ({
    id: row.q.id, workspaceId: row.q.workspaceId, projectId: row.q.projectId, conversationId: row.q.conversationId, messageId: row.q.messageId,
    taskId: row.q.taskId, agent: { id: row.q.agentId, name: row.agentName }, askedUserId: row.q.askedUserId, question: row.q.question,
    options: row.q.options, createdAt: row.q.createdAt,
    answer: row.q.answeredAt && row.q.answerText !== null && row.q.answerMessageId
      ? { optionIndex: row.q.answeredOption, text: row.q.answerText, by: { id: row.q.answeredBy ?? '', name: row.answeredByName ?? 'Someone' },
        messageId: row.q.answerMessageId, at: row.q.answeredAt } : null,
  });
  return {
    /** The task a conversation is the canonical thread of, if any (so the card can name it). */
    async taskOfConversation(conversationId: string): Promise<string | null> {
      const [row] = await tx.select({ id: schema.projectTaskDiscussions.workId }).from(schema.projectTaskDiscussions)
        .where(eq(schema.projectTaskDiscussions.conversationId, conversationId));
      return row?.id ?? null;
    },
    async insert(row: Omit<AgentQuestionRow, 'id' | 'createdAt' | 'answer' | 'agent'> & { agentId: string }) {
      const id = randomUUID();
      await tx.insert(q).values({ id, workspaceId: row.workspaceId, projectId: row.projectId, conversationId: row.conversationId,
        messageId: row.messageId, taskId: row.taskId, agentId: row.agentId, askedUserId: row.askedUserId, question: row.question, options: row.options });
      return id;
    },
    async get(id: string, lock = false): Promise<AgentQuestionRow | null> {
      const query = select().where(eq(q.id, id));
      const [row] = await (lock ? query.for('update', { of: q }) : query);
      return row ? view(row) : null;
    },
    async byMessage(messageId: string): Promise<AgentQuestionRow | null> {
      const [row] = await select().where(eq(q.messageId, messageId));
      return row ? view(row) : null;
    },
    /** Newest first. */
    async list(projectId: string, limit = 100): Promise<AgentQuestionRow[]> {
      return (await select().where(eq(q.projectId, projectId)).orderBy(desc(q.createdAt), desc(q.id)).limit(limit)).map(view);
    },
    /** False when it was answered already (the conditional write did not apply). */
    async answer(id: string, answer: { optionIndex: number | null; text: string; by: string; messageId: string }): Promise<boolean> {
      const rows = await tx.update(q).set({ answeredOption: answer.optionIndex, answerText: answer.text, answeredBy: answer.by,
        answerMessageId: answer.messageId, answeredAt: new Date() }).where(and(eq(q.id, id), isNull(q.answeredAt))).returning({ id: q.id });
      return rows.length === 1;
    },
  };
}
