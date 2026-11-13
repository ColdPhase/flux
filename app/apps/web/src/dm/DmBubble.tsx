import type { DmMessage } from '@flux/contracts';
import { Avatar, Icon, Kreska } from '../ui';
import { MessageContent } from '../composer/Files';
import { OutboxStatus } from '../composer/Outbox';
import type { PendingSend } from '../composer/draft';
import { MessageDay, MessageTime, ShownAnswerName, shownAnswer, shownLabel } from '../app/messageParts';
import type { Receipt } from '../app/receipts';
import { MessageText } from '../app/MessageText';
import { useAddToMyMap } from '../sketch/myMap';
import { MessageActions, useTouchActions, type DmActionOptions } from '../work/messageActions';
import { useOwnMessage } from '../work/ownMessage';
import { editDmMessage, removeDmMessage } from '../api/direct-messages';
import { announceMessageChanged } from '../conversations/messageChanges';

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
export function DmBubble({ dmId, message, pending, mine: authored, name, continued, groupLast, day, writable, arrived, observed, receipt, nav,
  onReply, onCreateTask, onOpenThread, onRetry, onRemove }: {
  /** The conversation, for the message's link. */
  dmId: string;
  /** The stored message, or (while it is being sent) the person's queued one, which the stored one then replaces in place (#264). */
  message: DmMessage | null; pending?: PendingSend | null; mine: boolean; name: string; continued: boolean; groupLast: boolean;
  /** The day label when this message starts a new day. */
  day: string | null;
  writable: boolean; arrived: boolean;
  /** Other people's messages are watched for viewing receipts. */
  observed: boolean; receipt?: Receipt | undefined;
  /** Roots in the conversation show their thread count and open the thread; elsewhere they do not. */
  nav: 'stream' | 'thread';
  onReply?: () => void;
  onCreateTask: (message: DmMessage, excerpt: string | undefined) => void;
  onOpenThread?: (message: DmMessage, trigger: HTMLElement) => void;
  onRetry?: () => void; onRemove?: () => void;
}) {
  const addToMyMap = useAddToMyMap();
  // An agent's answer its asker posted reads as that agent's message, for the asker too (#1232): `authored` keeps Edit and Delete theirs.
  const shown = message ? shownAnswer(message) : null;
  const mine = authored && !shown;
  // Edit and Delete are the author's, on a message that is still there (#1006). They stay open to the author of a 1:1 whose other person left.
  const own = useOwnMessage(message && authored && !message.removedAt ? {
    body: message.body, focusId: `${nav === 'thread' ? 'thread-message' : 'message'}-${message.id}`,
    save: async (body) => announceMessageChanged(await editDmMessage(dmId, message.id, body)),
    remove: async () => announceMessageChanged(await removeDmMessage(dmId, message.id)),
  } : null);
  const actions: DmActionOptions | null = !message ? null : {
    kind: 'dm', dmId, messageId: message.id, threadRootId: message.threadRootId, body: message.body, writable,
    onCreateWork: () => onCreateTask(message, selectedIn(message.id, message.body)),
    onReply,
    onAddToMap: () => void addToMyMap(message.body),
    onEdit: own.onEdit, onDelete: own.onDelete, removed: !!message.removedAt,
  };
  const touch = useTouchActions<HTMLLIElement>(actions);
  const { className: touchClass, ...touchHandlers } = touch.props;
  const label = shown ? shownLabel(shown, name).spoken : mine ? 'Your message' : `${name}’s message`;
  // AI used in this conversation (#842, F-036 AG-4): one line for both people, naming the company that receives the conversation.
  if (message?.notice === 'ai_used') {
    return (
      <li id={`${nav === 'thread' ? 'thread-message' : 'message'}-${message.id}`} tabIndex={-1} className="dm-notice" data-message-id={message.id} data-sequence={message.sequence} aria-label="AI was used here">
        {day ? <MessageDay as="p" label={day} /> : null}
        <p className="dm-notice__line"><Icon name="lock" size={12} />{mine ? 'You' : name} used AI here ({message.body})</p>
      </li>
    );
  }
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
      className={`dm-msg${mine ? ' is-mine' : ''}${continued ? ' dm-msg--cont' : ''}${arrived ? ' is-arrived' : ''} ${touchClass}`}
      data-sequence={message.sequence} data-message-id={message.id} {...(observed ? { 'data-observe-id': message.id } : {})} {...(shown ? { 'data-shown-answer': '' } : {})} aria-label={label}>
      {day ? <MessageDay as="p" label={day} /> : null}
      <div className="dm-msg__row">
        <span className="dm-msg__face">{continued || mine ? null : shown ? <Kreska size={32} hue={shown.colour} className="author-face" /> : <Avatar name={name} id={message.authorId} size="lg" tone="neutral" />}</span>
        <div className={`dm-msg__main${mine ? ' is-mine' : ''}`}>
          {continued || mine ? null : shown ? <p className="dm-msg__meta"><ShownAnswerName shown={shown} asker={name} /></p>
            : <p className="dm-msg__meta"><b>{name}</b>{message.via ? <span className="dm-msg__via">via {message.via}</span> : null}</p>}
          {mine && message.via ? <p className="dm-msg__meta"><span className="dm-msg__via">via {message.via}</span></p> : null}
          <MessageContent body={own.slot ?? <div className={`dm-msg__body${message.removedAt ? ' message-body--removed' : ''}`}><MessageText body={message.body} /></div>} references={message.references} />
          {nav === 'stream' && message.replyCount > 0 ? (
            <button type="button" className="dm-replies" data-replies={message.replyCount} aria-label={`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}, open thread`}
              onClick={(event) => onOpenThread?.(message, event.currentTarget)}>
              <Icon name="reply" size={13} />{message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            </button>
          ) : null}
          {groupLast ? <MessageTime at={message.createdAt} receipt={receipt} edited={message.editedAt} /> : null}
          {actions ? <MessageActions {...actions} /> : null}
          {touch.dots}
        </div>
      </div>
      {touch.node}
    </li>
  );
}
