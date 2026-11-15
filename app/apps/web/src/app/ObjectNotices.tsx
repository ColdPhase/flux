import type { ObjectNotice } from '@flux/contracts';
import { FORMER_MEMBER } from '../docs/format';
import { AgentIdentity, Icon } from '../ui';
import { agentAuthorOwner, type AgentOwners } from '../agents/owners';
import { AuthorFace, clock, day, when } from './messageParts';
import { objectPhrase, objectState, objectTarget } from './objectNotices';
import { isPendingDecision, decisionOnceMade } from '../work/heldProposals';
import { useShellActions } from './shellContext';
import './object-notices.css';

/** When it was accepted: the time on the day it was proposed (the card stands under that day's line), else the day ("Today", "15 Nov"). */
const decidedWhen = (at: string, proposedAt: string) => (new Date(at).toDateString() === new Date(proposedAt).toDateString() ? clock(at) : day(at));

/**
 * A decision in the conversation (#694, F-026 P5): its one card (#1424), the decision with its state now, and inside the card one
 * quiet line of who proposed it, from what and when. Accepting it changes the card in place (founder decision D, #1424,
 * 2026-11-15): the state word reads "Accepted" and a quiet line in the card says who accepted it and when; there is no second line
 * in the conversation. It is information, not a message: no replies or actions of its own, and the card opens the object in
 * Details (one panel on the computer, one sheet on the phone). The same card sits in the project's stream and, when it came from a
 * thread, in that thread.
 */
export function ObjectNoticeItem({ notice, meId, owners, authorOf, inThread = false, hasMessage, onOpen, onOpenThread, onOpenDiscussion, openThread = null }: {
  notice: ObjectNotice; meId: string; owners: AgentOwners; authorOf: (messageId: string) => string | null; inThread?: boolean;
  hasMessage: (messageId: string) => boolean; onOpen: (target: ReturnType<typeof objectTarget>) => void; onOpenThread?: (conversationId: string) => void;
  /** Its one discussion (#1424): "N replies" under the card opens that thread. `openThread`: the thread open beside the stream. */
  onOpenDiscussion?: (conversationId: string) => void; openThread?: string | null;
}) {
  const by = notice.by;
  const name = by.name ?? (by.kind === 'agent' ? 'Agent' : FORMER_MEMBER);
  const mine = by.kind === 'human' && by.id === meId;
  const phrase = objectPhrase(notice, authorOf, inThread, { name, mine });
  const state = objectState(notice);
  // A proposal whose request is still on its way opens once it exists (#1424 L: it is sent at once, there is no hold).
  const target = objectTarget(notice);
  const open = (to: ReturnType<typeof objectTarget>) => {
    if (!isPendingDecision(to.id)) { onOpen(to); return; }
    void decisionOnceMade(to.id).then((id) => { if (id) onOpen({ kind: 'decision', id }); });
  };
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
  // The card of the decision the panel shows is the open one (as an open thread's root keeps its fill), from whatever opened it: the card
  // itself, Search, the Inbox or a notification all open a decision here.
  const { shownObject } = useShellActions();
  const current = shownObject?.kind === 'decision' && shownObject.id === target.id;
  // Who accepted it and when, on the card itself (#1424 D): only while it is the accepted decision; a replaced one says Replaced.
  const decided = notice.status === 'accepted' && notice.decided ? notice.decided : null;
  const decider = decided ? decided.by.name ?? FORMER_MEMBER : '';
  return (
    <li className="convo-object" id={`object-${notice.id}`} data-object-kind={notice.kind} data-object-id={target.id} data-object-state={state.state}>
      <AuthorFace kind={by.kind} id={by.id} name={name} mine={mine} hue={by.colour} />
      <div className={`convo-notice__body convo-notice__card${current ? ' is-open' : ''}`}>
        <p className="convo-notice__meta">
          {by.kind === 'agent' ? <strong><AgentIdentity name={name} owner={agentAuthorOwner(by, owners)} icon={false} hue={by.colour} /></strong> : <strong>{name}{mine ? ' (you)' : ''}</strong>}
          <span className="convo-notice__what">{phrase.lead}{link ? <> {link}</> : null}</span>
          <time dateTime={notice.createdAt} title={when(notice.createdAt)}>{clock(notice.createdAt)}</time>
        </p>
        <button type="button" className="convo-notice__task convo-object__card" data-decision-card={target.id} onClick={() => open(target)} aria-label={`Open decision ${notice.title}, ${state.word.toLowerCase()}`}
          aria-current={current ? 'true' : undefined}>
          <Icon name="flag" size={16} />
          <span className="convo-notice__title">{notice.title}</span>
          <span className="convo-object__state" data-state={state.state}>{state.word}</span>
          <Icon name="chevron-right" size={14} />
        </button>
        {decided ? <p className="convo-object__decided">Accepted by {decider}{decided.by.kind === 'human' && decided.by.id === meId ? ' (you)' : ''}
          {' · '}<time dateTime={decided.at} title={when(decided.at)}>{decidedWhen(decided.at, notice.createdAt)}</time></p> : null}
        {/* The decision's one discussion (founder decision, Hubert, 2026-11-15, #1424): the thread on this card, as a root's replies are. */}
        {notice.discussion && notice.discussion.replyCount && onOpenDiscussion ? <div className="convo-replies convo-object__replies">
          <button type="button" className="convo-replies__open" data-decision-replies={target.id} aria-expanded={openThread === notice.discussion.conversationId}
            aria-controls={openThread === notice.discussion.conversationId ? 'thread' : undefined} onClick={() => onOpenDiscussion(notice.discussion!.conversationId)}>
            <Icon name="chat" size={13} />{notice.discussion.replyCount} {notice.discussion.replyCount === 1 ? 'reply' : 'replies'}
            <span className="convo-replies__when">· last {day(notice.discussion.lastReplyAt) === 'Today' ? clock(notice.discussion.lastReplyAt) : day(notice.discussion.lastReplyAt)}</span>
          </button>
        </div> : null}
      </div>
    </li>
  );
}
