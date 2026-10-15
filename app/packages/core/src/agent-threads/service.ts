import type { ConversationWindowQuery, SendMessageCommand, TaskAgentThread, ConversationMessage } from '@flux/contracts';
import type { Principal } from '../principal.js';
import { InvalidInputError } from '../access/errors.js';
import { normalizeConversationWindow, normalizeMessage, uuid } from '../conversation/commands.js';

export interface TaskAgentThreadCommand extends SendMessageCommand { projectId?: string }
export type AgentThreadWindow = ReturnType<typeof normalizeConversationWindow>;
export type AgentThreadPost = ReturnType<typeof normalizeMessage> & { projectId: string | null };

/** Adapters authorize the real task before any metadata and hold its shared use fence on a post. */
export interface TaskAgentThreadPort {
  getAgentThread(principal: Principal, taskId: string, window: AgentThreadWindow): Promise<TaskAgentThread>;
  postAgentThread(principal: Principal, taskId: string, input: AgentThreadPost): Promise<ConversationMessage>;
}

export function taskAgentThreadUseCases(port: TaskAgentThreadPort) {
  return {
    get(principal: Principal, taskId: string, query: ConversationWindowQuery = {}) {
      const window = normalizeConversationWindow(query);
      if (window.limit > 50) throw new InvalidInputError('An agent-thread page has at most 50 messages');
      return port.getAgentThread(principal, uuid(taskId, 'taskId'), window);
    },
    post(principal: Principal, taskId: string, command: TaskAgentThreadCommand) {
      return port.postAgentThread(principal, uuid(taskId, 'taskId'), {
        ...normalizeMessage(command), projectId: command.projectId === undefined ? null : uuid(command.projectId, 'projectId'),
      });
    },
  };
}
