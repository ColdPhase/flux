import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Link, useLoaderData, useLocation, useNavigation, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import { AGENT_SCOPE_PLAIN } from '@flux/contracts';
import type { AgentOperation, AgentQuestion, AgentScope, AgentStop, ConversationMessage, ProjectAgentConnection, ProjectAgentRequest, ProjectAgents as ProjectAgentsData, TaskDiscussion, WorkRowProjection, WorkStatus } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { projectAiBlocked, useShellData } from '../app/data';
import { AiOffState, isAiBlocked, useWorkspaceAi } from '../ai/workspaceAi';
import { useShellActions } from '../app/shellContext';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { AttachButton, ComposerFiles, MessageContent } from '../composer/Files';
import { LinkPreviews, MessageText } from '../app/MessageText';
import { ConnectionLine, OutboxStatus, PendingFiles, PendingSource } from '../composer/Outbox';
import { getTaskDiscussion } from '../composer/api';
import { readAgentThread, type AgentThreadView } from './agentThread';
import { useProjectShell } from '../project/data';
import { AgentIdentity, AuthorFace, Button, Icon, Kreska, PanelMeta, StatusGlyph, agentHue, useMediaQuery, type KreskaExpression } from '../ui';
import { OwnedPanelContent, useOwnedPanel } from '../app/ownedPanel';
import { STATUS_LABEL } from '../work/format';
import { useNativeOwn, useWorkChoices } from '../work/useDetailReads';
import { agentDisplayName } from '../docs/format';
import { getProjectAgents } from './api';
import { HandOffDialog, type HandOffTask } from './HandOff';
import { useAgentStops, useStopAgent } from './stop';
import { QuestionCard, WhenNoQuestion } from './QuestionCard';
import { RequestCards } from './RequestCards';
import { ReviewRule } from './ReviewRule';
import { useProjectQuestions, useQuestionList } from './questions';
import { useLatestAgentLine } from './latest';
import { agentAuthorOwner, useAgentOwners } from './owners';
import { ProjectPolicy } from './ProjectPolicy';
import { WORK_ROLE, agentEntries, connectionState, currentWorkLine, firstName, isAgentWorking, mayDo, shortOwner, tasksHeldBy, teammateOf, type AgentEntry } from './roster';
import { useSessionClock } from './useSessionClock';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import './agents.css';
import { useCreateWorkFromMessage } from '../work/inline';
import { RefLink, useOriginPanelBack } from '../place/origin';

/** The drag data type of a task dragged onto an agent (computer only; the button does the same by keyboard and touch). */
const TASK_DRAG = 'application/x-flux-task';

/**
 * Agents (F-026 P9): one list, each agent with its owner and what it is doing now, then Requests, Policy and
 * "Connect your own agent", and one primary button, "Hand off a task". A view of the project's existing work,
 * not a second backlog or chat: each person's connections are separate entries, so Hubert's Codex and Hubert's
 * Claude Code are two rows. A task's thread (`?task=`) is its one canonical discussion.
 */
export async function projectAgentsLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectAgentsData | null> {
  // F-029 (#614): in a workspace whose AI is off there is nothing to read; the view says so and launches nothing.
  if (await projectAiBlocked(params.projectId)) return null;
  return getProjectAgents(params.projectId!, request.signal).catch((error: unknown) => (isAiBlocked(error) ? null : Promise.reject(error)));
}

const OPERATION_LABEL: Record<AgentOperation, string> = {
  'work.create': 'created a task', 'work.update': 'updated a task', 'work.creation.revert': 'undid a task creation', 'result.record': 'recorded a result',
  'decision.propose': 'proposed a decision', 'map.create': 'created a map', 'map.rename': 'renamed a map',
  'map.thought.create': 'added a thought', 'map.thought.update': 'edited a thought', 'map.thought.delete': 'removed a thought',
  'map.positions.update': 'arranged the map', 'map.link.create': 'linked thoughts', 'map.link.delete': 'unlinked thoughts',
  'doc.create': 'created a doc', 'doc.update': 'edited a doc',
  'conversation.create': 'started a conversation', 'conversation.reply': 'replied in a conversation',
  'cowork.claim': 'took a task', 'cowork.renew': 'is still on a task', 'cowork.release': 'released a task', 'cowork.request': 'asked for help',
  'cowork.request.claim': 'picked up a request', 'cowork.request.respond': 'answered a request',
  'cowork.unit.create': 'set up work on a task', 'cowork.unit.complete': 'finished its work on a task',
  'cowork.unit.transfer': 'handed work on a task to another agent',
  'cowork.unit.decline': 'handed work on a task back to the agent that sent it',
};

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function when(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? time.format(date) : dayTime.format(date);
}

/** A session past its end is offline now, even before the next read says so. */
function shownState(connection: ProjectAgentConnection, now: number): ProjectAgentConnection['state'] {
  return connectionState(connection, now);
}

/** What the owner let a connection do, in plain words: "Can read projects · Can suggest changes" (#548). */
function permissionsLine(scopes: readonly AgentScope[]): string {
  return scopes.length ? scopes.map((scope) => `Can ${AGENT_SCOPE_PLAIN[scope]}`).join(' · ') : 'Has no permissions';
}

/** What Flux can prove about a connection; a configured or offline one never looks busy. */
function stateLine(connection: ProjectAgentConnection, now: number): string {
  const state = shownState(connection, now);
  if (state === 'session_open') {
    const last = connection.lastActivity;
    return last ? `Idle · last ${OPERATION_LABEL[last.operation]} · ${when(last.at)}` : `Idle · connected since ${when(connection.session!.startedAt)}`;
  }
  if (state === 'offline') return connection.lastActivity ? `Offline · last seen ${when(connection.lastActivity.at)}` : 'Offline';
  if (connection.state === 'unavailable') return connection.own ? 'Can’t act here now: check this agent’s project access' : 'Can’t act here now';
  return connection.own ? 'Not signed in from your client yet' : 'Not signed in yet';
}

/** A session proves connection, and lastActivity is completed history. Neither proves current work. */
function connectionExpression(connection: ProjectAgentConnection, now: number): KreskaExpression {
  const state = shownState(connection, now);
  if (connection.state === 'unavailable') return 'worried';
  if (state !== 'session_open') return 'asleep';
  return 'idle';
}

const REQUEST_KIND: Record<ProjectAgentRequest['kind'], string> = { help: 'Help', review: 'Review', fix: 'Fix', handoff: 'Handoff' };
const REQUEST_STATE: Record<ProjectAgentRequest['state'], string> = {
  queued: 'waiting for its next step', deferred: 'deferred until its next step', claimed: 'being handled',
};

/** A request addressed here: who asked, about which task, and what it waits for (the request's own reason, if any). */
function requestLine(request: ProjectAgentRequest) {
  const reason = request.reason ? ` — ${request.reason}` : '';
  return `${REQUEST_KIND[request.kind]} request from ${request.sender.name} (${request.sender.ownerName}) about “${request.taskTitle}”: ${REQUEST_STATE[request.state]}${reason}`;
}

function authorName(message: ConversationMessage, names: Map<string, string>) {
  if (message.authorId === null) return agentDisplayName(message.author);
  return names.get(message.authorId) ?? 'Someone';
}

/**
 * Scrolls the view's pane to its end, so the newest message sits above the sticky composer
 * (scrollIntoView would ignore the composer and leave the message under it).
 */
function scrollPaneToEnd(marker: HTMLElement | null) {
  const pane = marker?.closest<HTMLElement>('.agents-thread-scroll, .agents-scroll');
  if (pane) pane.scrollTop = pane.scrollHeight;
}

/** Messages by id in sequence order; a later copy of a message replaces the earlier one. */
function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * The thread's latest window with everything since `shown` (paged back, so a burst of replies
 * leaves no gap), merged into what is shown. Earlier messages already on the page stay.
 */
type ThreadKind = 'task' | 'agents';
type ThreadView = TaskDiscussion & Partial<Pick<AgentThreadView, 'canWrite' | 'postingAvailable' | 'messageCount'>>;
const readThread = (kind: ThreadKind, workId: string, options: { signal?: AbortSignal; beforeSequence?: number } = {}): Promise<ThreadView> =>
  kind === 'agents' ? readAgentThread(workId, options) : getTaskDiscussion(workId, options);

async function latestThread(kind: ThreadKind, workId: string, shown: ThreadView, signal: AbortSignal): Promise<ThreadView> {
  const latest = await readThread(kind, workId, { signal });
  const newestSeen = Math.max(shown.root?.sequence ?? 0, ...shown.messages.map((message) => message.sequence));
  let incoming = latest.messages;
  let page = latest;
  while (newestSeen > 0 && page.messagePage.hasMoreBefore && (page.messages[0]?.sequence ?? 0) > newestSeen + 1) {
    const before = page.messages[0]!.sequence;
    page = await readThread(kind, workId, { signal, beforeSequence: before });
    if (!page.messages.length || page.messages[0]!.sequence >= before) throw new Error('Could not load the replies in between');
    incoming = mergeMessages(page.messages, incoming);
  }
  return { ...latest, root: latest.root ?? shown.root, messages: mergeMessages(shown.messages, incoming), messagePage: shown.messagePage };
}

/** Whether the reader is at the end of the pane (within a few pixels), so new messages should follow. */
function paneAtEnd(marker: HTMLElement | null) {
  const pane = marker?.closest<HTMLElement>('.agents-thread-scroll, .agents-scroll');
  return !!pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
}

/** The task's one thread: the real first contribution as root, then its replies. */
/** The task a thread belongs to: its identity and title, from a bounded native read. */
interface ThreadTask { id: string; number: number; title: string; status: WorkStatus }

function TaskThread({ kind, task, projectId, meId, names, canWrite, changingScope }: { kind: ThreadKind; task: ThreadTask; projectId: string; meId: string; names: Map<string, string>; canWrite: boolean; changingScope: boolean }) {
  const owners = useAgentOwners(useProjectShell()?.project);
  const [discussion, setDiscussion] = useState<ThreadView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  // What is on the page, for merging a refetch; every change goes through `show`.
  const shown = useRef<ThreadView | null>(null);
  const show = useCallback((update: (current: ThreadView | null) => ThreadView | null) => {
    shown.current = update(shown.current);
    setDiscussion(shown.current);
  }, []);
  const reload = useRef(() => { /* set while mounted */ });
  // Per account and task, kept across views and reloads like every other composer (#40).
  const composer = useComposerDraft(meId, projectId, `${kind === 'agents' ? 'agent-thread' : 'task'}:${task.id}`);
  const makeWork = useCreateWorkFromMessage({ id: projectId });
  const captureScope = useComposerScope(composer.key);
  const blocked = changingScope || !discussion || !canWrite || accessLost || (kind === 'agents' && !(discussion?.canWrite && discussion.postingAvailable));
  // Typing (#155 AC-2) is the task thread's: the same canonical conversation as the task's thread in
  // Conversation, so a person writing in both views is one person typing. A task without a genuine first
  // contribution has no thread yet, so it has no typing scope (nothing is created to show it).
  const typing = useTyping(meId, kind === 'task' && discussion?.conversationId && !accessLost && !changingScope ? { kind: 'conversation', id: discussion.conversationId } : null, canWrite && !blocked);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // Keyed by task id: a different task mounts a fresh thread with its own draft. The first load and
  // every later refetch share one loop: one request at a time, and a change during it asks for
  // one more pass, so nothing that arrives meanwhile is missed.
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
            const next = before ? await latestThread(kind, task.id, before, controller.signal) : await readThread(kind, task.id, { signal: controller.signal });
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
            // Keep one newer reload (including native online) when an older transient read fails.
            // Access loss and an aborted identity/task never fall through into a retry.
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
  }, [kind, task.id, show]);

  // Another person's or agent's contribution appears without a reload (#183 B1). Events carry only
  // ids and kinds, and any change in this project may touch this thread (a message, a result posted
  // to it, a changed grant), so each one refetches; so does a resync after missed events.
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
    const all = discussion.root ? [discussion.root, ...discussion.messages.filter((item) => item.id !== discussion.root!.id)] : discussion.messages;
    // A message confirmed from this task's queue is shown at once, in its queued place (#264).
    const sent = composer.sent.map((item) => item.message).filter((message) => !discussion.conversationId || message.conversationId === discussion.conversationId);
    return mergeMessages(all, sent).sort((a, b) => a.sequence - b.sequence);
  }, [discussion, composer.sent]);
  const outbox = outboxView(messages, composer.pending, composer.sent, meId);
  // A thread opens at its newest message, like a conversation: once per load, after its messages are
  // on the page, and not on later updates. An empty thread keeps the view at its top.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!discussion || opened.current) return;
    opened.current = true;
    if (messages.length) scrollPaneToEnd(end.current);
  }, [discussion, messages.length]);
  // The same thread in the project conversation, once it has a root.
  const inConversation = kind === 'task' && discussion?.conversationId && !accessLost ? `/projects/${discussion.projectId}/conversations/${discussion.conversationId}` : null;
  // The people's side of the same task is its conversation in the task's details.
  const taskLink = kind === 'agents' && !accessLost ? `/projects/${projectId}/tasks?open=work:${task.id}` : null;

  // The agents' thread pages back by sequence; the task thread's earlier messages are in Conversation.
  // It reads the oldest message from what is shown now, so it can be repeated until a message is reached.
  const earlier = async (): Promise<boolean> => {
    const oldest = shown.current?.messages[0]?.sequence;
    if (!oldest) return false;
    const active = captureScope();
    try {
      const page = await readThread(kind, task.id, { beforeSequence: oldest });
      if (active()) show((current) => current ? { ...current, messages: mergeMessages(page.messages, current.messages), messagePage: page.messagePage } : current);
      return active();
    } catch { if (active()) setLoadError('Earlier messages could not be loaded.'); return false; }
  };

  // "Open original message" of a request card (#400 AC-4): the message comes into view and fades its highlight after 2 s
  // (Spokój rule 6). A message older than the page is reached by paging back, a bounded number of pages.
  const openMessage = async (messageId: string) => {
    for (let pages = 0; pages < 20; pages += 1) {
      const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.focus({ preventScroll: true });
        row.setAttribute('data-arrived', 'true');
        window.setTimeout(() => row.removeAttribute('data-arrived'), 2000);
        return;
      }
      if (!shown.current?.messagePage.hasMoreBefore || !await earlier()) return;
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    }
  };
  // A link to a message in this thread (`#message-…`) lands on it once the thread has loaded.
  const arrivedAt = useRef<string | null>(null);
  useEffect(() => {
    if (kind !== 'agents' || !discussion || accessLost) return;
    const target = window.location.hash.startsWith('#message-') ? window.location.hash.slice('#message-'.length) : null;
    if (!target || arrivedAt.current === `${task.id}:${target}`) return;
    arrivedAt.current = `${task.id}:${target}`;
    void openMessage(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per loaded thread and link
  }, [kind, task.id, !!discussion, accessLost]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    typing.stop();
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
    flushSync(() => show((current) => current && kind === 'agents' && !current.messages.some((item) => item.id === message.id)
      ? { ...current, conversationId: current.conversationId ?? message.conversationId, messageCount: (current.messageCount ?? 0) + 1, messages: [...current.messages, message] }
      : current && !current.messages.some((item) => item.id === message.id) && current.root?.id !== message.id
      ? { ...current, conversationId: current.conversationId ?? message.conversationId, rootMessageId: current.rootMessageId ?? message.id,
        root: current.root ?? message, messages: [...current.messages, message] }
      : current));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  return (
    <section className="agents-thread" data-empty={discussion && !messages.length && !outbox.pending.length && !accessLost ? 'true' : undefined} aria-label={`${kind === 'agents' ? 'Agents’ thread' : 'Thread'} of ${task.title}`}>
      {kind === 'agents'
        ? <p className="agents-thread__top">Agents’ thread · visible to everyone with access to this project{taskLink ? <> · <RefLink className="ui-link" to={taskLink}>Open task</RefLink></> : null}</p>
        : <p className="agents-thread__top">Thread of this task · the same one shown in Conversation{inConversation ? <> · <RefLink className="ui-link" to={inConversation}>Open in Conversation</RefLink></> : null}</p>}
      {loadError ? <p className="agents-thread__error" role="alert">{loadError} <button type="button" className="ui-link" onClick={() => reload.current()}>Try again</button></p> : null}
      {accessLost ? <p className="agents-thread__error" role="alert">You can no longer read this task. Your unsent text is kept on this device.</p> : null}
      {!discussion && !loadError ? <p className="agents-thread__empty">Loading…</p> : null}
      {discussion && !accessLost && !messages.length && !outbox.pending.length ? <p className="agents-thread__empty">{kind === 'agents' ? 'No one has written to the agents about this task yet. The first message starts its thread.' : 'No one has written about this task yet. The first message starts its thread.'}</p> : null}
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
              <MessageContent body={message.body ? <WhenNoQuestion projectId={projectId} messageId={message.id}><div className="message-body agents-msg__body"><MessageText body={message.body} /></div></WhenNoQuestion> : null} files={message.files} context={{ author: name, at: message.createdAt, caption: message.body, onReply: blocked ? undefined : () => box.current?.focus(), onCreateTask: kind === 'task' && canWrite && !accessLost ? () => void makeWork.create(message) : undefined }}>
                <LinkPreviews body={message.body} />
              </MessageContent>
              <QuestionCard projectId={projectId} messageId={message.id} meId={meId} writable={canWrite} />
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
      {discussion?.messagePage.hasMoreBefore && !accessLost ? <p className="agents-thread__empty">{kind === 'agents' ? <button type="button" className="ui-link" onClick={() => void earlier()}>Show earlier messages</button> : <>Earlier messages are in the task's thread in {inConversation ? <RefLink className="ui-link" to={inConversation}>Conversation</RefLink> : 'Conversation'}.</>}</p> : null}
      {kind === 'agents' && !accessLost ? <RequestCards key={task.id} workId={task.id} projectId={projectId} taskNumber={task.number} meId={meId} onOpenMessage={(messageId) => void openMessage(messageId)} /> : null}
      <div ref={end} />
      <form className="agents-composer" onSubmit={(event) => { void send(event); }}>
        {canWrite ? <ConnectionLine /> : null}
        <label className="ui-vh" htmlFor="agents-draft">{kind === 'agents' ? 'Write to the agents' : 'Write to this task'}</label>
        <textarea id="agents-draft" ref={box} value={composer.draft.body} rows={2} readOnly={changingScope} aria-busy={changingScope}
          placeholder={kind === 'agents' ? canWrite ? 'Write to the agents…' : 'You can read this thread but not write to it.' : canWrite ? 'Add to this work…' : 'You can read this task but not write to it.'} disabled={blocked}
          onChange={(event) => { if (!blocked) { composer.setBody(event.target.value); typing.input(Boolean(event.target.value.trim())); } }} onBlur={typing.stop} onKeyDown={onKeyDown} />
        <ComposerFiles state={composer} disabled={blocked} attach="none" />
        {kind === 'task' && discussion?.conversationId && !accessLost ? <TypingNotice {...typing} /> : null}
        {changingScope ? <p className="agents-composer__hint" role="status">Opening your selection… Your current draft is kept.</p> : null}
        <div className="agents-composer__row">
          <AttachButton state={composer} disabled={blocked} />
          <span className="agents-composer__hint">{kind === 'agents' ? 'Goes to the agents’ thread' : 'Goes to the task thread'}<span className="composer__keys"> · Enter sends, Shift+Enter new line</span></span>
          <Button type="submit" variant="primary" icon="send" disabled={!composer.canSend || blocked} aria-label={kind === 'agents' ? 'Send to the agents' : 'Send to task'}>Send</Button>
        </div>
      </form>
    </section>
  );
}

/** Events that change who can act here: a grant, the project's agent policy, an agent created or revoked. */
const CONNECTION_EVENTS = new Set(['project.grant_set.v1', 'project.grant_revoked.v1', 'project.agent_policy_published.v1', 'agent.created.v1', 'agent.revoked.v1']);

/**
 * The connections stay current while the view is open (#183 N1), by the same no-reload standard as
 * the thread: a revocation, a session opening or closing or a narrowed grant shows without a reload.
 * Grant, policy and agent events and a resync refetch at once (not every message, which would refetch
 * on each line of a busy thread). A revoked connection and a session opening or closing record no
 * event, so focus, a visible tab and a 15 s poll while the tab is visible also refetch; the poll moves
 * the observation time too, keeping "Last: …" current. A separate deadline clock promptly ages known
 * session expiries without making another read.
 */
function useConnections(projectId: string, meId: string, initial: ProjectAgentsData) {
  // A newer read replaces the loader's list until the loader itself reads again.
  const [fetched, setFetched] = useState<{ base: ProjectAgentsData; view: ProjectAgentsData } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reload = useRef<() => Promise<void>>(async () => { /* not mounted */ });
  useEffect(() => {
    let controller: AbortController | null = null;
    reload.current = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const next = await getProjectAgents(projectId, current.signal);
        if (!current.signal.aborted) { setFetched({ base: initial, view: next }); setNow(Date.now()); }
      } catch { /* keep the last known projection; the next trigger retries */ }
    };
    return () => { controller?.abort(); reload.current = async () => { /* unmounted */ }; };
  }, [projectId, initial]);
  useStreamEvents(meId, (event) => {
    if (CONNECTION_EVENTS.has(event.kind) && (event.objectType === 'agent' || event.objectId === projectId)) reload.current();
  }, () => reload.current());
  useEffect(() => {
    const onFocus = () => reload.current();
    const onVisible = () => { if (document.visibilityState === 'visible') reload.current(); };
    const tick = () => { setNow(Date.now()); onVisible(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(tick, 15_000);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(interval); };
  }, []);
  const view = fetched && fetched.base === initial ? fetched.view : initial;
  const list = view.connections;
  const displayedNow = useSessionClock(list, now);
  return { list, view, now: displayedNow, refresh: () => reload.current() };
}

/** A stop stays the row's second line for a day; after that the connection's own state is again the truth. */
const STOPPED_SHOWN_MS = 24 * 60 * 60 * 1000;

const RANK: Record<ProjectAgentConnection['state'], number> = { session_open: 0, offline: 1, not_signed_in: 2, unavailable: 3 };

/** A question as a row or a request shows it: its first 60 characters, with an ellipsis when it was cut. */
const briefly = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/** Whether a connection has an open session now (a session past its end does not). */
const isOnline = (connection: ProjectAgentConnection | null, now: number) => !!connection && shownState(connection, now) === 'session_open';

/** Where a connection sits in the list when the agent holds nothing (P2-1 order: online, offline, not signed in, can't act). */
function connectionRank(connection: ProjectAgentConnection | null, now: number): number {
  if (!connection || connection.state === 'not_signed_in') return 7;
  if (connection.state === 'unavailable') return 8;
  return shownState(connection, now) === 'session_open' ? 5 : 6;
}

/** The agent's name as a toast says it: a teammate's agent is "Jonas’s Claude Code", so it is not mistaken for one's own (#347 N10). */
export function agentLabel(entry: AgentEntry, meId: string): string {
  return entry.ownerId && entry.ownerId !== meId && entry.owner ? `${firstName(entry.owner)}’s ${entry.name}` : entry.name;
}

/** The face of an agent: Working only for a claimed unit on a usable live session (C-1); asleep when paused or not live. */
function agentExpression(entry: AgentEntry, now: number): KreskaExpression {
  return entry.connection?.state === 'unavailable' ? 'worried' : isAgentWorking(entry, now) ? 'working'
    : entry.connection?.currentWork?.state === 'paused' ? 'asleep' : entry.connection ? connectionExpression(entry.connection, now) : 'idle';
}

/** Where a connection is, said beside a recorded unit of work (the unit's own line never says it). */
function availabilityLine(connection: ProjectAgentConnection, now: number): string {
  return shownState(connection, now) === 'session_open' ? `Session open since ${when(connection.session!.startedAt)}` : stateLine(connection, now);
}

/** A task handed to an agent but not claimed on a live session (C-1): "Handed", with what keeps it from being worked on. */
function handedLine(task: WorkRowProjection, connection: ProjectAgentConnection | null, now: number): string {
  if (!connection || connection.state === 'not_signed_in') return `Handed #${task.number} · not signed in yet`;
  if (connection.state === 'unavailable') return `Handed #${task.number} · can’t act here now`;
  if (shownState(connection, now) !== 'session_open') {
    return `Handed #${task.number} · offline${connection.lastActivity ? ` · last seen ${when(connection.lastActivity.at)}` : ''}`;
  }
  return `Handed #${task.number} · ${task.title}`;
}

/** What a row says, its Kreska, whether it is working (a claimed unit on a live session) and its place in the list. */
interface RowView { line: ReactNode; expression: KreskaExpression; working: boolean; rank: number }

/**
 * A row's second line (C-1, P2-1), first match wins: the agent's open question to you; the connection's recorded unit of
 * work (Working only when it is claimed on a usable live session); its blocked task; a task handed to it (never "Working":
 * native ownership is not execution); its recent stop; else what Flux can prove about the connection.
 * Only the agent's lead row (its first online connection, else its first row) speaks for its questions and recent stop.
 */
function rowView(entry: AgentEntry, held: WorkRowProjection[], lead: boolean, now: number, stopped: AgentStop | null, asking: AgentQuestion | null, meId: string): RowView {
  const connection = entry.connection;
  const task = held[0];
  const work = connection?.currentWork ?? null;
  const expression = agentExpression(entry, now);
  if (lead && asking) return { line: `Waiting for you · asks “${briefly(asking.question)}”`, expression: 'waiting', working: false, rank: 1 };
  if (work) {
    const working = isAgentWorking(entry, now);
    // The unit says where its connection is on the same line, so a phone row stays compact (P2-6).
    return { line: `${currentWorkLine(work, working)} · ${availabilityLine(connection!, now)}`, expression, working, rank: working ? 2 : connectionRank(connection, now) };
  }
  if (task?.status === 'blocked') {
    return { line: <><StatusGlyph status="blocked" size={12} />{` Blocked on #${task.number}${task.blocker ? ` · ${task.blocker}` : ''}`}</>, expression, working: false, rank: 3 };
  }
  if (task) return { line: handedLine(task, connection, now), expression, working: false, rank: isOnline(connection, now) ? 4 : connectionRank(connection, now) };
  if (lead && stopped && now - Date.parse(stopped.stoppedAt) < STOPPED_SHOWN_MS) {
    return { line: `Stopped by ${stopped.stoppedBy.id === meId ? 'you' : stopped.stoppedBy.name} · #${stopped.taskNumber}`, expression, working: false, rank: connectionRank(connection, now) };
  }
  if (!connection) return { line: entry.access === 'viewer' ? 'Can read here · nothing handed to it' : 'Nothing handed to it', expression, working: false, rank: 7 };
  return { line: stateLine(connection, now), expression, working: false, rank: connectionRank(connection, now) };
}

/** The lead row of each agent: its first online connection, else its first row (list order). */
function leadKeys(entries: readonly AgentEntry[], now: number): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    const same = entries.filter((other) => other.agentId === entry.agentId);
    keys.add((same.find((other) => isOnline(other.connection, now)) ?? same[0]!).key);
  }
  return keys;
}

/** Stop (S13): the filled square of the sidebar card, with its word so a row and a panel say what it does. */
function StopButton({ label, text, busy, onClick, className }: { label: string; text: string; busy: boolean; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`agents-stop${className ? ` ${className}` : ''}`} aria-label={label} aria-busy={busy || undefined} disabled={busy} onClick={onClick}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
      <span>{busy ? 'Stopping…' : text}</span>
    </button>
  );
}

/** What a row may offer on its lead row: Stop (in progress) or Take back (open or blocked), and whether it is busy. */
interface RowStop { label: string; text: string; busy: boolean; run: () => void }

function AgentRow({ entry, view, duplicate, short, now, selected, dropping, stop, canDrop, onOpen, onDropTask, onDropping }: {
  entry: AgentEntry; view: RowView; duplicate: boolean; short: string | null; now: number; selected: boolean; dropping: boolean;
  stop: RowStop | null; canDrop: boolean; onOpen: () => void; onDropTask: (taskId: string) => void; onDropping: (on: boolean) => void;
}) {
  const last = entry.connection?.lastActivity;
  // Two connections of one agent are told apart by client and connection; the meta then starts with the agent's name (P2-6).
  const title = duplicate && entry.via ? entry.via : entry.name;
  const owner = entry.owner ? (
    <><span className="agents-row__owner">for {entry.owner}</span><span className="agents-row__owner-short">for {short}</span></>
  ) : null;
  return (
    <li className="agents-row" data-agent={entry.agentId} data-state={entry.connection ? shownState(entry.connection, now) : undefined} data-working={view.working || undefined} data-drop={dropping || undefined}
      onDragOver={(event) => { if (canDrop && event.dataTransfer.types.includes(TASK_DRAG)) { event.preventDefault(); onDropping(true); } }}
      onDragLeave={() => onDropping(false)}
      onDrop={(event) => { const id = event.dataTransfer.getData(TASK_DRAG); onDropping(false); if (canDrop && id) { event.preventDefault(); onDropTask(id); } }}>
      <button type="button" className="agents-row__btn" aria-pressed={selected} onClick={onOpen}>
        <Kreska size={36} expression={view.expression} hue={agentHue(entry.agentId)} className="agents-row__icon" />
        <span className="agents-row__body">
          <span className="agents-row__who"><AgentIdentity name={title} icon={false} /></span>
          <span className="agents-row__meta">
            {duplicate ? <><span className="agents-row__via-name">{entry.name}</span>{owner ? ' · ' : null}</> : null}
            {owner}
            {!duplicate && entry.via ? <span className="agents-row__via"> · {entry.via}</span> : null}
          </span>
          <span className="agents-row__now">{view.line}</span>
          {entry.connection?.requests.map((request) => <span key={request.id} className="agents-row__activity">{requestLine(request)}</span>)}
        </span>
        {last ? <time className="agents-row__time" dateTime={last.at}>{when(last.at)}</time> : null}
        <Icon name="chevron-right" size={14} className="agents-row__go" />
      </button>
      {stop ? <StopButton className={`agents-row__stop${stop.text.startsWith('Take back') ? ' agents-row__stop--take' : ''}`} label={stop.label} text={stop.text} busy={stop.busy} onClick={stop.run} /> : null}
    </li>
  );
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What keeps a handed task from being worked on now, by what Flux can prove about the agent's connection (C-1, P1-1). */
function handedSuffix(connection: ProjectAgentConnection | null, now: number): string {
  if (!connection || connection.state === 'not_signed_in') return ' · not signed in yet';
  if (connection.state === 'unavailable') return ' · can’t act here now';
  return shownState(connection, now) === 'session_open' ? '' : ' · its app is offline';
}

/**
 * The panel's note on the held task, in the row's own words (#347 N5): a question to you first, then a blocker, else the task
 * as handed to it (native ownership is not execution, C-1), with its task status and connection.
 */
function taskNote(task: WorkRowProjection, asking: AgentQuestion | null, connection: ProjectAgentConnection | null, now: number): string {
  if (asking) return 'Waiting for your answer';
  if (task.status === 'blocked') return task.blocker ? `Blocked · ${task.blocker}` : 'Blocked';
  return `Handed to it · task ${STATUS_LABEL[task.status].toLowerCase()}${handedSuffix(connection, now)}`;
}

/**
 * One agent in the detail panel (P9, AC-5): who owns it, what it is doing now (its latest line on the task, one tap from the
 * thread), what Flux has recorded and what its grant here lets it do. Stop ends the agent's hold on its task; Flux cannot kill
 * the agent's own program, so the panel says what was stopped, and by whom.
 */
function AgentDetail({ entry, held, meId, projectId, now, asking, canHandOff, stops, stop, refocus, onRefocused, onHandOff, onThread }: {
  entry: AgentEntry; held: WorkRowProjection[]; meId: string; projectId: string; now: number; asking: AgentQuestion | null; canHandOff: boolean; stops: AgentStop[];
  /** Present when this person may stop the agent's task now. */
  stop: RowStop | null; refocus: boolean; onRefocused: () => void; onHandOff: () => void; onThread: (taskId: string) => void;
}) {
  const task = held[0];
  const currentWork = entry.connection?.currentWork;
  const otherHeld = currentWork ? held.filter((row) => row.id !== currentWork.taskId) : held.slice(1);
  const last = entry.connection?.lastActivity;
  const grant = mayDo(entry.access);
  // The Now card is the recorded unit's task when it is on this page (its number is known), else the task handed to it.
  const shown = currentWork ? held.find((row) => row.id === currentWork.taskId) ?? null : task ?? null;
  const latest = useLatestAgentLine(shown?.id ?? null, entry.agentId);
  const teammate = teammateOf(entry, meId);
  const lineId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [entry.key]);
  // After Stop or Take back the focus stays on this agent, not on the row that moved (#347 N4).
  useEffect(() => { if (refocus) { heading.current?.focus({ preventScroll: true }); onRefocused(); } }, [refocus, onRefocused]);
  const question = asking ? `Asks: “${asking.question}”` : null;
  return (
    <section className="agents-detail" aria-label={`${entry.name}, details`}>
      <header className="agents-detail__head">
        <Kreska size={40} expression={agentExpression(entry, now)} hue={agentHue(entry.agentId)} />
        <div>
          <h2 className="agents-detail__name" ref={heading} tabIndex={-1}><AgentIdentity name={entry.name} icon={false} /></h2>
          <p className="agents-detail__for">{[entry.owner ? `for ${entry.owner}` : null, entry.via, entry.connection ? 'local MCP' : null].filter(Boolean).join(' · ')}</p>
        </div>
      </header>
      {entry.connection?.scopes ? <p className="agents-detail__note" aria-label="Permissions" data-testid="agent-permissions">{permissionsLine(entry.connection.scopes)}</p> : null}
      <section className="agents-detail__now" aria-label="Now">
        <h3>Now</h3>
        {shown ? (
          <button type="button" className="agents-detail__card" aria-label={`Open the thread of #${shown.number}`} aria-describedby={lineId} onClick={() => onThread(shown.id)}>
            <span className="agents-detail__task"><StatusGlyph status={shown.status} size={14} /><span className="ui-task-number">#{shown.number}</span><span className="agents-detail__tasktitle">{shown.title}</span></span>
            <span id={lineId} className="agents-detail__latest">{question ?? (latest === undefined ? '' : latest ? latest.body : 'No message from it on this task yet.')}</span>
            {latest && !question ? <span className="agents-detail__at">Last update {when(latest.at)}</span> : null}
          </button>
        ) : currentWork ? (
          <p className="agents-detail__task"><button type="button" className="agents-detail__thread" onClick={() => onThread(currentWork.taskId)}>{currentWork.taskTitle}</button></p>
        ) : null}
        {currentWork ? (
          <p className="agents-detail__note">{asking ? 'Waiting for your answer · ' : ''}{WORK_ROLE[currentWork.role]} · {currentWork.state === 'claimed' ? isAgentWorking(entry, now) ? 'Working · claim recorded' : 'Work held · claim recorded' : currentWork.state === 'paused' ? 'Paused' : 'Assigned, not started'}{otherHeld.length ? ` · ${otherHeld.length} more handed` : ''} · <Link className="ui-link" to={`/projects/${projectId}/tasks?open=work:${currentWork.taskId}`}>Open task</Link></p>
        ) : task ? (
          <p className="agents-detail__note">{taskNote(task, asking, entry.connection, now)}{held.length > 1 ? ` · ${held.length - 1} more handed` : ''} · <RefLink className="ui-link" to={`/projects/${projectId}/tasks?open=work:${task.id}`}>Open task</RefLink></p>
        ) : <p className="agents-detail__note">{entry.connection ? stateLine(entry.connection, now) : 'Nothing is handed to it.'}</p>}
        {entry.connection && currentWork ? <p className="agents-detail__note">{availabilityLine(entry.connection, now)}</p> : null}
        {entry.connection?.requests.map((request) => <p key={request.id} className="agents-detail__note">{requestLine(request)}</p>)}
      </section>
      <section aria-label="Recent">
        <h3>Recent</h3>
        {last || otherHeld.length || stops.length ? (
          <ul className="agents-detail__recent">
            {stops.slice(0, 3).map((item) => <li key={item.id} data-stop={item.id}><span>Stopped by {item.stoppedBy.id === meId ? 'you' : item.stoppedBy.name} · <span className="ui-task-number">#{item.taskNumber}</span></span><time dateTime={item.stoppedAt}>{when(item.stoppedAt)}</time></li>)}
            {last ? <li><span>{sentence(OPERATION_LABEL[last.operation])}</span><time dateTime={last.at}>{when(last.at)}</time></li> : null}
            {otherHeld.map((row) => <li key={row.id}><button type="button" className="agents-detail__thread" onClick={() => onThread(row.id)}>Also holds #{row.number} · {row.title}</button></li>)}
          </ul>
        ) : <p className="agents-detail__note">Nothing recorded yet.</p>}
      </section>
      <section aria-label="Can">
        <h3>Can</h3>
        <p className="agents-detail__note">{sentence(grant.can)}</p>
      </section>
      <div className="agents-detail__actions">
        {stop ? <StopButton label={stop.label} text={stop.text} busy={stop.busy} onClick={stop.run} /> : null}
        {task ? <Button variant="secondary" onClick={() => onThread(task.id)}>Message</Button> : null}
        {canHandOff ? <Button variant="secondary" onClick={onHandOff} disabled={!grant.canTake}>{teammate ? `Ask ${firstName(entry.owner ?? 'them')} to use ${entry.name}` : `Hand off to ${entry.name}`}</Button> : null}
      </div>
      {stop && task ? <p className="agents-detail__note">{task.status === 'in_progress'
        ? `Stop ends ${entry.name}’s hold on #${task.number}.${entry.connection ? ` Its app on ${entry.connection.name} may keep running.` : ''}`
        : `Taking #${task.number} back ends ${entry.name}’s hold on it.${entry.connection ? ` Its app on ${entry.connection.name} may keep running.` : ''}`}</p> : null}
    </section>
  );
}

/** A question's Requests line target: its task's thread in this view, else its conversation. */
const questionLink = (projectId: string, question: AgentQuestion) => question.taskId
  ? `/projects/${projectId}/agents?task=${question.taskId}`
  : `/projects/${projectId}/conversations/${question.conversationId}`;

export function ProjectAgents() {
  const data = useLoaderData() as ProjectAgentsData | null;
  const shell = useProjectShell();
  const aiOff = useWorkspaceAi(shell?.project.workspaceId);
  // The loader answers null for a workspace whose AI is off; the shell says so too, once it has read the policy again.
  if (!data || aiOff.blocked) return <AiOffState workspaceId={shell?.project.workspaceId} backTo={`/projects/${shell?.project.id ?? ''}`} backLabel="Back to the conversation" />;
  return <ProjectAgentsLoaded data={data} />;
}

function ProjectAgentsLoaded({ data }: { data: ProjectAgentsData }) {
  const { metadataSlot, viewMenuMetadataSlot } = useShellActions();
  const shell = useProjectShell();
  const { me } = useShellData();
  const location = useLocation();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [search, setSearch] = useSearchParams();
  const projectId = shell?.project.id ?? data.projectId;
  const [taskRevision, setTaskRevision] = useState(0);
  useStreamEvents(me.user.id, (event) => {
    if (event.objectType === 'project' && event.objectId === projectId && /^project\.(work|decision|result|link)_/.test(event.kind))
      setTaskRevision((value) => value + 1);
  }, () => setTaskRevision((value) => value + 1));
  // Open, unparked tasks come one bounded native page at a time (#155), never the whole project.
  const choices = useWorkChoices(me.user.id, projectId, { purpose: 'choices', choice: 'pivot_work' }, true, taskRevision);
  const rows = useMemo(() => (choices.page?.items ?? []).filter((row): row is WorkRowProjection => row.kind === 'work'), [choices.page]);
  const tasks = useMemo<ThreadTask[]>(() => rows.map((row) => ({ id: row.id, number: row.number, title: row.title, status: row.status })), [rows]);
  // A `?task=` outside this page is read by itself; one that is not this project's task (or
  // cannot be read) falls back to the first open one.
  // `?thread=` is the task's agents' thread and `?task=` its people's thread; both open the same detail panel or sheet.
  const wantedThread = search.get('thread');
  const wanted = wantedThread ?? search.get('task');
  const threadKind: ThreadKind = wantedThread ? 'agents' : 'task';
  const onPage = tasks.find((item) => item.id === wanted) ?? null;
  const own = useNativeOwn(me.user.id, projectId, 'work', wanted && !onPage ? wanted : undefined, true, taskRevision);
  // A task whose creation was undone (#238) is history: it opens in Details, never as a thread to work on here.
  const ownTask = own.value?.object.kind === 'work' && own.value.object.id === wanted && own.value.object.projectId === projectId
    && own.value.object.lifecycle?.state !== 'creation_reverted'
    ? { id: own.value.object.id, number: own.value.object.number, title: own.value.object.title, status: own.value.object.status } : null;
  // While that read (or the first page) is still on its way, nothing is chosen yet, so a
  // thread never opens on a fallback task and then jumps.
  const settling = (!!wanted && !onPage && (own.read.phase === 'loading' || !choices.page)) || (!wanted && !choices.page);
  // The thread is open only for a `?task=`; there is no task picker and no thread under the list.
  const task = wanted && !settling ? onPage ?? ownTask ?? tasks[0] ?? null : null;
  const names = useMemo(() => new Map((shell?.people ?? []).map((person) => [person.id, person.name])), [shell]);
  const changingScope = navigation.state !== 'idle' && !!navigation.location
    && (navigation.location.pathname !== location.pathname || navigation.location.search !== location.search);
  const connections = useConnections(projectId, me.user.id, data);
  const canWrite = shell?.project.access !== 'viewer';
  const agentStops = useAgentStops(projectId, me.user.id);
  const { reload: reloadStops } = agentStops;
  const refreshChoices = choices.onRefresh;
  const stopper = useStopAgent(projectId, useCallback(() => { reloadStops(); refreshChoices(); }, [reloadStops, refreshChoices]));
  const questions = useQuestionList(projectId);
  useProjectQuestions(projectId, me.user.id);
  // Questions that wait for this person's answer, newest first.
  const asked = useMemo(() => questions.filter((question) => question.askedUserId === me.user.id && !question.answer), [questions, me.user.id]);

  const sortedConnections = useMemo(() => [...connections.list].sort((a, b) => RANK[shownState(a, connections.now)] - RANK[shownState(b, connections.now)]), [connections.list, connections.now]);
  const listed = useMemo(() => agentEntries(shell?.people ?? null, sortedConnections).filter((entry) => entry.connection && !entry.connection.assistant), [shell?.people, sortedConnections]);
  const heldBy = (agentId: string) => tasksHeldBy(agentId, rows);
  const lastStopOf = (agentId: string) => agentStops.stops.find((item) => item.agent.id === agentId) ?? null;
  const leads = useMemo(() => leadKeys(listed, connections.now), [listed, connections.now]);
  const views = new Map(listed.map((entry) => [entry.key, rowView(entry, heldBy(entry.agentId), leads.has(entry.key), connections.now,
    lastStopOf(entry.agentId), asked.find((question) => question.agent.id === entry.agentId) ?? null, me.user.id)]));
  // The list is ordered by what needs the person first (P2-1); ties keep the order above.
  const entries = [...listed].sort((a, b) => views.get(a.key)!.rank - views.get(b.key)!.rank);
  const beside = useMediaQuery('(min-width: 1001px)');
  // From an agent's panel a thread opens as a step forward: on a narrow pane the panel (which hides the list and
  // the thread) is left, and Back returns to it.
  // A thread opened by the person takes the panel's focus (#347 N8); it keeps the agent it was opened from, so "‹ back" returns to that agent.
  const openThread = (id: string) => {
    setSearch((current) => { const next = new URLSearchParams(current); next.set('thread', id); next.delete('task'); return next; }, { replace: beside, flushSync: true, state: location.state });
  };
  // Back from a thread returns to the agent it was opened from; closing the panel leaves both.
  const closeThread = () => {
    setSearch((current) => { const next = new URLSearchParams(current); next.delete('task'); next.delete('thread'); return next; }, { replace: true, state: location.state });
  };
  const closePanel = () => {
    setDeclined(true);
    setSearch((current) => { const next = new URLSearchParams(current); next.delete('task'); next.delete('thread'); next.delete('agent'); return next; }, { replace: true, state: location.state });
  };
  // After Stop or Take back the panel stays on that agent, with focus on its heading (#347 N4).
  const [refocusKey, setRefocusKey] = useState<string | null>(null);
  // The project roster offers management controls only to this connection’s owner (#522).
  const stopOf = (entry: AgentEntry): RowStop | null => {
    const held = heldBy(entry.agentId)[0];
    if (!held || !canWrite || entry.ownerId !== me.user.id) return null;
    const busy = stopper.busy === `${entry.agentId}:${held.id}`;
    const inProgress = held.status === 'in_progress';
    return {
      label: inProgress ? `Stop ${entry.name}` : `Take back #${held.number}`,
      text: inProgress ? 'Stop' : `Take back #${held.number}`,
      busy,
      // Hand back is offered for an agent this person owns (or a workspace agent), never a teammate's (P1-3).
      run: () => {
        // The panel is pinned to the agent first, so the list re-sorting after Stop does not move it to another agent.
        if (beside) open(entry.key);
        setRefocusKey(entry.key);
        void stopper.stop(entry.agentId, held, agentLabel(entry, me.user.id), entry.ownerId === null || entry.ownerId === me.user.id);
      },
    };
  };
  const working = [...views.values()].filter((view) => view.working).length;
  const waiting = [...views.values()].filter((view) => view.rank === 1).length;
  const picked = search.get('agent');
  // Where the panel fits beside the list it is open from the start, on the working agent as drawn, until the person closes it; narrow panes open it by choice.
  const [declined, setDeclined] = useState(false);
  const selected = entries.find((entry) => entry.key === picked) ?? (beside && !declined ? entries.find((entry) => views.get(entry.key)?.working) ?? entries[0] ?? null : null);
  const open = (key: string | null) => {
    setDeclined(key === null);
    setSearch((current) => { const next = new URLSearchParams(current); if (key) next.set('agent', key); else next.delete('agent'); return next; }, { replace: true, state: location.state });
  };

  const [handOff, setHandOff] = useState<{ agentId: string | null; task: HandOffTask | null } | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  // `?policy=open` opens the policy (a link to it, and where a reload leaves a reader who had it open).
  const [policyOpen, setPolicyOpen] = useState(search.get('policy') === 'open');
  const dropTask = (agentId: string, taskId: string) => {
    const row = rows.find((item) => item.id === taskId);
    if (row) setHandOff({ agentId, task: { id: row.id, version: row.version, number: row.number, title: row.title } });
  };
  const latestDetail = selected;
  const requests = asked[0] ?? null;
  // A task's thread or an agent's details open in the one panel, as a task does (F-026 S4); this view keeps their state.
  // A page a reference led to, with its panel in a sheet or an overlay over the header, carries the way back (#592).
  const originBack = useOriginPanelBack();
  const slot = useOwnedPanel(task ? {
    key: `thread:${threadKind}:${task.id}`, chip: threadKind === 'agents' ? 'Agents’ thread' : 'Thread', label: `#${task.number} · ${task.title}`, closeLabel: 'Close thread', startFull: true,
    ...(latestDetail ? { back: { label: latestDetail.name, run: closeThread } } : {}), ...(originBack ? { origin: originBack } : {}), onClose: closePanel,
  } : latestDetail ? { key: `agent:${latestDetail.key}`, chip: 'Agent', label: latestDetail.name, ...(originBack ? { origin: originBack } : {}), onClose: closePanel } : null);

  // The view scrolls in its own pane like every other view, so a long thread stays reachable
  // above the sticky composer on any screen.
  return (
    <div className="pane-scroll agents-scroll">
    {metadataSlot ? createPortal(<span className="agents-header-meta">{listed.length} MCP {listed.length === 1 ? 'client' : 'clients'}</span>, metadataSlot) : null}
    {viewMenuMetadataSlot ? createPortal(<span>{listed.length} MCP {listed.length === 1 ? 'client' : 'clients'}</span>, viewMenuMetadataSlot) : null}
    <div className="agents">
      <div className="agents__main">
        <header className="agents__head">
          <h1 className="agents__title">Agents</h1>
          <span className="agents__count">{[`${entries.length} in this project`, working ? `${working} working` : null, waiting ? `${waiting} waiting for you` : null].filter(Boolean).join(' · ')}</span>
          {canWrite && shell ? <Button variant="primary" className="agents__handoff" onClick={() => setHandOff({ agentId: null, task: null })}>Hand off a task</Button> : null}
        </header>
        {entries.length ? (
          <ul className="agents-list" aria-label="Agents in this project">
            {entries.map((entry) => (
              <AgentRow key={entry.key} entry={entry} view={views.get(entry.key)!} now={connections.now} selected={latestDetail?.key === entry.key}
                duplicate={listed.filter((other) => other.agentId === entry.agentId).length > 1} short={shortOwner(entry, me.user.id)}
                dropping={dropping === entry.key} canDrop={canWrite && entry.ownerId === me.user.id} stop={leads.has(entry.key) ? stopOf(entry) : null} onOpen={() => open(entry.key)}
                onDropTask={(id) => dropTask(entry.agentId, id)} onDropping={(on) => setDropping((current) => on ? entry.key : current === entry.key ? null : current)} />
            ))}
          </ul>
        ) : (
          <p className="agents__no-connections">No agents here yet. Connect one below; people can still discuss tasks in Conversation.</p>
        )}
        <ul className="agents-links">
          <li><RefLink className="agents-link" to={requests ? questionLink(projectId, requests) : '/inbox'}>
            <span className="agents-link__icon"><Icon name="inbox" size={16} /></span>
            <span className="agents-link__text">
              {requests ? <><b>Agent questions</b> · {requests.agent.name} asks: “{briefly(requests.question)}”</> : <><b>Agent questions</b> · No open questions for you</>}
            </span>
            {asked.length ? <span className="agents-link__count">{asked.length}</span> : null}
            <Icon name="chevron-right" size={14} />
          </RefLink></li>
          <li><button type="button" className="agents-link" aria-expanded={policyOpen} aria-controls="agents-policy" onClick={() => setPolicyOpen((value) => !value)}>
            <span className="agents-link__icon"><Icon name="rule" size={16} /></span><span className="agents-link__text"><b>Project policy</b> · Agents read and propose; people accept. Assistants also edit for their owner, with Undo.</span><span className="agents-link__go">{policyOpen ? 'Hide' : shell?.project.access === 'manager' ? 'Edit' : 'Read'}<Icon name="chevron-right" size={14} /></span></button></li>
        </ul>
        {policyOpen ? (
          <div id="agents-policy">
            <ProjectPolicy key={projectId} projectId={projectId} meId={me.user.id} canEdit={shell?.project.access === 'manager'}
              managers={(shell?.people ?? []).filter((person) => person.kind === 'human' && person.access === 'manager').map((person) => person.name)} />
            <ReviewRule key={projectId} projectId={projectId} meId={me.user.id} canEdit={shell?.project.access === 'manager'} />
          </div>
        ) : null}
        {canWrite && entries.length && rows.length ? (
          <section className="agents-drag" aria-label="Open tasks to hand off">
            <p className="agents-drag__hint">Drag a task onto an agent to hand it off</p>
            <ul className="agents-drag__list">
              {rows.filter((row) => row.owner?.kind !== 'agent').slice(0, 6).map((row) => (
                <li key={row.id} className="agents-drag__task" draggable data-task-id={row.id}
                  onDragStart={(event) => { event.dataTransfer.setData(TASK_DRAG, row.id); event.dataTransfer.effectAllowed = 'move'; }}>
                  <StatusGlyph status={row.status} size={14} /><span className="ui-task-number">#{row.number}</span><span className="agents-drag__title">{row.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <Link className="agents-link agents-link--connect" to="/connect-agent"><span className="agents-link__icon"><Icon name="plus" size={16} /></span><span className="agents-link__text">Connect your own agent</span><span className="agents-link__go">Local MCP<Icon name="chevron-right" size={14} /></span></Link>
      </div>
      {slot ? (task ? (
        <OwnedPanelContent slot={slot} className="agents-thread-panel">
          <PanelMeta>{`#${task.number}`}</PanelMeta>
          <h3 className="agents-thread__task">{task.title}</h3>
          {/* The thread's own scroller: its head stays on screen while the messages scroll (#347 N3). */}
          <div className="agents-thread-scroll">
            <TaskThread key={`${threadKind}:${me.user.id}:${projectId}:${task.id}`} kind={threadKind} task={task} projectId={projectId} meId={me.user.id} names={names} canWrite={canWrite} changingScope={changingScope} />
          </div>
        </OwnedPanelContent>
      ) : latestDetail ? (
        <OwnedPanelContent slot={slot} className="agents-detail-panel">
          <AgentDetail key={latestDetail.key} entry={latestDetail} held={heldBy(latestDetail.agentId)} meId={me.user.id} projectId={projectId} now={connections.now}
            stops={agentStops.stops.filter((item) => item.agent.id === latestDetail.agentId)} stop={leads.has(latestDetail.key) ? stopOf(latestDetail) : null}
            asking={asked.find((question) => question.agent.id === latestDetail.agentId) ?? null} refocus={refocusKey === latestDetail.key} onRefocused={() => setRefocusKey(null)}
            canHandOff={canWrite && !!shell && latestDetail.ownerId === me.user.id} onHandOff={() => setHandOff({ agentId: latestDetail.agentId, task: null })} onThread={openThread} />
        </OwnedPanelContent>
      ) : null) : null}
      {!task && wanted && choices.read.phase === 'unavailable' ? (
        <p className="agents__no-tasks" role="alert">Open tasks could not be loaded. <button type="button" className="ui-link" onClick={choices.onRefresh}>Refresh tasks</button></p>
      ) : null}
    </div>
    {shell ? (
      <HandOffDialog open={!!handOff} onClose={() => setHandOff(null)} project={shell.project} task={handOff?.task ?? null} agentId={handOff?.agentId ?? null}
        onDone={() => { choices.onRefresh(); revalidator.revalidate(); }} />
    ) : null}
    </div>
  );
}
