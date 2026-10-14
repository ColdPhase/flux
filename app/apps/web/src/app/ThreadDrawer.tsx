import { useId, type ReactNode } from 'react';
import type { ConversationMessage, NativeWorkRow } from '@flux/contracts';
import { IconButton } from '../ui';
import { DetentSheet } from '../ui/DetentSheet';
import { DiscussedTask, MessageObjects } from '../work/inline';
import type { MessageWorkPreview } from '../work/message-associations';
import { AgentAuthor, AuthorFace, SourceCitation, clock, day, when } from './messageParts';
import { MessageContent, type PhotoActions } from '../composer/Files';
import { LinkPreviews, MessageText } from './MessageText';
import { useProjectShell } from '../project/data';
import { QuestionCard, WhenNoQuestion } from '../agents/QuestionCard';

export type ThreadMode = 'docked' | 'sheet';

/**
 * One root's replies (UI116-1): docked beside the stream on a wide sheet, and a full sheet over the
 * stream on a phone or a narrow tablet. It is not modal: the header, tabs, a live session's bar and,
 * when docked, the stream stay usable. Esc inside it closes it; the opener takes focus back.
 */
export function ThreadDrawer({ mode, count, focusOnOpen, onClose, title, closeLabel = 'Close replies', children }: {
  mode: ThreadMode; count?: number; focusOnOpen: boolean; onClose: () => void;
  /** The heading (default "Thread", read as "Replies: Thread"); the Agents view names the task here. */
  title?: string;
  /** The close control's name (default "Close replies"). */
  closeLabel?: string; children: ReactNode;
}) {
  const titleId = useId();
  const head = (
    <div className="thread__head">
      <h2 className="thread__title" id={titleId}>{title ?? <><span className="ui-vh">Replies: </span><span className="ui-panel__kind">Thread</span></>}</h2>
      {count === undefined ? null : <span className="thread__n">{count} {count === 1 ? 'reply' : 'replies'}</span>}
      <IconButton icon={mode === 'sheet' ? 'chevron-left' : 'x'} label={closeLabel} className="thread__close" onClick={onClose} />
    </div>
  );
  // Over the stream on a phone or a narrow tablet it is the one two-height sheet, opening at full height;
  // docked beside the stream it is the same element without the sheet, so a reply draft survives the change.
  return (
    <DetentSheet as="aside" id="thread" className={`thread thread--${mode}`} aria-labelledby={titleId} detent={mode === 'sheet'} startFull focusOnOpen={focusOnOpen} onClose={onClose}>
      {head}
      {children}
    </DetentSheet>
  );
}

/** The message the thread answers, at its top: who said it, when, and what, with its cited source. */
export function ThreadRoot({ message, projectId, body, author, agentOwner = null, meId, writable, replies, task = null, taskRow = null, preview = null, onDenied, photo }: {
  message: ConversationMessage | null; projectId: string; body: string; author: string | null; agentOwner?: string | null; meId: string; writable: boolean; replies: number;
  /** The task whose discussion this thread is (UI116-3), and its row from the thread's visible reference read (#155). */
  task?: { workId: string; title: string; number?: number } | null; taskRow?: NativeWorkRow | null;
  /** What was made from the root, from the thread's bounded association read (#155): the root is shown whole here. */
  preview?: MessageWorkPreview | null; onDenied: (cause: unknown) => void;
  /** Reply and Create task in the photo viewer, as this reader may use them (#348). */
  photo?: PhotoActions & { place?: string };
}) {
  const mine = !!message && message.authorId === meId;
  const people = useProjectShell()?.people ?? null;
  return (
    <>
      <article className={`thread__root${mine ? ' is-mine' : ''}`} id={message ? `thread-root-${message.id}` : undefined} data-message-id={message?.id} aria-label={author ? `Message from ${mine ? 'you' : author}` : 'Opening message'}>
        {message && author ? (
          <div className="thread__root-meta">
            <AuthorFace kind={message.authorId === null ? 'agent' : 'human'} name={author} mine={mine} />
            <strong>{mine ? `${author} · you` : message.authorId === null ? <AgentAuthor message={message} owner={agentOwner} /> : author}</strong>
            <time dateTime={message.createdAt} title={when(message.createdAt)}>{day(message.createdAt)} · {clock(message.createdAt)}</time>
          </div>
        ) : null}
        <MessageContent body={message?.body || !message ? <WhenNoQuestion projectId={projectId} messageId={message?.id ?? null}><p><MessageText body={body} people={people} /></p></WhenNoQuestion> : null} files={message?.files} context={message ? { author: author ?? undefined, at: message.createdAt, caption: message.body, ...photo } : undefined}>
          <LinkPreviews body={body} />
          {message ? <MessageObjects message={message} projectId={projectId} preview={preview} thread={task} threadRow={taskRow} />
            : task ? <div className="ws-attach"><DiscussedTask task={task} row={taskRow} /></div> : null}
          {message?.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={onDenied} /> : null}
        </MessageContent>
        {message ? <QuestionCard projectId={projectId} messageId={message.id} meId={meId} writable={writable} /> : null}
      </article>
      <p className="thread__hint">{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : writable ? 'Reply to this message. No new topic needed.' : 'No replies yet.'}</p>
    </>
  );
}
