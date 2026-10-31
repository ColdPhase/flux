import { useEffect, useState } from 'react';

import { Icon } from '../ui';
import { getTaskAgentThread } from '../composer/api';
import { RefLink } from '../place/origin';
import { useProjectAiBlocked } from '../ai/workspaceAi';

/**
 * The way from a task's Details into its agents' thread, which opens in the Agents tab. Reading the count never
 * creates the thread; a failed read leaves the link without a number rather than an error, and so does an empty thread
 * (Spokój rule 4: no zero counters, #763 C8).
 */
export function AgentThreadLink({ workId, projectId, revision }: { workId: string; projectId: string; revision: string | number }) {
  const [count, setCount] = useState<number | null>(null);
  // F-029 (#614): the agents' thread is AI work; a workspace whose AI is off has no such link and nothing is read.
  const aiOff = useProjectAiBlocked()(projectId);
  useEffect(() => {
    if (aiOff) return undefined;
    const controller = new AbortController();
    getTaskAgentThread(workId, { limit: 1, signal: controller.signal }).then((thread) => {
      if (!controller.signal.aborted) setCount(thread.messageCount);
    }, () => { if (!controller.signal.aborted) setCount(null); });
    return () => controller.abort();
  }, [workId, revision, aiOff]);
  if (aiOff) return null;
  return <section className="details__sec" data-ai-surface="agent-thread-link">
    <RefLink className="wd-link" data-agent-thread-link={workId} to={`/projects/${projectId}/agents?thread=${workId}`}>
      <span>Agents’ thread{!count ? '' : ` · ${count} ${count === 1 ? 'message' : 'messages'}`}</span><Icon name="chevron-right" size={14} />
    </RefLink>
  </section>;
}
