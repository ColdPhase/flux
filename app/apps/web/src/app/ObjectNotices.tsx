import type { ObjectNotice } from '@flux/contracts';
import { FORMER_MEMBER } from '../docs/format';
import { AgentIdentity, Icon } from '../ui';
import { agentAuthorOwner, type AgentOwners } from '../agents/owners';
import { AuthorFace, clock, when } from './messageParts';
import { objectPhrase, objectState, objectTarget } from './objectNotices';
import './object-notices.css';

/**
 * A decision proposed or accepted (#694, F-026 P5). A proposal is the decision's one card (#1424): the decision with its state now,
 * and inside the card one quiet line of who proposed it, from what and when. An acceptance is one line, never a second card: "accepted
 * it" right under its card, else "accepted the decision <title>", the title opening it. It is information, not a message: no replies or
 * actions of its own, and the card opens the object in Details (one panel on the computer, one sheet on the phone). The same card
 * sits in the project's stream and, when it came from a thread, in that thread.
 */
export function ObjectNoticeItem({ notice, meId, owners, authorOf, inThread = false, hasMessage, onOpen, onOpenThread, follows = false }: {
  notice: ObjectNotice; meId: string; owners: AgentOwners; authorOf: (messageId: string) => string | null; inThread?: boolean;
  /** The acceptance directly under its proposal (`followsProposal`): one line, "accepted it", and no second card. */
  follows?: boolean;
  hasMessage: (messageId: string) => boolean; onOpen: (target: ReturnType<typeof objectTarget>) => void; onOpenThread?: (conversationId: string) => void;
}) {
  const by = notice.by;
  const name = by.name ?? (by.kind === 'agent' ? 'Agent' : FORMER_MEMBER);
  const mine = by.kind === 'human' && by.id === meId;
  const phrase = objectPhrase(notice, authorOf, inThread, { name, mine }, follows);
  const state = objectState(notice);
  const target = objectTarget(notice);
  const message = notice.sources.find((source) => source.type === 'message');
  const toMessage = () => {
    if (!message) return;
    const element = document.getElementById(`message-${message.id}`);
    if (!element) return;
    element.scrollIntoView({ block: 'center' });
    element.focus({ preventScroll: true });
  };
  const link = phrase.link ? phrase.linkTo === 'object'
    ? <button type="button" className="convo-notice__src" onClick={() => onOpen(target)} aria-label={`Open decision ${notice.title}, ${state.word.toLowerCase()}`}>{phrase.link}</button>
    : phrase.linkTo === 'message' && message && hasMessage(message.id)
    ? <button type="button" className="convo-notice__src" onClick={toMessage}>{phrase.link}</button>
    : phrase.linkTo === 'thread' && notice.conversationId && onOpenThread
      ? <button type="button" className="convo-notice__src" onClick={() => onOpenThread(notice.conversationId!)}>{phrase.link}</button>
      : <span className="convo-notice__src">{phrase.link}</span> : null;
  const card = notice.kind === 'decision.proposed';
  const meta = (
    <p className="convo-notice__meta">
      {by.kind === 'agent' ? <strong><AgentIdentity name={name} owner={agentAuthorOwner(by, owners)} icon={false} hue={by.colour} /></strong> : <strong>{name}{mine ? ' · you' : ''}</strong>}
      <span className="convo-notice__what">{phrase.lead}{link ? <> {link}</> : null}</span>
      <time dateTime={notice.createdAt} title={when(notice.createdAt)}>{clock(notice.createdAt)}</time>
    </p>
  );
  return (
    <li className={`convo-object${follows ? ' is-follow' : ''}${card ? '' : ' is-line'}`} id={`object-${notice.id}`} data-object-kind={notice.kind} data-object-id={target.id} data-object-state={state.state}>
      <AuthorFace kind={by.kind} id={by.id} name={name} mine={mine} hue={by.colour} />
      {card ? <div className="convo-notice__body convo-notice__card">
        {meta}
        <button type="button" className="convo-notice__task convo-object__card" onClick={() => onOpen(target)} aria-label={`Open decision ${notice.title}, ${state.word.toLowerCase()}`}>
          <Icon name="flag" size={16} />
          <span className="convo-notice__title">{notice.title}</span>
          <span className="convo-object__state" data-state={state.state}>{state.word}</span>
          <Icon name="chevron-right" size={14} />
        </button>
      </div> : <div className="convo-notice__body">{meta}</div>}
    </li>
  );
}
