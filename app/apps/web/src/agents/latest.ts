import { useEffect, useState } from 'react';
import { getTaskDiscussion } from '../composer/api';

/** An agent's message on a task: its text and when it was written. */
export interface AgentLine { body: string; at: string }

/**
 * The newest message the agent wrote on one task, from the task's own thread (the canonical discussion, read as one bounded
 * page). Null when the agent has written nothing there yet.
 */
export async function latestAgentLine(taskId: string, agentId: string, signal?: AbortSignal): Promise<AgentLine | null> {
  const discussion = await getTaskDiscussion(taskId, { limit: 50, signal });
  const all = discussion.root ? [discussion.root, ...discussion.messages] : discussion.messages;
  const mine = all
    .filter((message) => message.authorId === null && message.author.kind === 'agent' && message.author.id === agentId)
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1);
  return mine ? { body: mine.body, at: mine.createdAt } : null;
}

/** The agent's latest line on the task: `undefined` while it is read, `null` when there is none, and nothing when no task. */
export function useLatestAgentLine(taskId: string | null, agentId: string): AgentLine | null | undefined {
  const key = `${taskId ?? ''}:${agentId}`;
  const [state, setState] = useState<{ key: string; line: AgentLine | null } | null>(null);
  useEffect(() => {
    if (!taskId) return undefined;
    const controller = new AbortController();
    const read = () => {
      latestAgentLine(taskId, agentId, controller.signal).then((line) => {
        if (!controller.signal.aborted) setState({ key, line });
      }, () => { /* keep what is shown; the next focus tries again */ });
    };
    read();
    window.addEventListener('focus', read);
    return () => { controller.abort(); window.removeEventListener('focus', read); };
    // The key covers the task and the agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!taskId) return null;
  return state?.key === key ? state.line : undefined;
}
