import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLoaderData, useLocation, useNavigation, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { AgentOperation, AgentQuestion, AgentStop, ConversationMessage, ProjectAgentConnection, ProjectAgents as ProjectAgentsData, TaskDiscussion, WorkRowProjection, WorkStatus } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { AttachButton, ComposerFiles, MessageFiles } from '../composer/Files';
import { ConnectionLine, OutboxStatus, PendingFiles, PendingSource } from '../composer/Outbox';
import { getTaskDiscussion } from '../composer/api';
import { useProjectShell } from '../project/data';
import { AgentIdentity, AuthorFace, Button, Icon, Kreska, StatusGlyph, agentHue, useMediaQuery, type KreskaExpression } from '../ui';
import { ThreadDrawer } from '../app/ThreadDrawer';
import { useNativeOwn, useWorkChoices } from '../work/useDetailReads';
import { agentDisplayName } from '../docs/format';
import { getProjectAgents } from './api';
import { HandOffDialog, type HandOffTask } from './HandOff';
import { useAgentStops, useStopAgent } from './stop';
import { QuestionCard, WhenNoQuestion } from './QuestionCard';
import { useProjectQuestions, useQuestionList } from './questions';
import { useLatestAgentLine } from './latest';
import { agentAuthorOwner, useAgentOwners } from './owners';
import { ProjectPolicy } from './ProjectPolicy';
import { agentEntries, firstName, mayDo, shortOwner, tasksHeldBy, teammateOf, type AgentEntry } from './roster';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import './agents.css';

/** The drag data type of a task dragged onto an agent (computer only; the button does the same by keyboard and touch). */
const TASK_DRAG = 'application/x-flux-task';

/**
 * Agents (F-026 P9): one list, each agent with its owner and what it is doing now, then Requests, Policy and
 * "Connect your own agent", and one primary button, "Hand off a task". A view of the project's existing work,
 * not a second backlog or chat: each person's connections are separate entries, so Hubert's Codex and Hubert's
 * Claude Code are two rows. A task's thread (`?task=`) is its one canonical discussion.
 */
export async function projectAgentsLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectAgentsData> {
  return getProjectAgents(params.projectId!, request.signal);
}

const OPERATION_LABEL: Record<AgentOperation, string> = {
  'work.create': 'created a task', 'work.update': 'updated a task', 'result.record': 'recorded a result',
  'decision.propose': 'proposed a decision', 'map.create': 'created a map', 'map.rename': 'renamed a map',
  'map.thought.create': 'added a thought', 'map.thought.update': 'edited a thought', 'map.thought.delete': 'removed a thought',
  'map.positions.update': 'arranged the map', 'map.link.create': 'linked thoughts', 'map.link.delete': 'unlinked thoughts',
  'doc.create': 'created a doc', 'doc.update': 'edited a doc',
  'conversation.create': 'started a conversation', 'conversation.reply': 'replied in a conversation',
  'cowork.claim': 'took a task', 'cowork.renew': 'is still on a task', 'cowork.release': 'released a task', 'cowork.request': 'asked for help',
  'cowork.request.claim': 'picked up a request', 'cowork.request.respond': 'answered a request',
  'cowork.unit.create': 'set up work on a task', 'cowork.unit.complete': 'finished its work on a task',
  'cowork.unit.transfer': 'handed work on a task to another agent',
};

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function when(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? time.format(date) : dayTime.format(date);
}

/** A session past its end is offline now, even before the next read says so. */
function shownState(connection: ProjectAgentConnection, now: number): ProjectAgentConnection['state'] {
  return connection.state === 'session_open' && connection.session && Date.parse(connection.session.expiresAt) <= now ? 'offline' : connection.state;
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

function authorName(message: ConversationMessage, names: Map<string, string>) {
  if (message.authorId === null) return agentDisplayName(message.author);
  return names.get(message.authorId) ?? 'Someone';
}

/**
 * Scrolls the view's pane to its end, so the newest message sits above the sticky composer
 * (scrollIntoView would ignore the composer and leave the message under it).
 */
function scrollPaneToEnd(marker: HTMLElement | null) {
  const pane = marker?.closest<HTMLElement>('.agents-scroll');
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
async function latestThread(workId: string, shown: TaskDiscussion, signal: AbortSignal): Promise<TaskDiscussion> {
  const latest = await getTaskDiscussion(workId, { signal });
  const newestSeen = Math.max(shown.root?.sequence ?? 0, ...shown.messages.map((message) => message.sequence));
  let incoming = latest.messages;
  let page = latest;
  while (newestSeen > 0 && page.messagePage.hasMoreBefore && (page.messages[0]?.sequence ?? 0) > newestSeen + 1) {
    const before = page.messages[0]!.sequence;
    page = await getTaskDiscussion(workId, { signal, beforeSequence: before });
    if (!page.messages.length || page.messages[0]!.sequence >= before) throw new Error('Could not load the replies in between');
    incoming = mergeMessages(page.messages, incoming);
  }
  return { ...latest, root: latest.root ?? shown.root, messages: mergeMessages(shown.messages, incoming), messagePage: shown.messagePage };
}

/** Whether the reader is at the end of the pane (within a few pixels), so new messages should follow. */
function paneAtEnd(marker: HTMLElement | null) {
  const pane = marker?.closest<HTMLElement>('.agents-scroll');
  return !!pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
}

/** The task's one thread: the real first contribution as root, then its replies. */
/** The task a thread belongs to: its identity and title, from a bounded native read. */
interface ThreadTask { id: string; number: number; title: string; status: WorkStatus }

function TaskThread({ task, projectId, meId, names, canWrite, changingScope }: { task: ThreadTask; projectId: string; meId: string; names: Map<string, string>; canWrite: boolean; changingScope: boolean }) {
  const owners = useAgentOwners(useProjectShell()?.project);
  const [discussion, setDiscussion] = useState<TaskDiscussion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  // What is on the page, for merging a refetch; every change goes through `show`.
  const shown = useRef<TaskDiscussion | null>(null);
  const show = useCallback((update: (current: TaskDiscussion | null) => TaskDiscussion | null) => {
    shown.current = update(shown.current);
    setDiscussion(shown.current);
  }, []);
  const reload = useRef(() => { /* set while mounted */ });
  // Per account and task, kept across views and reloads like every other composer (#40).
  const composer = useComposerDraft(meId, projectId, `task:${task.id}`);
  const captureScope = useComposerScope(composer.key);
  const blocked = changingScope || !discussion || !canWrite || accessLost;
  // Typing (#155 AC-2) is the task thread's: the same canonical conversation as the task's thread in
  // Conversation, so a person writing in both views is one person typing. A task without a genuine first
  // contribution has no thread yet, so it has no typing scope (nothing is created to show it).
  const typing = useTyping(meId, discussion?.conversationId && !accessLost && !changingScope ? { kind: 'conversation', id: discussion.conversationId } : null, canWrite && !blocked);
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
            const next = before ? await latestThread(task.id, before, controller.signal) : await getTaskDiscussion(task.id, { signal: controller.signal });
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
            if (!before) setLoadError(cause instanceof NetworkError ? 'Flux is unreachable.' : 'This task thread could not be loaded.');
            else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403 || cause.status === 404)) setAccessLost(true);
            // Unreachable: what is shown stays; the next change, focus or resync tries again.
            return;
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
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(onVisible, 15_000);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(interval); };
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
  const inConversation = discussion?.conversationId && !accessLost ? `/projects/${discussion.projectId}/conversations/${discussion.conversationId}` : null;

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
    flushSync(() => show((current) => current && !current.messages.some((item) => item.id === message.id) && current.root?.id !== message.id
      ? { ...current, conversationId: current.conversationId ?? message.conversationId, rootMessageId: current.rootMessageId ?? message.id,
        root: current.root ?? message, messages: [...current.messages, message] }
      : current));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  return (
    <section className="agents-thread" data-empty={discussion && !messages.length && !outbox.pending.length && !accessLost ? 'true' : undefined} aria-label={`Thread of ${task.title}`}>
      <p className="agents-thread__top">Thread of this task · the same one shown in Conversation{inConversation ? <> · <Link className="ui-link" to={inConversation}>Open in Conversation</Link></> : null}</p>
      {loadError ? <p className="agents-thread__error" role="alert">{loadError} <button type="button" className="ui-link" onClick={() => reload.current()}>Try again</button></p> : null}
      {accessLost ? <p className="agents-thread__error" role="alert">You can no longer read this task. Your unsent text is kept on this device.</p> : null}
      {!discussion && !loadError ? <p className="agents-thread__empty">Loading…</p> : null}
      {discussion && !accessLost && !messages.length && !outbox.pending.length ? <p className="agents-thread__empty">No one has written about this task yet. The first message starts its thread.</p> : null}
      {accessLost ? null : <ol className="agents-thread__list" aria-live="polite">
        {[...messages.map((message) => {
          const own = message.authorId === meId;
          const agent = message.authorId === null;
          const name = authorName(message, names);
          return (
            // A confirmed message keeps its queued item, so nothing moves or is announced twice (#264).
            <li key={outbox.keyOf(message.id)} data-message-id={message.id} className={`agents-msg${own ? ' agents-msg--own' : ''}${agent ? ' agents-msg--agent' : ''}`}>
              <AuthorFace kind={agent ? 'agent' : 'human'} name={name} mine={own} />
              <span className="agents-msg__meta">
                {agent ? <AgentIdentity name={name} owner={message.author.kind === 'agent' ? agentAuthorOwner(message.author, owners) : undefined} icon={false} /> : <b>{name}{own ? ' · you' : ''}</b>}
                <time dateTime={message.createdAt}>{when(message.createdAt)}</time>
                {message.contribution ? <span className="agents-msg__kind"> · {message.contribution.kind}</span> : null}
              </span>
              {message.body ? <WhenNoQuestion projectId={projectId} messageId={message.id}><p className="agents-msg__body">{message.body}</p></WhenNoQuestion> : null}
              <QuestionCard projectId={projectId} messageId={message.id} meId={meId} writable={canWrite} />
              <MessageFiles files={message.files} />
            </li>
          );
        }), ...outbox.pending.map((item) => (
          <li key={`pending-${item.id}`} id={`pending-${item.id}`} data-client-message-id={item.id} data-send-state={item.state}
            className={`agents-msg agents-msg--own is-pending${item.state === 'failed' ? ' is-failed-send' : ''}`}>
            <AuthorFace kind="human" name={names.get(meId) ?? 'Someone'} mine />
            {/* "Sending…" stands where the stored message's time will be, so it takes that message's exact space. */}
            <span className="agents-msg__meta"><b>{names.get(meId) ?? 'Someone'} · you</b>{item.state === 'sending' || item.state === 'uploading' ? <OutboxStatus inline item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} /> : null}</span>
            {item.body ? <p className="agents-msg__body">{item.body}</p> : null}
            <PendingFiles files={item.files} />
            <PendingSource item={item} />
            {item.state === 'sending' || item.state === 'uploading' ? null : <OutboxStatus item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />}
          </li>
        ))]}
      </ol>}
      {discussion?.messagePage.hasMoreBefore && !accessLost ? <p className="agents-thread__empty">Earlier messages are in the task's thread in {inConversation ? <Link className="ui-link" to={inConversation}>Conversation</Link> : 'Conversation'}.</p> : null}
      <div ref={end} />
      <form className="agents-composer" onSubmit={(event) => { void send(event); }}>
        {canWrite ? <ConnectionLine /> : null}
        <label className="ui-vh" htmlFor="agents-draft">Write to this task</label>
        <textarea id="agents-draft" ref={box} value={composer.draft.body} rows={2} readOnly={changingScope} aria-busy={changingScope}
          placeholder={canWrite ? 'Add to this work…' : 'You can read this task but not write to it.'} disabled={blocked}
          onChange={(event) => { if (!blocked) { composer.setBody(event.target.value); typing.input(Boolean(event.target.value.trim())); } }} onBlur={typing.stop} onKeyDown={onKeyDown} />
        <ComposerFiles state={composer} disabled={blocked} attach="none" />
        {discussion?.conversationId && !accessLost ? <TypingNotice {...typing} /> : null}
        {changingScope ? <p className="agents-composer__hint" role="status">Opening your selection… Your current draft is kept.</p> : null}
        <div className="agents-composer__row">
          <AttachButton state={composer} disabled={blocked} />
          <span className="agents-composer__hint">Goes to the task thread<span className="composer__keys"> · Enter sends, Shift+Enter new line</span></span>
          <Button type="submit" variant="primary" icon="send" disabled={!composer.canSend || blocked} aria-label="Send to task">Send</Button>
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
 * `now` too, so a session past its end reads as offline, and keeps "Last: …" current.
 */
function useConnections(projectId: string, meId: string, initial: ProjectAgentConnection[]) {
  // A newer read replaces the loader's list until the loader itself reads again.
  const [fetched, setFetched] = useState<{ base: ProjectAgentConnection[]; list: ProjectAgentConnection[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reload = useRef<() => void>(() => { /* not mounted */ });
  useEffect(() => {
    let controller: AbortController | null = null;
    reload.current = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      getProjectAgents(projectId, current.signal)
        .then((next) => { if (!current.signal.aborted) { setFetched({ base: initial, list: next.connections }); setNow(Date.now()); } })
        .catch(() => { /* keep the last known list; the next trigger retries */ });
    };
    return () => { controller?.abort(); reload.current = () => { /* unmounted */ }; };
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
  return { list: fetched && fetched.base === initial ? fetched.list : initial, now };
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

/** What a row says, its Kreska, whether it is working (live, on an in-progress task) and its place in the list. */
interface RowView { line: ReactNode; expression: KreskaExpression; working: boolean; rank: number }

/**
 * A row's second line (P1-1, P2-1), first match wins: the agent's open question to you; its in-progress task (working only
 * with an open client session); its blocked or open task; its recent stop; else what Flux can prove about the connection.
 * Only the agent's lead row (its first online connection, else its first row) speaks for its held task and questions.
 */
function rowView(entry: AgentEntry, held: WorkRowProjection[], lead: boolean, now: number, stopped: AgentStop | null, asking: AgentQuestion | null): RowView {
  const connection = entry.connection;
  const task = lead ? held[0] : undefined;
  const base: KreskaExpression = connection ? connectionExpression(connection, now) : 'idle';
  if (lead && asking) return { line: `Waiting for you · asks “${briefly(asking.question)}”`, expression: 'waiting', working: false, rank: 1 };
  if (task?.status === 'in_progress' && isOnline(connection, now)) {
    return { line: `Working on #${task.number} · ${task.title}`, expression: 'working', working: true, rank: 2 };
  }
  if (task?.status === 'in_progress') {
    const rank = connectionRank(connection, now);
    if (rank === 7) return { line: `Not signed in yet · #${task.number} is waiting for it`, expression: 'asleep', working: false, rank };
    if (rank === 8) return { line: `Can’t act here now · holds #${task.number}`, expression: 'worried', working: false, rank };
    const seen = connection?.lastActivity ? ` · last seen ${when(connection.lastActivity.at)}` : '';
    return { line: `Offline · holds #${task.number}${seen}`, expression: 'asleep', working: false, rank };
  }
  if (task?.status === 'blocked') {
    return { line: <><StatusGlyph status="blocked" size={12} />{` Blocked on #${task.number}${task.blocker ? ` · ${task.blocker}` : ''}`}</>, expression: base, working: false, rank: 3 };
  }
  if (task?.status === 'open') return { line: `Has #${task.number}, not started`, expression: base, working: false, rank: 4 };
  if (lead && !held.length && stopped && now - Date.parse(stopped.stoppedAt) < STOPPED_SHOWN_MS) {
    return { line: `Stopped by ${stopped.stoppedBy.name} · #${stopped.taskNumber}`, expression: base, working: false, rank: connectionRank(connection, now) };
  }
  if (!connection) return { line: entry.access === 'viewer' ? 'Can read here · nothing handed to it' : 'Nothing handed to it', expression: 'idle', working: false, rank: 7 };
  return { line: stateLine(connection, now), expression: base, working: false, rank: connectionRank(connection, now) };
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

function AgentRow({ entry, view, duplicate, short, now, selected, dropping, stop, onOpen, onDropTask, onDropping }: {
  entry: AgentEntry; view: RowView; duplicate: boolean; short: string | null; now: number; selected: boolean; dropping: boolean;
  stop: RowStop | null; onOpen: () => void; onDropTask: (taskId: string) => void; onDropping: (on: boolean) => void;
}) {
  const last = entry.connection?.lastActivity;
  // Two connections of one agent are told apart by client and connection; the meta then starts with the agent's name (P2-6).
  const title = duplicate && entry.via ? entry.via : entry.name;
  const owner = entry.owner ? (
    <><span className="agents-row__owner">for {entry.owner}</span><span className="agents-row__owner-short">for {short}</span></>
  ) : null;
  return (
    <li className="agents-row" data-agent={entry.agentId} data-state={entry.connection ? shownState(entry.connection, now) : undefined} data-working={view.working || undefined} data-drop={dropping || undefined}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(TASK_DRAG)) { event.preventDefault(); onDropping(true); } }}
      onDragLeave={() => onDropping(false)}
      onDrop={(event) => { const id = event.dataTransfer.getData(TASK_DRAG); onDropping(false); if (id) { event.preventDefault(); onDropTask(id); } }}>
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
        </span>
        {last ? <time className="agents-row__time" dateTime={last.at}>{when(last.at)}</time> : null}
        <Icon name="chevron-right" size={14} className="agents-row__go" />
      </button>
      {stop ? <StopButton className="agents-row__stop" label={stop.label} text={stop.text} busy={stop.busy} onClick={stop.run} /> : null}
    </li>
  );
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The panel's note on a task in progress, by what Flux can prove about the agent's connection (P1-1). */
function progressNote(connection: ProjectAgentConnection | null, now: number): string {
  if (!connection || connection.state === 'not_signed_in') return 'In progress · not signed in yet';
  if (connection.state === 'unavailable') return 'In progress · can’t act here now';
  return shownState(connection, now) === 'session_open' ? 'In progress' : 'In progress · its app is offline';
}

/**
 * One agent in the detail panel (P9, AC-5): who owns it, what it is doing now (its latest line on the task, one tap from the
 * thread), what Flux has recorded and what its grant here lets it do. Stop ends the agent's hold on its task; Flux cannot kill
 * the agent's own program, so the panel says what was stopped, and by whom.
 */
function AgentDetail({ entry, held, meId, projectId, now, canHandOff, stops, stop, onHandOff, onClose, onThread }: {
  entry: AgentEntry; held: WorkRowProjection[]; meId: string; projectId: string; now: number; canHandOff: boolean; stops: AgentStop[];
  /** Present when this person may stop the agent's task now. */
  stop: RowStop | null; onHandOff: () => void; onClose: () => void; onThread: (taskId: string) => void;
}) {
  const task = held[0];
  const last = entry.connection?.lastActivity;
  const grant = mayDo(entry.access);
  const latest = useLatestAgentLine(task?.id ?? null, entry.agentId);
  const teammate = teammateOf(entry, meId);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [entry.key]);
  return (
    <aside className="agents-detail" aria-label={`${entry.name}, details`}>
      <div className="agents-detail__bar">
        <button type="button" className="agents-detail__back" onClick={onClose}><Icon name="chevron-left" size={14} />Agents</button>
      </div>
      <header className="agents-detail__head">
        <Kreska size={40} expression={task?.status === 'in_progress' && isOnline(entry.connection, now) ? 'working' : entry.connection ? connectionExpression(entry.connection, now) : 'idle'} hue={agentHue(entry.agentId)} />
        <div>
          <h2 className="agents-detail__name" ref={heading} tabIndex={-1}><AgentIdentity name={entry.name} icon={false} /></h2>
          <p className="agents-detail__for">{[entry.owner ? `for ${entry.owner}` : null, entry.via, entry.connection ? 'local MCP' : null].filter(Boolean).join(' · ')}</p>
        </div>
      </header>
      <section className="agents-detail__now" aria-label="Now">
        <h3>Now</h3>
        {task ? (
          <>
            <button type="button" className="agents-detail__card" aria-label={`Open the thread of #${task.number}`} onClick={() => onThread(task.id)}>
              <span className="agents-detail__task"><StatusGlyph status={task.status} size={14} /><span className="ui-task-number">#{task.number}</span><span className="agents-detail__tasktitle">{task.title}</span></span>
              {latest === undefined ? null : <span className="agents-detail__latest">{latest ? latest.body : 'No message from it on this task yet.'}</span>}
              {latest ? <span className="agents-detail__at">Last update {when(latest.at)}</span> : null}
            </button>
            <p className="agents-detail__note">{task.status === 'in_progress' ? progressNote(entry.connection, now) : 'Handed to it, not started'}{held.length > 1 ? ` · ${held.length - 1} more` : ''} · <Link className="ui-link" to={`/projects/${projectId}/tasks?open=work:${task.id}`}>Open task</Link></p>
          </>
        ) : <p className="agents-detail__note">{entry.connection ? stateLine(entry.connection, now) : 'Nothing is handed to it.'}</p>}
      </section>
      <section aria-label="Recent">
        <h3>Recent</h3>
        {last || held.length > 1 || stops.length ? (
          <ul className="agents-detail__recent">
            {stops.slice(0, 3).map((item) => <li key={item.id} data-stop={item.id}><span>Stopped by {item.stoppedBy.name} · <span className="ui-task-number">#{item.taskNumber}</span></span><time dateTime={item.stoppedAt}>{when(item.stoppedAt)}</time></li>)}
            {last ? <li><span>{sentence(OPERATION_LABEL[last.operation])}</span><time dateTime={last.at}>{when(last.at)}</time></li> : null}
            {held.slice(1).map((row) => <li key={row.id}><button type="button" className="agents-detail__thread" onClick={() => onThread(row.id)}>Also holds #{row.number} · {row.title}</button></li>)}
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
      {stop && task ? <p className="agents-detail__note">{`Stop ends ${entry.name}’s hold on #${task.number}.`}{entry.connection ? ` Its app on ${entry.connection.name} may keep running.` : ''}</p> : null}
    </aside>
  );
}

/** A question's Requests line target: its task's thread in this view, else its conversation. */
const questionLink = (projectId: string, question: AgentQuestion) => question.taskId
  ? `/projects/${projectId}/agents?task=${question.taskId}`
  : `/projects/${projectId}/conversations/${question.conversationId}`;

export function ProjectAgents() {
  const data = useLoaderData() as ProjectAgentsData;
  const shell = useProjectShell();
  const { me } = useShellData();
  const location = useLocation();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [search, setSearch] = useSearchParams();
  const projectId = shell?.project.id ?? data.projectId;
  // Open, unparked tasks come one bounded native page at a time (#155), never the whole project.
  const choices = useWorkChoices(me.user.id, projectId, { purpose: 'choices', choice: 'pivot_work' });
  const rows = useMemo(() => (choices.page?.items ?? []).filter((row): row is WorkRowProjection => row.kind === 'work'), [choices.page]);
  const tasks = useMemo<ThreadTask[]>(() => rows.map((row) => ({ id: row.id, number: row.number, title: row.title, status: row.status })), [rows]);
  // A `?task=` outside this page is read by itself; one that is not this project's task (or
  // cannot be read) falls back to the first open one.
  const wanted = search.get('task');
  const onPage = tasks.find((item) => item.id === wanted) ?? null;
  const own = useNativeOwn(me.user.id, projectId, 'work', wanted && !onPage ? wanted : undefined);
  const ownTask = own.value?.object.kind === 'work' && own.value.object.id === wanted && own.value.object.projectId === projectId
    ? { id: own.value.object.id, number: own.value.object.number, title: own.value.object.title, status: own.value.object.status } : null;
  // While that read (or the first page) is still on its way, nothing is chosen yet, so a
  // thread never opens on a fallback task and then jumps.
  const settling = (!!wanted && !onPage && (own.read.phase === 'loading' || !choices.page)) || (!wanted && !choices.page);
  // The thread is open only for a `?task=`; there is no task picker and no thread under the list.
  const task = wanted && !settling ? onPage ?? ownTask ?? tasks[0] ?? null : null;
  const names = useMemo(() => new Map((shell?.people ?? []).map((person) => [person.id, person.name])), [shell]);
  const changingScope = navigation.state !== 'idle' && !!navigation.location
    && (navigation.location.pathname !== location.pathname || navigation.location.search !== location.search);
  const connections = useConnections(projectId, me.user.id, data.connections);
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
  const listed = useMemo(() => agentEntries(shell?.people ?? null, sortedConnections), [shell?.people, sortedConnections]);
  const heldBy = (agentId: string) => tasksHeldBy(agentId, rows);
  const lastStopOf = (agentId: string) => agentStops.stops.find((item) => item.agent.id === agentId) ?? null;
  const leads = useMemo(() => leadKeys(listed, connections.now), [listed, connections.now]);
  const views = new Map(listed.map((entry) => [entry.key, rowView(entry, heldBy(entry.agentId), leads.has(entry.key), connections.now,
    lastStopOf(entry.agentId), asked.find((question) => question.agent.id === entry.agentId) ?? null)]));
  // The list is ordered by what needs the person first (P2-1); ties keep the order above.
  const entries = [...listed].sort((a, b) => views.get(a.key)!.rank - views.get(b.key)!.rank);
  const beside = useMediaQuery('(min-width: 1001px)');
  // From an agent's panel a thread opens as a step forward: on a narrow pane the panel (which hides the list and
  // the thread) is left, and Back returns to it.
  const openThread = (id: string) => setSearch((current) => {
    const next = new URLSearchParams(current); next.set('task', id);
    if (!beside) next.delete('agent');
    return next;
  }, { replace: beside, flushSync: true });
  const closeThread = () => setSearch((current) => { const next = new URLSearchParams(current); next.delete('task'); return next; }, { replace: true });
  // Stop, or Take back, is offered to who the server lets stop: a manager and the agent's owner (the task's creator is told by the server).
  const stopOf = (entry: AgentEntry): RowStop | null => {
    const held = heldBy(entry.agentId)[0];
    if (!held || !canWrite || !(shell?.project.access === 'manager' || entry.ownerId === me.user.id)) return null;
    const busy = stopper.busy === `${entry.agentId}:${held.id}`;
    const inProgress = held.status === 'in_progress';
    return {
      label: inProgress ? `Stop ${entry.name}` : `Take back #${held.number}`,
      text: inProgress ? 'Stop' : `Take back #${held.number}`,
      busy,
      // Hand back is offered for an agent this person owns (or a workspace agent), never a teammate's (P1-3).
      run: () => { void stopper.stop(entry.agentId, held, entry.name, entry.ownerId === null || entry.ownerId === me.user.id); },
    };
  };
  const working = [...views.values()].filter((view) => view.working).length;
  const waiting = [...views.values()].filter((view) => view.rank === 1).length;
  const picked = search.get('agent');
  // Where the panel fits beside the list it is open from the start, on the working agent as drawn; narrow panes open it by choice.
  const selected = entries.find((entry) => entry.key === picked) ?? (beside ? entries.find((entry) => views.get(entry.key)?.working) ?? entries[0] ?? null : null);
  const open = (key: string | null) => setSearch((current) => { const next = new URLSearchParams(current); if (key) next.set('agent', key); else next.delete('agent'); return next; }, { replace: true });

  const [handOff, setHandOff] = useState<{ agentId: string | null; task: HandOffTask | null } | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  // `?policy=open` opens the policy (a link to it, and where a reload leaves a reader who had it open).
  const [policyOpen, setPolicyOpen] = useState(search.get('policy') === 'open');
  const dropTask = (agentId: string, taskId: string) => {
    const row = rows.find((item) => item.id === taskId);
    if (row) setHandOff({ agentId, task: { id: row.id, version: row.version, number: row.number, title: row.title } });
  };
  const canOpenThread = !!task;
  const threadPane = (mode: 'docked' | 'sheet') => task ? (
    <ThreadDrawer mode={mode} focusOnOpen={false} title={`#${task.number} · ${task.title}`} closeLabel="Close thread" onClose={closeThread}>
      <TaskThread key={`${me.user.id}:${projectId}:${task.id}`} task={task} projectId={projectId} meId={me.user.id} names={names} canWrite={canWrite} changingScope={changingScope} />
    </ThreadDrawer>
  ) : null;
  const latestDetail = selected;
  const requests = asked[0] ?? null;

  // The view scrolls in its own pane like every other view, so a long thread stays reachable
  // above the sticky composer on any screen.
  return (
    <div className="pane-scroll agents-scroll">
    <div className="agents" data-detail={beside ? (latestDetail || canOpenThread ? 'open' : undefined) : (latestDetail && !canOpenThread ? 'open' : undefined)}
      data-thread-open={canOpenThread ? 'true' : undefined}>
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
                dropping={dropping === entry.key} stop={leads.has(entry.key) ? stopOf(entry) : null} onOpen={() => open(entry.key)}
                onDropTask={(id) => dropTask(entry.agentId, id)} onDropping={(on) => setDropping((current) => on ? entry.key : current === entry.key ? null : current)} />
            ))}
          </ul>
        ) : (
          <p className="agents__no-connections">No agents here yet. Connect one below; people can still discuss tasks in Conversation.</p>
        )}
        <ul className="agents-links">
          <li><Link className="agents-link" to={requests ? questionLink(projectId, requests) : '/inbox'}>
            <span className="agents-link__icon"><Icon name="inbox" size={16} /></span>
            <span className="agents-link__text">
              {requests ? <>{asked.length > 1 ? <b>Requests</b> : <b>Request</b>} · {requests.agent.name} asks: “{briefly(requests.question)}”</> : <><b>Requests</b> · No requests for you</>}
            </span>
            {asked.length ? <span className="agents-link__count">{asked.length}</span> : null}
            <Icon name="chevron-right" size={14} />
          </Link></li>
          <li><button type="button" className="agents-link" aria-expanded={policyOpen} aria-controls="agents-policy" onClick={() => setPolicyOpen((value) => !value)}>
            <span className="agents-link__icon"><Icon name="rule" size={16} /></span><span className="agents-link__text"><b>Project policy</b> · rules agents read before they plan</span><span className="agents-link__go">{policyOpen ? 'Hide' : shell?.project.access === 'manager' ? 'Edit' : 'Read'}<Icon name="chevron-right" size={14} /></span></button></li>
        </ul>
        {policyOpen ? (
          <div id="agents-policy">
            <ProjectPolicy key={projectId} projectId={projectId} meId={me.user.id} canEdit={shell?.project.access === 'manager'}
              managers={(shell?.people ?? []).filter((person) => person.kind === 'human' && person.access === 'manager').map((person) => person.name)} />
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
      {task && beside ? (
        <section className="agents-thread-pane" aria-label={`#${task.number} · ${task.title}`}>{threadPane('docked')}</section>
      ) : latestDetail && !canOpenThread ? (
        <AgentDetail key={latestDetail.key} entry={latestDetail} held={heldBy(latestDetail.agentId)} meId={me.user.id} projectId={projectId} now={connections.now}
          stops={agentStops.stops.filter((item) => item.agent.id === latestDetail.agentId)} stop={leads.has(latestDetail.key) ? stopOf(latestDetail) : null}
          canHandOff={canWrite && !!shell} onHandOff={() => setHandOff({ agentId: latestDetail.agentId, task: null })} onClose={() => open(null)} onThread={openThread} />
      ) : null}
      {task && !beside ? (
        <section className="agents-thread-sheet" aria-label={`#${task.number} · ${task.title}`}>{threadPane('sheet')}</section>
      ) : null}
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
