import type { ObjectNotice } from '@flux/contracts';
import { Icon } from '../ui';
import { objectState } from './objectNotices';
import { useShellActions } from './shellContext';
import './object-notices.css';

/**
 * The top of a decision's one discussion (founder decision, Hubert, 2026-11-15, #1424): the thread on the decision's card has no root
 * message, so its head is the decision itself, as its card draws it (flag, title, state), which opens the decision in the panel; every
 * message below is a reply to it, and its count is the card's.
 */
export function DiscussedDecision({ decision, notice, replies, firstDay }: {
  decision: { decisionId: string; title: string }; notice: ObjectNotice | null; replies: number; firstDay: string | null;
}) {
  const { openDetails } = useShellActions();
  const state = notice ? objectState(notice) : null;
  const title = notice?.title ?? decision.title;
  return (
    <>
      <article className="thread__root thread__root--decision" aria-label={`Discussion of the decision ${title}`} data-discussed-decision={decision.decisionId}>
        <button type="button" className="convo-notice__task convo-object__card" onClick={() => openDetails({ kind: 'decision', id: decision.decisionId })}
          aria-label={`Open decision ${title}${state ? `, ${state.word.toLowerCase()}` : ''}`}>
          <Icon name="flag" size={16} />
          <span className="convo-notice__title">{title}</span>
          {state ? <span className="convo-object__state" data-state={state.state}>{state.word}</span> : null}
          <Icon name="chevron-right" size={14} />
        </button>
      </article>
      {replies ? <p className="thread__hint">{`${replies} ${replies === 1 ? 'reply' : 'replies'}${firstDay ? ` · ${firstDay}` : ''}`}</p> : null}
    </>
  );
}

/**
 * The task a thread is the discussion of (personas-34): opened from Search, a notice or a link, a task's discussion says whose it is, "#3"
 * and the task's title, above its first message, and that row opens the task in the one panel as its card does.
 */
export function DiscussedTaskHead({ task }: { task: { workId: string; number: number; title: string } }) {
  const { openDetails } = useShellActions();
  return (
    <article className="thread__root thread__root--decision thread__root--task" aria-label={`Discussion of task #${task.number} ${task.title}`} data-discussed-task={task.workId}>
      <button type="button" className="convo-notice__task convo-object__card" onClick={() => openDetails({ kind: 'work', id: task.workId })}
        aria-label={`Open task #${task.number} ${task.title}`}>
        <Icon name="tasks" size={16} />
        <span className="convo-notice__num ui-task-number">#{task.number}</span>
        <span className="convo-notice__title">{task.title}</span>
        <Icon name="chevron-right" size={14} />
      </button>
    </article>
  );
}
