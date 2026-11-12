import type { ConversationMessage } from '@flux/contracts';
import { MessageObjects } from '../work/inline';
import type { MessageWorkPreview } from '../work/message-associations';
import { AgentAuthor, AuthorFace, DeletedSourceCitation, SourceCitation, MessageTime, ViaTag } from './messageParts';
import { MessageContent, type PhotoActions } from '../composer/Files';
import { LinkPreviews, MessageText } from './MessageText';
import { useProjectShell } from '../project/data';
import { QuestionCard, WhenNoQuestion } from '../agents/QuestionCard';

/** The message the thread answers, at its top: who said it, when, and what, with its cited source. */
export function ThreadRoot({ message, projectId, body, author, agentOwner = null, meId, writable, replies, firstDay = null, preview = null, onDenied, photo }: {
  message: ConversationMessage | null; projectId: string; body: string; author: string | null; agentOwner?: string | null; meId: string; writable: boolean; replies: number;
  /** The day of the first reply below: "3 replies · Today" is the one line between the root and its replies (#763 A5). */
  firstDay?: string | null;
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
            <AuthorFace kind={message.authorId === null ? 'agent' : 'human'} id={message.authorId} name={author} mine={mine} />
            <strong>{mine ? `${author} · you` : message.authorId === null ? <AgentAuthor message={message} owner={agentOwner} /> : author}</strong>
            <ViaTag via={message.via} />
          </div>
        ) : mine && message?.via ? <div className="thread__root-meta"><ViaTag via={message.via} /></div> : null}
        <MessageContent body={message?.body || !message ? <WhenNoQuestion projectId={projectId} messageId={message?.id ?? null}><div className={`message-body${message?.removedAt ? ' message-body--removed' : ''}`}><MessageText body={body} people={people} /></div></WhenNoQuestion> : null} files={message?.files} references={message?.references} context={message ? { author: author ?? undefined, at: message.createdAt, caption: message.body, ...photo } : undefined}>
          <LinkPreviews body={body} projectId={projectId} messageId={message?.id ?? null} />
          {message ? <MessageObjects message={message} projectId={projectId} preview={preview} /> : null}
          {message?.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={onDenied} /> : message?.sourceDeleted ? <DeletedSourceCitation /> : null}
        </MessageContent>
        {message ? <MessageTime at={message.createdAt} /> : null}
        {message ? <QuestionCard projectId={projectId} messageId={message.id} meId={meId} writable={writable} /> : null}
      </article>
      <p className="thread__hint">{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}${firstDay ? ` · ${firstDay}` : ''}` : writable ? 'Reply to this message. No new topic needed.' : 'No replies yet.'}</p>
    </>
  );
}
