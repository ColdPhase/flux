import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ConversationMessage, Project, TaskDiscussion as Discussion, WorkspaceMember } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button, Icon } from '../ui';
import { useDraft } from '../app/drafts';
import { clock, day, when } from '../app/messageParts';
import { useProjectShell } from '../project/data';
import { contributeToTask, getTaskDiscussion } from './api';

interface Pending { body: string; id: string }
function parsePending(text: string): Pending | null {
  try {
    const value = JSON.parse(text) as Partial<Pending> | null;
    return value && typeof value.body === 'string' && typeof value.id === 'string' ? { body: value.body, id: value.id } : null;
  } catch { return null; }
}

/**
 * A task's discussion in Details (UI116-3, #154): its root, which is the task's first genuine
 * contribution with its true author and time, and the way into it in the project conversation.
 * Before anyone has written, a person who can write starts it here. The draft and its retry identity
 * belong to the task (`task:<id>` and `task:<id>:pending`), as in every place that writes to it.
 */
export function TaskDiscussionSection({ workId, project, members, me }: {
  workId: string; project: Project; members: WorkspaceMember[]; me: { id: string; name: string };
}) {
  const headingId = useId();
  const fieldId = useId();
  const navigate = useNavigate();
  const writable = project.access !== 'viewer';
  // People the project shell already knows, for a reader who cannot list the workspace's members.
  const people = useProjectShell()?.people ?? null;
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const draft = useDraft(me.id, `task:${workId}`);
  const pendingStore = useDraft(me.id, `task:${workId}:pending`);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getTaskDiscussion(workId, 1, controller.signal).then(setDiscussion).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [workId, attempt]);

  const thread = discussion?.conversationId ? `/projects/${project.id}/conversations/${discussion.conversationId}` : null;
  const author = (message: ConversationMessage) => {
    if (message.authorId === null) return `${message.author.name ?? 'Agent'} · agent`;
    if (message.authorId === me.id) return `${me.name} · you`;
    return members.find((member) => member.userId === message.authorId)?.name
      ?? people?.find((person) => person.kind === 'human' && person.id === message.authorId)?.name ?? 'Member';
  };

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.text.trim();
    if (!body || sending) return;
    // One client message id per text, kept before sending: a retry after a lost answer or a reload
    // reuses it, so the server stores the contribution once.
    const stored = parsePending(pendingStore.text);
    const pending = stored && stored.body === body ? stored : { body, id: crypto.randomUUID() };
    pendingStore.setText(JSON.stringify(pending));
    setSending(true); setSendError('');
    try {
      const message = await contributeToTask(workId, { body, clientMessageId: pending.id, kind: 'text' });
      pendingStore.clear();
      draft.clear();
      navigate(`/projects/${project.id}/conversations/${message.conversationId}#message-${message.id}`);
    } catch (cause) {
      setSendError(cause instanceof ApiError && (cause.status === 403 || cause.status === 404) ? 'Not sent: you can no longer write to this task.'
        : cause instanceof NetworkError ? 'Not sent: Flux is unreachable. Your text is kept; send again.' : 'Not sent. Your text is kept; send again.');
    } finally { setSending(false); }
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
          : root && thread ? (
            <Link className="wd-discussion" to={thread}>
              <span className="wd-discussion__who"><b>{author(root)}</b> <time dateTime={root.createdAt} title={when(root.createdAt)}>{day(root.createdAt)} · {clock(root.createdAt)}</time></span>
              <span className="wd-discussion__body">{root.body}</span>
              <span className="wd-discussion__more">{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'No replies yet'} · Open in Conversation<Icon name="chevron-right" size={14} /></span>
            </Link>
          ) : writable ? (
            <form className="wd-discussion-form" onSubmit={(event) => void send(event)}>
              <p id={`${fieldId}-hint`} className="wd-discussion-form__hint">Nobody has written about this task yet. The first message starts its discussion in the project conversation.</p>
              <label className="ui-vh" htmlFor={fieldId}>First message about this task</label>
              <textarea id={fieldId} aria-describedby={`${fieldId}-hint`} value={draft.text} rows={3} maxLength={20000} readOnly={sending} aria-busy={sending || undefined}
                placeholder="Write about this task…" onChange={(event) => { draft.setText(event.target.value); setSendError(''); }} onKeyDown={onKeyDown} />
              {draft.storage === 'visit' ? <p className="wd-muted">This browser does not keep drafts; it stays only while this page is open.</p> : null}
              {sendError ? <p className="wd-error" role="alert">{sendError}</p> : null}
              <div className="wd-actions"><Button type="submit" variant="secondary" icon="send" busy={sending} disabled={!draft.text.trim()}>Start the discussion</Button></div>
            </form>
          ) : <p className="wd-muted">Nobody has written about this task yet.</p>}
    </section>
  );
}
