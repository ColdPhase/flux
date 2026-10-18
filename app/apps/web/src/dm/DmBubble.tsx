import type { DmMessage } from '@flux/contracts';
import { Avatar, Icon } from '../ui';
import { MessageContent } from '../composer/Files';
import { OutboxStatus } from '../composer/Outbox';
import type { PendingSend } from '../composer/draft';
import { MessageDay, MessageTime, clock } from '../app/messageParts';
import { MessageText } from '../app/MessageText';
import { MessageActions, useTouchActions, type DmActionOptions } from '../work/messageActions';

/** The part of this message the person selected with the pointer, if any: the starting excerpt of a task copy. */
function selectedIn(messageId: string, body: string): string | undefined {
  const selection = window.getSelection();
  const text = selection?.toString() ?? '';
  if (!selection || selection.isCollapsed || !text.trim()) return undefined;
  const anchor = selection.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  const inBody = element?.closest('.dm-msg')?.getAttribute('data-message-id') === messageId && !!element?.closest('.dm-msg__body');
  return inBody && body.includes(text) ? text : undefined;
}

/**
 * One stored private message, as a root in the conversation or as a root or reply in its thread. The same bubble,
 * grouping, time, day line and actions everywhere: reply in thread and create task beside it on a computer, swipe
 * left and long press on a phone, and the thread count under a root that has replies.
 */
export function DmBubble({ message, pending, mine, name, continued, groupLast, day, writable, selecting, picked, arrived, observed, seenBy, nav,
  onReply, onCreateTask, onOpenThread, onPick, onRetry, onRemove }: {
  /** The stored message, or (while it is being sent) the person's queued one, which the stored one then replaces in place (#264). */
  message: DmMessage | null; pending?: PendingSend | null; mine: boolean; name: string; continued: boolean; groupLast: boolean;
  /** The day label when this message starts a new day. */
  day: string | null;
  writable: boolean; selecting: boolean; picked: boolean; arrived: boolean;
  /** Other people's messages are watched for viewing receipts. */
  observed: boolean; seenBy: readonly string[];
  /** Roots in the conversation show their thread count and open the thread; elsewhere they do not. */
  nav: 'stream' | 'thread';
  onReply?: () => void;
  onCreateTask: (message: DmMessage, excerpt: string | undefined) => void;
  onOpenThread?: (message: DmMessage, trigger: HTMLElement) => void;
  onPick: (id: string) => void;
  onRetry?: () => void; onRemove?: () => void;
}) {
  const actions: DmActionOptions | null = selecting || !message ? null : {
    kind: 'dm', messageId: message.id, body: message.body, writable,
    onCreateWork: () => onCreateTask(message, selectedIn(message.id, message.body)),
    onReply,
  };
  const touch = useTouchActions<HTMLLIElement>(actions);
  const { className: touchClass, ...touchHandlers } = touch.props;
  const label = mine ? 'Your message' : `${name}’s message`;
  if (!message) {
    const item = pending!;
    return (
      <li id={`pending-${item.id}`} data-client-message-id={item.id} data-send-state={item.state}
        className={`dm-msg is-mine is-pending${continued ? ' dm-msg--cont' : ''}${item.state === 'failed' ? ' is-failed-send' : ''}`}>
        {day ? <MessageDay as="p" label={day} /> : null}
        <div className="dm-msg__row">
          <div className="dm-msg__main is-mine">
            <MessageContent body={<div className="dm-msg__body"><MessageText body={item.body} /></div>} />
            <OutboxStatus item={item} onRetry={onRetry ?? (() => undefined)} onRemove={onRemove ?? (() => undefined)} />
          </div>
        </div>
      </li>
    );
  }
  return (
    <li {...touchHandlers} id={`${nav === 'thread' ? 'thread-message' : 'message'}-${message.id}`} tabIndex={-1}
      className={`dm-msg${mine ? ' is-mine' : ''}${continued ? ' dm-msg--cont' : ''}${arrived ? ' is-arrived' : ''}${picked ? ' is-picked' : ''} ${touchClass}`}
      data-sequence={message.sequence} data-message-id={message.id} {...(observed ? { 'data-observe-id': message.id } : {})} aria-label={label}>
      {day ? <MessageDay as="p" label={day} /> : null}
      {/* While selecting, the whole row toggles; the check is the keyboard and screen reader control. */}
      <div className="dm-msg__row" onClick={selecting ? (event) => { if (!(event.target as HTMLElement).closest('.dm-msel')) onPick(message.id); } : undefined}>
        {selecting ? (
          <button type="button" className="dm-msel" aria-pressed={picked} onClick={() => onPick(message.id)}
            aria-label={`Select ${mine ? 'your' : `${name}’s`} message, ${clock(message.createdAt)}`}>
            <i><Icon name="check" size={12} /></i>
          </button>
        ) : null}
        <span className="dm-msg__face">{continued || mine ? null : <Avatar name={name} size="lg" tone="neutral" />}</span>
        <div className={`dm-msg__main${mine ? ' is-mine' : ''}`}>
          {continued || mine ? null : <p className="dm-msg__meta"><b>{name}</b></p>}
          <MessageContent body={<div className="dm-msg__body"><MessageText body={message.body} /></div>} />
          {nav === 'stream' && message.replyCount > 0 ? (
            <button type="button" className="dm-replies" data-replies={message.replyCount} aria-label={`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}, open thread`}
              onClick={(event) => onOpenThread?.(message, event.currentTarget)}>
              <Icon name="reply" size={13} />{message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            </button>
          ) : null}
          {groupLast ? <MessageTime at={message.createdAt} seenBy={seenBy} /> : null}
          {actions && !selecting ? <MessageActions {...actions} /> : null}
        </div>
      </div>
      {touch.node}
    </li>
  );
}
