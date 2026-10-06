import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ConversationMessage, Project, TaskDiscussion as Discussion, WorkspaceMember } from '@flux/contracts';
import { Button, Icon } from '../ui';
import { useComposerDraft, useComposerScope } from '../composer/draft';
import { ComposerFiles, MessageFiles } from '../composer/Files';
import { clock, day, when } from '../app/messageParts';
import { useProjectShell } from '../project/data';
import { contributeToTask, getTaskDiscussion } from '../composer/api';
import { agentAuthorLabel } from '../docs/format';

/**
 * A task's discussion in Details (UI116-3, #154): its root, which is the task's first genuine
 * contribution with its true author and time, and the way into it in the project conversation.
 * Before anyone has written, a person who can write starts it here. The structured draft and its
 * retry identity belong to the account/project/task, as in every place that writes to it.
 */
export function TaskDiscussionSection({ workId, project, members, me, readOnly = false }: {
  workId: string; project: Project; members: WorkspaceMember[]; me: { id: string; name: string };
  /** A task whose creation was undone (#238) keeps its discussion as read-only history. */
  readOnly?: boolean;
}) {
  const headingId = useId();
  const fieldId = useId();
  const navigate = useNavigate();
  const writable = project.access !== 'viewer' && !readOnly;
  // People the project shell already knows, for a reader who cannot list the workspace's members.
  const people = useProjectShell()?.people ?? null;
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const composer = useComposerDraft(me.id, project.id, `task:${workId}`);
  const captureScope = useComposerScope(composer.key);
  const sending = composer.sending;

  useEffect(() => {
    const controller = new AbortController();
    getTaskDiscussion(workId, { limit: 1, signal: controller.signal }).then((next) => { if (!controller.signal.aborted) setDiscussion(next); }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [workId, project.id, me.id, attempt]);

  const thread = discussion?.conversationId ? `/projects/${project.id}/conversations/${discussion.conversationId}` : null;
  const author = (message: ConversationMessage) => {
    if (message.authorId === null) return agentAuthorLabel(message.author);
    if (message.authorId === me.id) return `${me.name} · you`;
    return members.find((member) => member.userId === message.authorId)?.name
      ?? people?.find((person) => person.kind === 'human' && person.id === message.authorId)?.name ?? 'Member';
  };

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!writable || !discussion) return;
    const command = composer.begin();
    if (!command) return;
    const active = captureScope();
    try {
      const message = await contributeToTask(workId, { ...command, kind: 'text' });
      composer.finish(command.clientMessageId);
      if (active()) navigate(`/projects/${project.id}/conversations/${message.conversationId}#message-${message.id}`);
    } catch (cause) { composer.finish(command.clientMessageId, cause); }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
  };

  const root = discussion?.root ?? null;
  const replies = root ? Math.max(0, (discussion?.messages.at(-1)?.sequence ?? 1) - 1) : 0;
  return (
    <section className="details__sec" aria-labelledby={headingId}>
      <h4 id={headingId}>Discussion</h4>
      {failed ? <p className="wd-error" role="alert">The discussion could not be loaded. <button type="button" className="wd-inline" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>Retry</button></p>
        : !discussion ? <p className="wd-muted" aria-busy="true">Loading…</p>
          : <>
            {root && thread ? <>
              <Link className="wd-discussion" to={thread}>
                <span className="wd-discussion__who"><b>{author(root)}</b> <time dateTime={root.createdAt} title={when(root.createdAt)}>{day(root.createdAt)} · {clock(root.createdAt)}</time></span>
                {root.body ? <span className="wd-discussion__body">{root.body}</span> : null}
                <span className="wd-discussion__more">{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'No replies yet'} · Open in Conversation<Icon name="chevron-right" size={14} /></span>
              </Link>
              <MessageFiles files={root.files} />
            </> : null}
            {writable ? <form className="wd-discussion-form" onSubmit={(event) => void send(event)}>
              <p id={`${fieldId}-hint`} className="wd-discussion-form__hint">{root ? 'Goes to this task’s one discussion, also shown in Conversation and Agents.' : 'Nobody has written about this task yet. The first message starts its discussion in the project conversation.'}</p>
              <label className="ui-vh" htmlFor={fieldId}>{root ? 'Write to this task' : 'First message about this task'}</label>
              <textarea id={fieldId} aria-describedby={`${fieldId}-hint`} value={composer.draft.body} rows={3} maxLength={20000} readOnly={sending} aria-busy={sending || undefined}
                placeholder="Write about this task…" onChange={(event) => composer.setBody(event.target.value)} onKeyDown={onKeyDown} />
              <ComposerFiles state={composer} />
              <div className="wd-actions"><Button type="submit" variant="secondary" icon="send" busy={sending} disabled={!composer.canSend}>{root ? 'Send to task' : 'Start the discussion'}</Button></div>
            </form> : !root ? <p className="wd-muted">{readOnly ? 'Creation was undone. This history is read-only; your unsent draft is kept.' : 'Nobody has written about this task yet.'}</p> : null}
          </>}
    </section>
  );
}
