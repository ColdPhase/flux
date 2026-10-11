import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation } from 'react-router';
import type { ConversationMessage, Project, TaskAgentThread, WorkspaceMember } from '@flux/contracts';
import { AgentIdentity, AuthorFace, Button, Icon } from '../ui';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { ComposerFiles, MessageFiles } from '../composer/Files';
import { ConnectionLine, OutboxStatus, PendingFiles, PendingSource, SendAnnouncer } from '../composer/Outbox';
import { getTaskAgentThread } from '../composer/api';
import { SourceCitation, clock, day, when } from '../app/messageParts';
import { useProjectShell } from '../project/data';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { agentDisplayName } from '../docs/format';
import { useStreamEvents } from '../api/stream';

/** Opening/reading a thread is a read. The first accepted human post creates it. */
export function AgentThreadEntry({ workId, revision, onOpen }: { workId: string; revision: string; onOpen: () => void }) {
  const [thread, setThread] = useState<TaskAgentThread | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getTaskAgentThread(workId, { limit: 1, signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) { setThread(next); setFailed(false); }
    }).catch(() => { if (!controller.signal.aborted) { setThread(null); setFailed(true); } });
    return () => controller.abort();
  }, [workId, revision, attempt]);
  return <section className="details__sec">
    {failed ? <p className="wd-error" role="alert">The agents’ thread could not be loaded. <button className="wd-inline" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>
      : <button type="button" className="wd-link at-entry" data-agent-thread-entry={workId} onClick={onOpen}>
        <span>Agents’ thread · {thread ? `${thread.messageCount} ${thread.messageCount === 1 ? 'message' : 'messages'}` : 'Loading…'}</span><Icon name="chevron-right" size={14} />
      </button>}
  </section>;
}

/** One task thread replaces the contents of the existing Details panel/sheet. */
export function AgentThreadPanel({ workId, project, members, me, readOnly, revision, onBack }: {
  workId: string; project: Project; members: WorkspaceMember[]; me: { id: string; name: string };
  readOnly: boolean; revision: string; onBack: () => void;
}) {
  const owners = useAgentOwners(project);
  const people = useProjectShell()?.people ?? null;
  const location = useLocation();
  const fieldId = useId();
  const headingId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const composer = useComposerDraft(me.id, project.id, `agent-thread:${workId}`);
  const captureScope = useComposerScope(composer.key);
  const [thread, setThread] = useState<TaskAgentThread | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const focused = useRef('');
  const target = /^#message-([0-9a-f-]{36})$/i.exec(location.hash)?.[1] ?? null;
  const writable = !!thread?.canWrite && thread.postingAvailable && project.access !== 'viewer' && !readOnly && !failed;
  const outbox = outboxView(messages, composer.pending, composer.sent, me.id);

  useStreamEvents(me.id, (event) => {
    if (event.kind === 'project.agent_thread_message_sent.v1' && event.objectId === project.id) { setBusy(true); setAttempt((value) => value + 1); }
  }, () => { setBusy(true); setAttempt((value) => value + 1); });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const next = await getTaskAgentThread(workId, { limit: 50, signal: controller.signal });
      let found = next.conversation?.messages ?? [];
      let before = next.conversation?.messagePage.nextBeforeSequence ?? null;
      // Search and addressed notices arrive at the actual message, including an older page.
      while (target && !found.some((message) => message.id === target) && before !== null) {
        const older = await getTaskAgentThread(workId, { limit: 50, beforeSequence: before, signal: controller.signal });
        found = [...older.conversation?.messages ?? [], ...found];
        const previous = before;
        before = older.conversation?.messagePage.nextBeforeSequence ?? null;
        if (before !== null && before >= previous) throw new Error('The thread cursor did not advance.');
      }
      if (controller.signal.aborted) return;
      setThread(next); setMessages(found); setCursor(before); setFailed(false); setOlderFailed(false);
    })().catch(() => {
      if (!controller.signal.aborted) { setThread(null); setMessages([]); setCursor(null); setFailed(true); }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [workId, project.id, me.id, revision, attempt, target]);

  useEffect(() => {
    if (!thread || busy) return;
    const identity = target ?? 'heading';
    if (focused.current === identity) return;
    const element = target ? panel.current?.querySelector<HTMLElement>(`[data-message-id="${target}"]`) : panel.current?.querySelector<HTMLElement>('h3');
    if (!element) return;
    element.focus({ preventScroll: true });
    if (target) element.scrollIntoView({ block: 'center' });
    focused.current = identity;
  }, [target, thread, busy]);

  async function older() {
    if (cursor === null || busy) return;
    const active = captureScope();
    setBusy(true); setOlderFailed(false);
    try {
      const next = await getTaskAgentThread(workId, { limit: 50, beforeSequence: cursor });
      if (!active()) return;
      setThread(next); setMessages((current) => [...next.conversation?.messages ?? [], ...current]);
      setCursor(next.conversation?.messagePage.nextBeforeSequence ?? null);
    } catch { if (active()) { setThread(null); setMessages([]); setCursor(null); setFailed(true); setOlderFailed(true); } }
    finally { if (active()) setBusy(false); }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!writable) return;
    const outcome = composer.submit(messages.at(-1)?.sequence ?? 0);
    if (!outcome) return;
    const active = captureScope();
    const result = await outcome;
    if (active() && result.status === 'delivered') { setBusy(true); setAttempt((value) => value + 1); }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  const author = (message: ConversationMessage) => message.authorId === null ? agentDisplayName(message.author)
    : message.authorId === me.id ? me.name : members.find((member) => member.userId === message.authorId)?.name
      ?? people?.find((person) => person.kind === 'human' && person.id === message.authorId)?.name ?? 'Member';

  return <div ref={panel} className="details wd at-panel" data-agent-thread-task={workId} aria-labelledby={headingId}>
    <button type="button" className="wd-inline at-back" onClick={onBack}><Icon name="chevron-left" size={14} />Back to task</button>
    <p className="details__eyebrow">Agents’ thread · {thread ? `#${thread.task.number}` : 'Task'}</p>
    <h3 id={headingId} className="details__title" tabIndex={-1}>{thread?.task.title ?? 'Agents’ thread'}</h3>
    <p className="details__lead at-audience">Everyone with access to {project.name} can read this thread. Progress stays here.</p>
    {failed ? <p className="wd-error" role="alert">{olderFailed ? 'Older messages could not be loaded.' : 'This thread could not be loaded.'} Your draft is kept. <button type="button" className="wd-inline" onClick={() => setAttempt((value) => value + 1)}>Refresh thread</button></p>
      : !thread ? <p className="wd-muted" role="status">Loading thread…</p> : <>
        <div className="at-meta"><span>{thread.messageCount} {thread.messageCount === 1 ? 'message' : 'messages'}</span><button type="button" className="wd-inline" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>Refresh</button></div>
        {cursor !== null ? <Button variant="secondary" busy={busy} onClick={() => void older()}>Earlier messages</Button> : null}
        {messages.length ? <ol className="at-messages" aria-label="Agents’ thread messages">{messages.map((message) => <li key={outbox.keyOf(message.id)}>
          <article className="at-message" id={`message-${message.id}`} data-message-id={message.id} tabIndex={-1} aria-label={`Message from ${author(message)}`}>
            <div className="at-message__meta"><AuthorFace kind={message.authorId === null ? 'agent' : 'human'} name={author(message)} mine={message.authorId === me.id} />
              <strong>{message.authorId === null ? <AgentIdentity name={author(message)} owner={agentAuthorOwner(message.author, owners)} icon={false} /> : `${author(message)}${message.authorId === me.id ? ' · you' : ''}`}</strong>
              <time dateTime={message.createdAt} title={when(message.createdAt)}>{day(message.createdAt)} · {clock(message.createdAt)}</time></div>
            {message.body ? <p className="at-message__body">{message.body}</p> : null}
            <MessageFiles files={message.files} />
            {message.source ? <SourceCitation {...message.source} onDenied={() => { setThread(null); setMessages([]); setFailed(true); }} /> : null}
          </article>
        </li>)}</ol> : <p className="wd-muted at-empty">No messages yet. The first post starts this task’s agents’ thread.</p>}
        {target && !messages.some((message) => message.id === target) ? <p className="wd-muted" role="status">That message is no longer available in this thread.</p> : null}
      </>}
    {outbox.pending.length ? <ol className="wd-pending" aria-label={writable ? 'Messages you are sending' : 'Pending messages kept'}>{outbox.pending.map((item) => <li key={item.id} data-client-message-id={item.id} data-send-state={item.state} className={`wd-pending__item is-pending${item.state === 'failed' ? ' is-failed-send' : ''}`}>
      {item.body ? <span className="wd-pending__body">{item.body}</span> : null}<PendingFiles files={item.files} /><PendingSource item={item} />
      {writable ? <OutboxStatus item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} /> : <p className="wd-muted" role="status">Send not confirmed. Your message is kept.</p>}
    </li>)}</ol> : null}
    {writable ? <form className="wd-discussion-form at-composer" onSubmit={(event) => void send(event)}>
      <ConnectionLine />
      <label className="ui-vh" htmlFor={fieldId}>Write in the agents’ thread</label>
      <textarea id={fieldId} value={composer.draft.body} rows={3} maxLength={100000} placeholder="Write in this thread…" onChange={(event) => composer.setBody(event.target.value)} onKeyDown={onKeyDown} />
      <ComposerFiles state={composer} /><SendAnnouncer pending={composer.pending} />
      <div className="wd-actions"><Button type="submit" variant="secondary" icon="send" disabled={!composer.canSend}>Send</Button></div>
    </form> : thread ? <p className="wd-muted" role="status">{readOnly ? 'Creation was undone. This thread is read-only; your draft is kept.' : 'You can read this thread. Posting requires project write access.'}</p> : null}
  </div>;
}
