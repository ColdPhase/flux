import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ConversationMessage, Project, TaskDiscussion as Discussion, WorkspaceMember } from '@flux/contracts';
import { AgentIdentity, Button, Icon } from '../ui';
import { useComposerDraft, useComposerScope } from '../composer/draft';
import { ComposerFiles, MessageFiles } from '../composer/Files';
import { ConnectionLine, OutboxStatus, PendingFiles, PendingSource, SendAnnouncer } from '../composer/Outbox';
import { clock, day, when } from '../app/messageParts';
import { useProjectShell } from '../project/data';
import { getTaskDiscussion } from '../composer/api';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { agentDisplayName } from '../docs/format';

/**
 * A task's discussion in Details (UI116-3, #154): its root, which is the task's first genuine
 * contribution with its true author and time, and the way into it in the project conversation.
 * Before anyone has written, a person who can write starts it here. The structured draft and its
 * retry identity belong to the account/project/task, as in every place that writes to it.
 */
export function TaskDiscussionSection({ workId, number, project, members, me }: {
  workId: string; number?: number; project: Project; members: WorkspaceMember[]; me: { id: string; name: string };
}) {
  const owners = useAgentOwners(project);
  const headingId = useId();
  const fieldId = useId();
  const navigate = useNavigate();
  const writable = project.access !== 'viewer';
  // People the project shell already knows, for a reader who cannot list the workspace's members.
  const people = useProjectShell()?.people ?? null;
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const composer = useComposerDraft(me.id, project.id, `task:${workId}`);
  const captureScope = useComposerScope(composer.key);

  useEffect(() => {
    const controller = new AbortController();
    getTaskDiscussion(workId, { limit: 1, signal: controller.signal }).then((next) => { if (!controller.signal.aborted) setDiscussion(next); }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [workId, project.id, me.id, attempt]);

  const thread = discussion?.conversationId ? `/projects/${project.id}/conversations/${discussion.conversationId}` : null;
  const author = (message: ConversationMessage) => {
    if (message.authorId === null) return agentDisplayName(message.author);
    if (message.authorId === me.id) return `${me.name} · you`;
    return members.find((member) => member.userId === message.authorId)?.name
      ?? people?.find((person) => person.kind === 'human' && person.id === message.authorId)?.name ?? 'Member';
  };

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!writable || !discussion) return;
    // The message joins the task's queue and the field empties at once (#264); it shows below until stored.
    const outcome = composer.submit();
    if (!outcome) return;
    const active = captureScope();
    const result = await outcome;
    // Stored as it was sent: open it in the conversation. One that waited for the connection stays put.
    if (result.status === 'delivered' && !result.waited && active()) navigate(`/projects/${project.id}/conversations/${result.message.conversationId}#message-${result.message.id}`);
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
  };

  const root = discussion?.root ?? null;
  const replies = root ? Math.max(0, (discussion?.messages.at(-1)?.sequence ?? 1) - 1) : 0;
  return (
    <section className="details__sec wd-activity" aria-label="Discussion">
      <h4 id={headingId}>Activity</h4>
      {failed ? <p className="wd-error" role="alert">The discussion could not be loaded. <button type="button" className="wd-inline" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>Retry</button></p>
        : !discussion ? <p className="wd-muted" aria-busy="true">Loading…</p>
          : <>
            {root && thread ? <>
              <Link className="wd-discussion" to={thread}>
                <span className="wd-discussion__who">{root.author?.kind === 'agent' ? <AgentIdentity name={author(root)} owner={agentAuthorOwner(root.author, owners)} /> : <b>{author(root)}</b>} <time dateTime={root.createdAt} title={when(root.createdAt)}>{day(root.createdAt)} · {clock(root.createdAt)}</time></span>
                {root.body ? <span className="wd-discussion__body">{root.body}</span> : null}
                <span className="wd-discussion__more">{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'No replies yet'} · Open in Conversation<Icon name="chevron-right" size={14} /></span>
              </Link>
              <MessageFiles files={root.files} />
            </> : null}
            {composer.pending.length ? <ol className="wd-pending" aria-label="Messages you are sending">{composer.pending.map((item) => (
              <li key={item.id} id={`pending-${item.id}`} data-client-message-id={item.id} data-send-state={item.state} className={`wd-pending__item is-pending${item.state === 'failed' ? ' is-failed-send' : ''}`}>
                {item.body ? <span className="wd-pending__body">{item.body}</span> : null}
                <PendingFiles files={item.files} />
                <PendingSource item={item} />
                <OutboxStatus item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />
              </li>
            ))}</ol> : null}
            {writable ? <form className="wd-discussion-form" onSubmit={(event) => void send(event)}>
              <ConnectionLine />
              <p id={`${fieldId}-hint`} className="wd-discussion-form__hint">{root ? 'Goes to this task’s one discussion, also shown in Conversation and Agents.' : 'Nobody has written about this task yet. The first message starts its discussion in the project conversation.'}</p>
              <label className="ui-vh" htmlFor={fieldId}>{root ? 'Write to this task' : 'First message about this task'}</label>
              <textarea id={fieldId} aria-describedby={`${fieldId}-hint`} value={composer.draft.body} rows={3} maxLength={20000}
                placeholder={number ? `Write about #${number}…` : 'Write about this task…'} onChange={(event) => composer.setBody(event.target.value)} onKeyDown={onKeyDown} />
              <ComposerFiles state={composer} />
              <SendAnnouncer pending={composer.pending} />
              <div className="wd-actions"><Button type="submit" variant="secondary" icon="send" disabled={!composer.canSend}>{root ? 'Send to task' : 'Start the discussion'}</Button></div>
            </form> : !root ? <p className="wd-muted">Nobody has written about this task yet.</p> : null}
          </>}
    </section>
  );
}
