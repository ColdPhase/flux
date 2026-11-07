import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ui';
import { getTaskAgentThread } from '../composer/api';
import { useProjectAiBlocked, AiSurface } from '../ai/spaceAi';
import { useProjectShell } from '../project/data';
import { AgentsThread, type ThreadTask } from './AgentsThread';
import { ReviewRule } from './ReviewRule';

/**
 * A task's agents' thread in its Details (F-038: a space has no Agents view). One row, "Agents’ thread · N messages", opens the
 * thread, its request cards and its composer in place; "Review rule" below it says who checks an agent's work in this project (a
 * space admin changes it). Reading the count never creates the thread; a failed read leaves the row without a number, and so does an
 * empty thread (Spokój rule 4: no zero counters, #763 C8). A space whose AI is off has no such row and nothing is read (F-029, #614).
 */
export function AgentsThreadSection({ task, projectId, meId, revision }: { task: ThreadTask; projectId: string; meId: string; revision: string | number }) {
  const aiOff = useProjectAiBlocked()(projectId);
  const shell = useProjectShell();
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [rule, setRule] = useState(false);
  useEffect(() => {
    if (aiOff) return undefined;
    const controller = new AbortController();
    getTaskAgentThread(task.id, { limit: 1, signal: controller.signal }).then((thread) => {
      if (!controller.signal.aborted) setCount(thread.messageCount);
    }, () => { if (!controller.signal.aborted) setCount(null); });
    return () => controller.abort();
  }, [task.id, revision, aiOff]);
  const names = useMemo(() => new Map((shell?.people ?? []).map((person) => [person.id, person.name])), [shell]);
  if (aiOff) return null;
  const manager = shell?.project.access === 'manager';
  return (
    <section className="details__sec" data-ai-surface="agent-thread-link" aria-label="Agents">
      <button type="button" className="wd-link" data-agent-thread-link={task.id} aria-expanded={open} aria-controls={`agents-thread-${task.id}`} onClick={() => setOpen(!open)}>
        <span>Agents’ thread{!count ? '' : ` · ${count} ${count === 1 ? 'message' : 'messages'}`}</span><Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      {open ? (
        <div id={`agents-thread-${task.id}`} className="agents-embed">
          <div className="agents-thread-scroll agents-embed__scroll">
            <AgentsThread key={`${meId}:${projectId}:${task.id}`} task={task} projectId={projectId} meId={meId} names={names} />
          </div>
          <button type="button" className="wd-link agents-embed__rule" aria-expanded={rule} aria-controls="agents-policy" onClick={() => setRule(!rule)}>
            <span><b>Review rule</b> · Who checks an agent's work in this project. {rule ? 'Hide' : manager ? 'Edit' : 'Read'}</span><Icon name={rule ? 'chevron-down' : 'chevron-right'} size={14} />
          </button>
          {rule ? (
            <div id="agents-policy">
              <AiSurface projectId={projectId} id="review-rule"><ReviewRule key={projectId} projectId={projectId} meId={meId} canEdit={manager} /></AiSurface>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
