import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import type { ConversationMessage } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { AttachButton, ComposerFiles, MessageContent } from '../composer/Files';
import { LinkPreviews, MessageText } from '../app/MessageText';
import { ConnectionLine, OutboxStatus, PendingFiles, PendingSource } from '../composer/Outbox';
import { AgentIdentity, AuthorFace, Button, duration } from '../ui';
import { agentDisplayName } from '../docs/format';
import { readAgentThread, type AgentThreadView } from './agentThread';
import { QuestionCard, WhenNoQuestion } from './QuestionCard';
import { agentAuthorOwner, useAgentOwners } from './owners';
import { useProjectShell } from '../project/data';
import './agents.css';

// A task's agents' thread, in the task's Details (F-036 AG-4, #857; F-038: a space has no Agents view): everything the agents of
// the task's people write to each other and to the people, and a composer for the people who
// may write. The thread is read by the space's people, so it says nothing about its audience (#871).

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function when(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? time.format(date) : dayTime.format(date);
}

function authorName(message: ConversationMessage, names: Map<string, string>) {
  if (message.authorId === null) return agentDisplayName(message.author);
  return names.get(message.authorId) ?? 'Someone';
}

/** Scrolls the thread's pane to its end, so the newest message sits above the composer. */
function scrollPaneToEnd(marker: HTMLElement | null) {
  const pane = marker?.closest<HTMLElement>('.agents-thread-scroll');
  if (pane) pane.scrollTop = pane.scrollHeight;
}

/** Whether the reader is at the end of the pane (within a few pixels), so new messages should follow. */
function paneAtEnd(marker: HTMLElement | null) {
  const pane = marker?.closest<HTMLElement>('.agents-thread-scroll');
  return !!pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
}

/** Messages by id in sequence order; a later copy of a message replaces the earlier one. */
function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * The thread's latest window with everything since `shown` (paged back, so a burst of replies leaves no gap), merged into what is
 * shown. Earlier messages already on the page stay.
 */
async function latestThread(workId: string, shown: AgentThreadView, signal: AbortSignal): Promise<AgentThreadView> {
  const latest = await readAgentThread(workId, { signal });
  const newestSeen = Math.max(0, ...shown.messages.map((message) => message.sequence));
  let incoming = latest.messages;
  let page = latest;
  while (newestSeen > 0 && page.messagePage.hasMoreBefore && (page.messages[0]?.sequence ?? 0) > newestSeen + 1) {
    const before = page.messages[0]!.sequence;
    page = await readAgentThread(workId, { signal, beforeSequence: before });
    if (!page.messages.length || page.messages[0]!.sequence >= before) throw new Error('Could not load the replies in between');
    incoming = mergeMessages(page.messages, incoming);
  }
  return { ...latest, messages: mergeMessages(shown.messages, incoming), messagePage: shown.messagePage };
}

/** The task a thread belongs to: its identity, number and title. */
export interface ThreadTask { id: string; number: number; title: string }

export function AgentsThread({ task, projectId, meId, names }: { task: ThreadTask; projectId: string; meId: string; names: Map<string, string> }) {
  const owners = useAgentOwners(useProjectShell()?.project);
  const [discussion, setDiscussion] = useState<AgentThreadView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  // What is on the page, for merging a refetch; every change goes through `show`.
  const shown = useRef<AgentThreadView | null>(null);
  const show = useCallback((update: (current: AgentThreadView | null) => AgentThreadView | null) => {
    shown.current = update(shown.current);
    setDiscussion(shown.current);
  }, []);
  const reload = useRef(() => { /* set while mounted */ });
  // Per account and task, kept across views and reloads like every other composer (#40).
  const composer = useComposerDraft(meId, projectId, `agent-thread:${task.id}`);
  const captureScope = useComposerScope(composer.key);
  const blocked = !discussion || accessLost || !(discussion.canWrite && discussion.postingAvailable);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // Keyed by task id: a different task mounts a fresh thread with its own draft. The first load and every later refetch share one
  // loop: one request at a time, and a change during it asks for one more pass, so nothing that arrives meanwhile is missed.
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    let again = false;
    const load = async () => {
      if (loading) { again = true; return; }
      loading = true;
      try {
        do {
          again = false;
          const before = shown.current;
          try {
            const next = before ? await latestThread(task.id, before, controller.signal) : await readAgentThread(task.id, { signal: controller.signal });
            if (controller.signal.aborted) return;
            // New messages follow a reader who is at the end; anyone reading earlier stays in place.
            const follow = !!before && paneAtEnd(end.current);
            flushSync(() => {
              show((current) => current ? { ...next, messages: mergeMessages(current.messages, next.messages), messagePage: current.messagePage } : next);
              setLoadError(null); setAccessLost(false);
            });
            if (follow) scrollPaneToEnd(end.current);
          } catch (cause) {
            if (controller.signal.aborted) return;
            const denied = cause instanceof ApiError && (cause.status === 401 || cause.status === 403 || cause.status === 404);
            if (!before) setLoadError(cause instanceof NetworkError ? 'Flux is unreachable.' : 'This task thread could not be loaded.');
            else if (denied) setAccessLost(true);
            // Keep one newer reload when an older transient read fails. Access loss never falls through into a retry.
            if (denied || !again) return;
          }
        } while (again && !controller.signal.aborted);
      } finally {
        loading = false;
      }
    };
    reload.current = () => { void load(); };
    void load();
    return () => { controller.abort(); reload.current = () => { /* unmounted */ }; };
  }, [task.id, show]);

  // Another person's or agent's contribution appears without a reload (#183 B1). Events carry only ids and kinds, and any change in
  // this project may touch this thread, so each one refetches; so does a resync after missed events.
  useStreamEvents(meId, (event) => {
    if (event.objectType === 'project' && event.objectId === projectId) reload.current();
  }, () => reload.current());
  // Without a live stream (a proxy that drops WebSockets), focus, a visible tab and a slow timer refetch.
  useEffect(() => {
    const onFocus = () => reload.current();
    const onVisible = () => { if (document.visibilityState === 'visible') reload.current(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(onVisible, 15_000);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(interval); };
  }, []);

  const messages = useMemo(() => {
    if (!discussion) return [];
    // A message confirmed from this task's queue is shown at once, in its queued place (#264).
    const sent = composer.sent.map((item) => item.message).filter((message) => !discussion.conversationId || message.conversationId === discussion.conversationId);
    return mergeMessages(discussion.messages, sent);
  }, [discussion, composer.sent]);
  const outbox = outboxView(messages, composer.pending, composer.sent, meId);

  // A thread opens at its newest message, like a conversation: once per load, after its messages are on the page, and not on later
  // updates. An empty thread keeps the pane at its top.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!discussion || opened.current) return;
    opened.current = true;
    if (messages.length) scrollPaneToEnd(end.current);
  }, [discussion, messages.length]);

  // The thread pages back by sequence. It reads the oldest message from what is shown now, so it can be repeated until a message is reached.
  const earlier = async (): Promise<boolean> => {
    const oldest = shown.current?.messages[0]?.sequence;
    if (!oldest) return false;
    const active = captureScope();
    try {
      const page = await readAgentThread(task.id, { beforeSequence: oldest });
      if (active()) show((current) => current ? { ...current, messages: mergeMessages(page.messages, current.messages), messagePage: page.messagePage } : current);
      return active();
    } catch { if (active()) setLoadError('Earlier messages could not be loaded.'); return false; }
  };

  // Opening a message of the thread (a link to it, #400 AC-4): the message comes into view and its highlight fades over
  // --dur-highlight, 600 ms at most (Spokój rule 6, #863). A message older than the page is reached by paging back, a bounded number of pages.
  const openMessage = async (messageId: string) => {
    for (let pages = 0; pages < 20; pages += 1) {
      const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.focus({ preventScroll: true });
        row.setAttribute('data-arrived', 'true');
        window.setTimeout(() => row.removeAttribute('data-arrived'), duration('--dur-highlight') || 600);
        return;
      }
      if (!shown.current?.messagePage.hasMoreBefore || !await earlier()) return;
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    }
  };
  // A link to a message in this thread (`#message-…`) lands on it once the thread has loaded.
  const arrivedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!discussion || accessLost) return;
    const target = window.location.hash.startsWith('#message-') ? window.location.hash.slice('#message-'.length) : null;
    if (!target || arrivedAt.current === `${task.id}:${target}`) return;
    arrivedAt.current = `${task.id}:${target}`;
    void openMessage(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per loaded thread and link
  }, [task.id, !!discussion, accessLost]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (blocked) return;
    // The message joins the end of the thread at once and the field empties (#264).
    const outcome = composer.submit(messages.at(-1)?.sequence ?? 0);
    if (!outcome) return;
    const active = captureScope();
    // The queued message is on the page (after this event's render) before the pane scrolls to it.
    requestAnimationFrame(() => { if (active()) scrollPaneToEnd(end.current); });
    box.current?.focus({ preventScroll: true });
    const result = await outcome;
    if (!active() || result.status !== 'delivered') return;
    const message = result.message;
    // The stored message takes its queued item's exact place, so the pane does not move again.
    flushSync(() => show((current) => current && !current.messages.some((item) => item.id === message.id)
      ? { ...current, conversationId: current.conversationId ?? message.conversationId, messageCount: (current.messageCount ?? 0) + 1, messages: [...current.messages, message] }
      : current));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  return (
    <section className="agents-thread" data-empty={discussion && !messages.length && !outbox.pending.length && !accessLost ? 'true' : undefined} aria-label={`Agents’ thread of ${task.title}`}>
      <p className="agents-thread__top">Agents’ thread</p>
      {loadError ? <p className="agents-thread__error" role="alert">{loadError} <button type="button" className="ui-link" onClick={() => reload.current()}>Try again</button></p> : null}
      {accessLost ? <p className="agents-thread__error" role="alert">You can no longer read this task. Your unsent text is kept on this device.</p> : null}
      {!discussion && !loadError ? <p className="agents-thread__empty">Loading…</p> : null}
      {discussion && !accessLost && !messages.length && !outbox.pending.length ? <p className="agents-thread__empty">No one has written to the agents about this task yet. The first message starts its thread.</p> : null}
      {accessLost ? null : <ol className="agents-thread__list" aria-live="polite">
        {[...messages.map((message) => {
          const own = message.authorId === meId;
          const agent = message.authorId === null;
          const name = authorName(message, names);
          return (
            // A confirmed message keeps its queued item, so nothing moves or is announced twice (#264).
            <li key={outbox.keyOf(message.id)} data-message-id={message.id} tabIndex={-1} className={`agents-msg${own ? ' agents-msg--own' : ''}${agent ? ' agents-msg--agent' : ''}`}>
              <AuthorFace kind={agent ? 'agent' : 'human'} name={name} mine={own} />
              <span className="agents-msg__meta">
                {agent ? <AgentIdentity name={name} owner={message.author.kind === 'agent' ? agentAuthorOwner(message.author, owners) : undefined} icon={false} /> : <b>{name}{own ? ' · you' : ''}</b>}
                <time dateTime={message.createdAt}>{when(message.createdAt)}</time>
                {message.contribution ? <span className="agents-msg__kind"> · {message.contribution.kind}</span> : null}
              </span>
              <MessageContent body={message.body ? <WhenNoQuestion projectId={projectId} messageId={message.id}><div className="message-body agents-msg__body"><MessageText body={message.body} /></div></WhenNoQuestion> : null} files={message.files} references={message.references} context={{ author: name, at: message.createdAt, caption: message.body, onReply: blocked ? undefined : () => box.current?.focus() }}>
                <LinkPreviews body={message.body} projectId={projectId} messageId={message.id} />
              </MessageContent>
              <QuestionCard projectId={projectId} messageId={message.id} meId={meId} writable />
            </li>
          );
        }), ...outbox.pending.map((item) => (
          <li key={`pending-${item.id}`} id={`pending-${item.id}`} data-client-message-id={item.id} data-send-state={item.state}
            className={`agents-msg agents-msg--own is-pending${item.state === 'failed' ? ' is-failed-send' : ''}`}>
            <AuthorFace kind="human" name={names.get(meId) ?? 'Someone'} mine />
            {/* "Sending…" stands where the stored message's time will be, so it takes that message's exact space. */}
            <span className="agents-msg__meta"><b>{names.get(meId) ?? 'Someone'} · you</b>{item.state === 'sending' || item.state === 'uploading' ? <OutboxStatus inline item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} /> : null}</span>
            <PendingFiles body={item.body ? <div className="message-body agents-msg__body">{item.body}</div> : null} files={item.files} send={{ state: item.state, onRetry: () => composer.retry(item.id) }} />
            <PendingSource item={item} />
            {item.state === 'sending' || item.state === 'uploading' ? null : <OutboxStatus item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />}
          </li>
        ))]}
      </ol>}
      {discussion?.messagePage.hasMoreBefore && !accessLost ? <p className="agents-thread__empty"><button type="button" className="ui-link" onClick={() => void earlier()}>Show earlier messages</button></p> : null}
      <div ref={end} />
      <form className="agents-composer" onSubmit={(event) => { void send(event); }}>
        <ConnectionLine />
        <label className="ui-vh" htmlFor={`agents-draft-${task.id}`}>Write to the agents</label>
        <textarea id={`agents-draft-${task.id}`} ref={box} value={composer.draft.body} rows={2}
          placeholder="Write to the agents…" disabled={blocked}
          onChange={(event) => { if (!blocked) composer.setBody(event.target.value); }} onKeyDown={onKeyDown} />
        <ComposerFiles state={composer} disabled={blocked} attach="none" />
        <div className="agents-composer__row">
          <AttachButton state={composer} disabled={blocked} />
          <span className="agents-composer__hint">Goes to the agents’ thread<span className="composer__keys"> · Enter sends, Shift+Enter new line</span></span>
          <Button type="submit" variant="soft" icon="send" disabled={!composer.canSend || blocked} aria-label="Send to the agents">Send</Button>
        </div>
      </form>
    </section>
  );
}
