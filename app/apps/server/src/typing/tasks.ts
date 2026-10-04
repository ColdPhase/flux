import { NotFoundError, type Database, type TypingTaskDiscussion } from '@flux/core';
import { taskDiscussionUseCases } from '../work/task-discussions.js';

/**
 * The production task alias for typing (#155): a task's accepted canonical discussion root, read with
 * the caller's current `project.read`. It never creates a conversation, message, binding or event; a
 * task without a genuine contribution yet, or one the caller cannot see, has no typing context.
 */
export function typingTaskDiscussion(db: Database): TypingTaskDiscussion {
  const discussions = taskDiscussionUseCases(db);
  return {
    async conversation(principal, taskId) {
      try {
        return (await discussions.getDiscussionRoot(principal, taskId))?.conversationId ?? null;
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  };
}
