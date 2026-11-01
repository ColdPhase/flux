import type { ConversationMessage, Project, ProjectPerson } from '@flux/contracts';
import type { PendingSend } from '../composer/draft';
import { MessageContent } from '../composer/Files';
import { LinkPreviews, MessageText } from '../app/MessageText';
import { AgentAuthor, AuthorFace, ContributionMark, MessageTime, SourceCitation, SourceTag, pendingMessageRow } from '../app/messageParts';
import { cite as citeMessage, messageCite } from '../app/citeBus';
import { MessageObjects, useCreateWorkFromMessage } from '../work/inline';
import { MessageActions, useTouchActions } from '../work/messageActions';
import type { MessageWorkPreview } from '../work/message-associations';
import { useAddToMap } from '../project/addToMap';
import { agentAuthorOwner, type AgentOwners } from '../agents/owners';
import { QuestionCard, WhenNoQuestion } from '../agents/QuestionCard';
import { RefLink } from '../place/origin';

/** One reply of the open thread: the message with its actions (hover, swipe, long press) and what was made from it. */
type ThreadReplyProps = {
  continued?: boolean; groupLast?: boolean;
  message: ConversationMessage; mine: boolean; meId: string; arrived: boolean; name: string; project: Project; owners: AgentOwners; people: ProjectPerson[] | null;
  preview: MessageWorkPreview | null; makeWork: ReturnType<typeof useCreateWorkFromMessage>; writable: boolean;
  /** Another person's reply is watched for viewing receipts; `seenBy` names who observed every reply of this author run. */
  observed?: boolean; seenBy?: readonly string[];
  onOpenResult: (resultId: string) => void; onDenied: (cause: unknown) => void;
};
type QueuedReplyProps = { continued?: boolean; pending: PendingSend; name: string; onRetry: () => void; onRemove: () => void };

/**
 * One reply of the open thread, or the person's queued reply that becomes it: one component and one list
 * item for both, so the stored reply reuses the queued one's item (#264). The reply has its actions (hover,
 * swipe, long press) and what was made from it.
 */
export function ThreadReply(props: ThreadReplyProps | QueuedReplyProps) {
  const stored = 'pending' in props ? null : props;
  const message = stored?.message;
  const mapDraft = useAddToMap(stored?.project ?? null);
  const actions = stored && message ? {
    projectId: stored.project.id, message, writable: stored.writable, onCreateWork: () => void stored.makeWork.create(message),
    onReply: () => document.getElementById('thread-composer')?.focus(),
    onCite: () => citeMessage('thread', messageCite(message, stored.name)),
    onAddToMap: () => mapDraft({ messageId: message.id, body: message.body }),
  } : null;
  const touch = useTouchActions(actions);
  if (!stored || !message || !actions) {
    const queued = props as QueuedReplyProps;
    return pendingMessageRow({ place: 'thread', continued: queued.continued, keyed: false, item: queued.pending, name: queued.name, onRetry: queued.onRetry, onRemove: queued.onRemove });
  }
  const { mine, meId, arrived, name, project, owners, people, preview, writable, onOpenResult, onDenied } = stored;
  return (
    <li {...touch.props} id={`message-${message.id}`} data-message-id={message.id} {...(stored.observed ? { 'data-observe-id': message.id } : {})} aria-label={mine ? 'Your message' : `${name}’s message`} tabIndex={-1} className={`project-convo__message${mine ? ' is-mine' : ''}${arrived ? ' is-arrived' : ''}${stored.continued ? ' is-continued' : ''} ${touch.props.className}`}>
      <SourceTag messageId={message.id} />
      {!mine && !stored.continued ? <AuthorFace kind={message.authorId === null ? 'agent' : 'human'} name={name} mine={mine} /> : null}
      {!mine && !stored.continued ? <div className="project-convo__message-meta"><strong>{mine ? `${name} · you` : message.authorId === null ? <AgentAuthor message={message} owner={agentAuthorOwner(message.author, owners)} /> : <RefLink className="project-convo__person" to={`/dm/new?workspace=${project.workspaceId}&with=${message.authorId}`} title={`Message ${name} directly`}>{name}</RefLink>}</strong></div> : null}
      <MessageContent body={message.body ? <WhenNoQuestion projectId={project.id} messageId={message.id}><div className={`message-body${message.removedAt ? ' message-body--removed' : ''}`}><MessageText body={message.body} people={people} /></div></WhenNoQuestion> : null} files={message.files} references={message.references} context={{ author: name, at: message.createdAt, caption: message.body, place: project.name, onReply: writable ? actions.onReply : undefined, onCreateTask: writable ? actions.onCreateWork : undefined }}>
        <LinkPreviews body={message.body} projectId={project.id} messageId={message.id} />
        <MessageObjects message={message} projectId={project.id} preview={preview} />
        {message.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={onDenied} /> : null}
      </MessageContent>
      <QuestionCard projectId={project.id} messageId={message.id} meId={meId} writable={writable} />
      {message.contribution ? <ContributionMark contribution={message.contribution} onOpenResult={onOpenResult} /> : null}
      {stored.groupLast !== false ? <MessageTime at={message.createdAt} seenBy={stored.seenBy} /> : null}
      <MessageActions {...actions} />
      {touch.node}
    </li>
  );
}
