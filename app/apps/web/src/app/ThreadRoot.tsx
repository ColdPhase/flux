import type { ConversationMessage, NativeWorkRow } from '@flux/contracts';
import { DiscussedTask, MessageObjects } from '../work/inline';
import type { MessageWorkPreview } from '../work/message-associations';
import { AgentAuthor, AuthorFace, SourceCitation, MessageTime } from './messageParts';
import { MessageContent, type PhotoActions } from '../composer/Files';
import { LinkPreviews, MessageText } from './MessageText';
import { useProjectShell } from '../project/data';
import { QuestionCard, WhenNoQuestion } from '../agents/QuestionCard';

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
        {message && author && !mine ? (
          <div className="thread__root-meta">
            <AuthorFace kind={message.authorId === null ? 'agent' : 'human'} name={author} mine={mine} />
            <strong>{mine ? `${author} · you` : message.authorId === null ? <AgentAuthor message={message} owner={agentOwner} /> : author}</strong>
          </div>
        ) : null}
        <MessageContent body={message?.body || !message ? <WhenNoQuestion projectId={projectId} messageId={message?.id ?? null}><div className="message-body"><MessageText body={body} people={people} /></div></WhenNoQuestion> : null} files={message?.files} references={message?.references} context={message ? { author: author ?? undefined, at: message.createdAt, caption: message.body, ...photo } : undefined}>
          <LinkPreviews body={body} />
          {message ? <MessageObjects message={message} projectId={projectId} preview={preview} thread={task} threadRow={taskRow} />
            : task ? <div className="ws-attach"><DiscussedTask task={task} row={taskRow} /></div> : null}
          {message?.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={onDenied} /> : null}
        </MessageContent>
        {message ? <MessageTime at={message.createdAt} /> : null}
        {message ? <QuestionCard projectId={projectId} messageId={message.id} meId={meId} writable={writable} /> : null}
      </article>
      <p className="thread__hint">{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : writable ? 'Reply to this message. No new topic needed.' : 'No replies yet.'}</p>
    </>
  );
}
