import type { ObjectNotice } from '@flux/contracts';
import { FORMER_MEMBER } from '../docs/format';
import { AgentIdentity, Icon } from '../ui';
import { agentAuthorOwner, type AgentOwners } from '../agents/owners';
import { AuthorFace, clock, when } from './messageParts';
import { objectPhrase, objectState, objectTarget } from './objectNotices';
import './object-notices.css';

/**
 * One line that a decision was proposed or accepted, or a result recorded (#694, F-026 P5): who did it and where it
 * came from, then the object as a card with its state now. It is information, not a message: no replies or actions
 * of its own, and the card opens the object in Details (one panel on the computer, one sheet on the phone). The same
 * line sits in the project's stream and, when it came from a thread, in that thread.
 */
export function ObjectNoticeItem({ notice, meId, owners, authorOf, inThread = false, hasMessage, onOpen, onOpenThread, task, observeId, follows = false }: {
  notice: ObjectNotice; meId: string; owners: AgentOwners; authorOf: (messageId: string) => string | null; inThread?: boolean;
  /** The acceptance directly under its proposal (`followsProposal`): one line, "accepted it", and no second card. */
  follows?: boolean;
  hasMessage: (messageId: string) => boolean; onOpen: (target: ReturnType<typeof objectTarget>) => void; onOpenThread?: (conversationId: string) => void;
  /** The task whose discussion this result opened (#763 A1): the line says "on #9" and opens that thread. */
  task?: { number: number; title: string; replies: number; open: boolean; onOpen: () => void };
  /** The message this line stands for in the stream (the result's contribution), read when the line is seen. */
  observeId?: string;
}) {
  const by = notice.by;
  const name = by.name ?? (by.kind === 'agent' ? 'Agent' : FORMER_MEMBER);
  const mine = by.kind === 'human' && by.id === meId;
  const phrase = objectPhrase(notice, authorOf, inThread, { name, mine }, follows);
  const state = objectState(notice);
  const target = objectTarget(notice);
  const noun = target.kind === 'decision' ? 'decision' : 'result';
  const message = notice.sources.find((source) => source.type === 'message');
  const toMessage = () => {
    if (!message) return;
    const element = document.getElementById(`message-${message.id}`);
    if (!element) return;
    element.scrollIntoView({ block: 'center' });
    element.focus({ preventScroll: true });
  };
  const link = phrase.link ? phrase.linkTo === 'message' && message && hasMessage(message.id)
    ? <button type="button" className="convo-notice__src" onClick={toMessage}>{phrase.link}</button>
    : phrase.linkTo === 'thread' && notice.conversationId && onOpenThread
      ? <button type="button" className="convo-notice__src" onClick={() => onOpenThread(notice.conversationId!)}>{phrase.link}</button>
      : <span className="convo-notice__src">{phrase.link}</span> : null;
  return (
    <li className={`convo-object${follows ? ' is-follow' : ''}`} id={`object-${notice.id}`} data-object-kind={notice.kind} data-object-id={target.id} data-object-state={state.state} data-observe-id={observeId}>
      <AuthorFace kind={by.kind} name={name} mine={mine} />
      <div className="convo-notice__body">
        <p className="convo-notice__meta">
          {by.kind === 'agent' ? <strong><AgentIdentity name={name} owner={agentAuthorOwner(by, owners)} icon={false} /></strong> : <strong>{name}{mine ? ' · you' : ''}</strong>}
          <span className="convo-notice__what">{phrase.lead}{link ? <> {link}</> : null}{task ? <> on <button type="button" className="convo-notice__src" aria-expanded={task.open}
            aria-label={`Open the discussion of task #${task.number}: ${task.title}${task.replies ? `, ${task.replies} ${task.replies === 1 ? 'reply' : 'replies'}` : ''}`} onClick={task.onOpen}>#{task.number}</button>{task.replies ? <> · {task.replies} {task.replies === 1 ? 'reply' : 'replies'}</> : null}</> : null}</span>
          <time dateTime={notice.createdAt} title={when(notice.createdAt)}>{clock(notice.createdAt)}</time>
        </p>
        {follows ? null : <button type="button" className="convo-notice__task convo-object__card" onClick={() => onOpen(target)} aria-label={`Open ${noun} ${notice.title}, ${state.word.toLowerCase()}`}>
          <Icon name={target.kind === 'decision' ? 'rule' : 'result'} size={16} />
          <span className="convo-notice__title">{notice.title}</span>
          <span className="convo-object__state" data-state={state.state}>{state.word}</span>
          <Icon name="chevron-right" size={14} />
        </button>}
      </div>
    </li>
  );
}
