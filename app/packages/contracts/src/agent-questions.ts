/**
 * An agent's question to a person with ready-made answers (F-026 S14, #347; docs/product/mcp-cowork.md).
 * The question is an ordinary message of the agent in a project conversation; this record adds the options and
 * the answer. Answering posts the reply in the same conversation as the asked person.
 */
export const projectAgentQuestionsPath = (projectId: string) => `/api/v1/projects/${projectId}/agent-questions`;
export const agentQuestionAnswerPath = (questionId: string) => `/api/v1/agent-questions/${questionId}/answer`;

export const AGENT_QUESTION_LIMITS = { question: 2000, options: { min: 2, max: 4 }, option: 80, answer: 2000 } as const;

export interface AgentQuestionAnswer {
  /** The chosen option, or null for a free reply. */
  optionIndex: number | null;
  /** The reply text as posted. */
  text: string;
  by: { id: string; name: string };
  /** The reply message in the question's conversation. */
  messageId: string;
  at: string;
}

export interface AgentQuestion {
  id: string;
  projectId: string;
  conversationId: string;
  /** The agent's message that carries the question. */
  messageId: string;
  /** The task whose thread it is in, when it is one. */
  taskId: string | null;
  agent: { id: string; name: string };
  askedUserId: string;
  question: string;
  options: string[];
  createdAt: string;
  /** Null until answered. */
  answer: AgentQuestionAnswer | null;
}

export interface AgentQuestions {
  projectId: string;
  questions: AgentQuestion[];
}

/** Exactly one of the two. */
export type AnswerAgentQuestionCommand = { optionIndex: number; text?: never } | { text: string; optionIndex?: never };
