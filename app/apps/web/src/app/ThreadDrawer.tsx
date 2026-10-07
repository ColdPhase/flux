import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ConversationMessage, NativeWorkRow } from '@flux/contracts';
import { Icon, IconButton, useMediaQuery } from '../ui';
import { DiscussedTask, MessageObjects } from '../work/inline';
import type { MessageWorkPreview } from '../work/message-associations';
import { AgentAuthor, AuthorFace, SourceCitation, clock, day, when } from './messageParts';
import { MessageFiles } from '../composer/Files';

export type ThreadMode = 'docked' | 'sheet';

/**
 * One root's replies (UI116-1): docked beside the stream on a wide sheet, and a full sheet over the
 * stream on a phone or a narrow tablet. It is not modal: the header, tabs, a live session's bar and,
 * when docked, the stream stay usable. Esc inside it closes it; the opener takes focus back.
 */
export function ThreadDrawer({ mode, count, focusOnOpen, onClose, children }: { mode: ThreadMode; count: number; focusOnOpen: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (focusOnOpen && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
    // When it opens; the composer may take focus first when the person chose Reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Escape that ends an input method's composition is not a request to close.
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    onClose();
  };
  return (
    <aside ref={ref} id="thread" className={`thread thread--${mode}`} aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="thread__head">
        <h2 className="thread__title" id={titleId}>Replies</h2>
        <span className="thread__n"><span className="ui-vh">, </span>{count}</span>
        <IconButton icon={mode === 'sheet' ? 'chevron-left' : 'x'} label="Close replies" className="thread__close" onClick={onClose} />
      </div>
      {children}
    </aside>
  );
}

/**
 * A reply's actions in the narrow thread (Create work, Propose decision, Attach result, Details): as on touch,
 * one quiet ⋯ in the reply's corner opens them under the reply, so the full bar never covers its author or
 * leaves empty rows between replies. Touch already has its own ⋯; a reader has only Details.
 */
export function ThreadMessageActions({ writable, children }: { writable: boolean; children: ReactNode }) {
  const touch = useMediaQuery('(hover: none)');
  const [open, setOpen] = useState(false);
  if (touch || !writable) return <>{children}</>;
  return (
    <>
      <div className="ws-acts ws-acts--more thread__more">
        <button type="button" className="ws-act ws-more" aria-expanded={open} aria-label="Make from this message" data-tip={open ? 'Hide actions' : 'Make from this message'} onClick={() => setOpen((value) => !value)}><Icon name="more" size={16} /></button>
      </div>
      {open ? <div className="thread__acts">{children}</div> : null}
    </>
  );
}

/** The message the thread answers, at its top: who said it, when, and what, with its cited source. */
export function ThreadRoot({ message, projectId, body, author, agentOwner = null, meId, writable, replies, task = null, taskRow = null, preview = null, onDenied }: {
  message: ConversationMessage | null; projectId: string; body: string; author: string | null; agentOwner?: string | null; meId: string; writable: boolean; replies: number;
  /** The task whose discussion this thread is (UI116-3), and its row from the thread's visible reference read (#155). */
  task?: { workId: string; title: string } | null; taskRow?: NativeWorkRow | null;
  /** What was made from the root, from the thread's bounded association read (#155): the root is shown whole here. */
  preview?: MessageWorkPreview | null; onDenied: (cause: unknown) => void;
}) {
  const mine = !!message && message.authorId === meId;
  return (
    <>
      <article className={`thread__root${mine ? ' is-mine' : ''}`} id={message ? `thread-root-${message.id}` : undefined} data-message-id={message?.id} aria-label={author ? `Message from ${mine ? 'you' : author}` : 'Opening message'}>
        {message && author ? (
          <div className="thread__root-meta">
            <AuthorFace message={message} name={author} mine={mine} size="sm" />
            <strong>{mine ? `${author} · you` : message.authorId === null ? <AgentAuthor message={message} owner={agentOwner} /> : author}</strong>
            <time dateTime={message.createdAt} title={when(message.createdAt)}>{day(message.createdAt)} · {clock(message.createdAt)}</time>
          </div>
        ) : null}
        {message?.body || !message ? <p>{body}</p> : null}
        <MessageFiles files={message?.files} />
        {message?.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={onDenied} /> : null}
        {message ? <MessageObjects message={message} projectId={projectId} preview={preview} thread={task} threadRow={taskRow} />
          : task ? <div className="ws-attach"><DiscussedTask task={task} row={taskRow} /></div> : null}
      </article>
      <p className="thread__hint">{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : writable ? 'Reply to this message. No new topic needed.' : 'No replies yet.'}</p>
    </>
  );
}
