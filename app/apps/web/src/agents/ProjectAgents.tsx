import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLoaderData, useLocation, useNavigation, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { AgentOperation, ConversationMessage, ProjectAgentConnection, ProjectAgents as ProjectAgentsData, TaskDiscussion, WorkStatus } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { AttachButton, ComposerFiles, MessageFiles } from '../composer/Files';
import { ConnectionLine, OutboxStatus, PendingFiles, PendingSource } from '../composer/Outbox';
import { getTaskDiscussion } from '../composer/api';
import { useProjectShell } from '../project/data';
import { AgentIdentity, AuthorFace, Button, Icon, Kreska, agentHue, type KreskaExpression } from '../ui';
import { STATUS_LABEL } from '../work/format';
import { useNativeOwn, useWorkChoices } from '../work/useDetailReads';
import { WorkPagination } from '../work/WorkPagination';
import { agentDisplayName } from '../docs/format';
import { getProjectAgents } from './api';
import { agentAuthorOwner, useAgentOwners } from './owners';
import { ProjectPolicy } from './ProjectPolicy';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import './agents.css';
import { useCreateWorkFromMessage } from '../work/inline';

/**
 * Agents (UI116-2): a view of the project's existing work, not a second
 * backlog or chat. Each person's connections are listed separately, so Hubert's Codex and
 * Hubert's Claude Code are two entries. The thread is the task's one canonical discussion.
 */
export async function projectAgentsLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectAgentsData> {
  return getProjectAgents(params.projectId!, request.signal);
}

const CLIENT_LABEL: Record<ProjectAgentConnection['clientDesignation'], string> = {
  claude_code: 'Claude Code', codex: 'Codex', other: 'External client',
};

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
function stateLine(connection: ProjectAgentConnection, now: number) {
  const state = shownState(connection, now);
  if (state === 'session_open') return `Session open since ${when(connection.session!.startedAt)}`;
  if (state === 'offline') return 'Offline';
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

function activityLine(connection: ProjectAgentConnection) {
  const last = connection.lastActivity;
  if (!last) return null;
  const label = OPERATION_LABEL[last.operation];
  return `Last: ${label} · ${when(last.at)}`;
}

function Connection({ connection, now }: { connection: ProjectAgentConnection; now: number }) {
  const activity = activityLine(connection);
  return (
    <li className="agents-conn" data-state={shownState(connection, now)}>
      {/* The Agents section is where an agent's own colour shows (F-026 §2). */}
      <Kreska size={32} expression={connectionExpression(connection, now)} hue={agentHue(connection.agent.id)} className="agents-conn__icon" />
      <span className="agents-conn__body">
        <span className="agents-conn__who">
          <AgentIdentity name={CLIENT_LABEL[connection.clientDesignation]} owner={`${connection.owner.name}${connection.own ? ' (you)' : ''}`} icon={false} />
        </span>
        <span className="agents-conn__name">{connection.agent.name} · {connection.name}</span>
        <span className="agents-conn__state">{stateLine(connection, now)}</span>
        {activity ? <span className="agents-conn__activity">{activity}</span> : null}
      </span>
    </li>
  );
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
interface ThreadTask { id: string; title: string; status: WorkStatus }

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
  const makeWork = useCreateWorkFromMessage({ id: projectId });
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
              {message.body ? <p className="agents-msg__body">{message.body}</p> : null}
              <MessageFiles files={message.files} context={{ author: name, at: message.createdAt, caption: message.body, onReply: blocked ? undefined : () => box.current?.focus(), onCreateTask: canWrite && !accessLost ? () => void makeWork.create(message) : undefined }} />
              {makeWork.failed?.messageId === message.id ? <p className="agents-thread__error" role="alert">{makeWork.failed.text}</p> : null}
            </li>
          );
        }), ...outbox.pending.map((item) => (
          <li key={`pending-${item.id}`} id={`pending-${item.id}`} data-client-message-id={item.id} data-send-state={item.state}
            className={`agents-msg agents-msg--own is-pending${item.state === 'failed' ? ' is-failed-send' : ''}`}>
            <AuthorFace kind="human" name={names.get(meId) ?? 'Someone'} mine />
            {/* "Sending…" stands where the stored message's time will be, so it takes that message's exact space. */}
            <span className="agents-msg__meta"><b>{names.get(meId) ?? 'Someone'} · you</b>{item.state === 'sending' || item.state === 'uploading' ? <OutboxStatus inline item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} /> : null}</span>
            {item.body ? <p className="agents-msg__body">{item.body}</p> : null}
            <PendingFiles files={item.files} send={{ state: item.state, onRetry: () => composer.retry(item.id) }} />
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

export function ProjectAgents() {
  const data = useLoaderData() as ProjectAgentsData;
  const shell = useProjectShell();
  const { me } = useShellData();
  const location = useLocation();
  const navigation = useNavigation();
  const [search, setSearch] = useSearchParams();
  const projectId = shell?.project.id ?? data.projectId;
  // Open, unparked tasks come one bounded native page at a time (#155), never the whole project.
  const choices = useWorkChoices(me.user.id, projectId, { purpose: 'choices', choice: 'pivot_work' });
  const tasks = useMemo<ThreadTask[]>(() => (choices.page?.items ?? []).flatMap((row) => row.kind === 'work' ? [{ id: row.id, title: row.title, status: row.status }] : []), [choices.page]);
  // A `?task=` outside this page is read by itself; one that is not this project's task (or
  // cannot be read) falls back to the first open one.
  const wanted = search.get('task');
  const onPage = tasks.find((item) => item.id === wanted) ?? null;
  const own = useNativeOwn(me.user.id, projectId, 'work', wanted && !onPage ? wanted : undefined);
  const ownTask = own.value?.object.kind === 'work' && own.value.object.id === wanted && own.value.object.projectId === projectId
    ? { id: own.value.object.id, title: own.value.object.title, status: own.value.object.status } : null;
  // While that read (or the first page) is still on its way, nothing is chosen yet, so a
  // thread never opens on a fallback task and then jumps.
  const settling = (!!wanted && !onPage && (own.read.phase === 'loading' || !choices.page)) || (!wanted && !choices.page);
  const task = settling ? null : onPage ?? ownTask ?? tasks[0] ?? null;
  const names = useMemo(() => new Map((shell?.people ?? []).map((person) => [person.id, person.name])), [shell]);
  const changingScope = navigation.state !== 'idle' && !!navigation.location
    && (navigation.location.pathname !== location.pathname || navigation.location.search !== location.search);
  // The task a pending `?task=` change selects, among the choices shown (the select offers only those).
  const pendingId = changingScope && navigation.location?.pathname === location.pathname ? new URLSearchParams(navigation.location!.search).get('task') : null;
  const pendingTask = pendingId ? tasks.find((item) => item.id === pendingId) ?? (task?.id === pendingId ? task : null) : null;
  // Flush the pending navigation guard before a fast next input can reach the old keyed thread.
  const select = (id: string) => setSearch((current) => { const next = new URLSearchParams(current); next.set('task', id); return next; }, { replace: true, flushSync: true });
  const connections = useConnections(projectId, me.user.id, data.connections);

  // The view scrolls in its own pane like every other view, so a long thread stays reachable
  // above the sticky composer on any screen.
  return (
    <div className="pane-scroll agents-scroll">
    <div className="agents">
      <header className="agents__head">
        <h1 className="agents__title">Working together</h1>
        <Link className="ui-link agents__connect" to="/connect-agent"><Icon name="plus" size={14} />Connect my agent</Link>
      </header>
      {connections.list.length ? (
        <ul className="agents__connections" aria-label="Agent connections in this project">
          {connections.list.map((connection) => <Connection key={connection.id} connection={connection} now={connections.now} />)}
        </ul>
      ) : (
        <p className="agents__no-connections">No agents connected. You can still discuss tasks here.</p>
      )}
      <ProjectPolicy key={projectId} projectId={projectId} meId={me.user.id} canEdit={shell?.project.access === 'manager'}
        managers={(shell?.people ?? []).filter((person) => person.kind === 'human' && person.access === 'manager').map((person) => person.name)} />
      {task ? (
        <>
          <div className="agents__task">
            <label className="agents__task-label" htmlFor="agents-task">Task</label>
            <select id="agents-task" value={pendingTask?.id ?? task.id} onChange={(event) => select(event.target.value)}>
              {!tasks.some((item) => item.id === task.id) ? <option value={task.id}>{task.title} · {STATUS_LABEL[task.status]}</option> : null}
              {tasks.map((item) => <option key={item.id} value={item.id}>{item.title} · {STATUS_LABEL[item.status]}</option>)}
            </select>
            <Link className="ui-link agents__open" to={`/projects/${projectId}/tasks?open=work:${task.id}`}>Open task<Icon name="chevron-right" size={12} /></Link>
          </div>
          {choices.page && (choices.page.previousCursor || choices.page.nextCursor) ? <WorkPagination {...choices} label="Open task choices" noun="open tasks" /> : null}
          <TaskThread key={`${me.user.id}:${projectId}:${task.id}`} task={task} projectId={projectId} meId={me.user.id} names={names} canWrite={shell?.project.access !== 'viewer'} changingScope={changingScope} />
        </>
      ) : choices.read.phase === 'unavailable' ? (
        <p className="agents__no-tasks" role="alert">Open tasks could not be loaded. <button type="button" className="ui-link" onClick={choices.onRefresh}>Refresh tasks</button></p>
      ) : choices.page && !settling ? (
        <p className="agents__no-tasks">No open tasks. Create one in Tasks; agents and people then work on it here.</p>
      ) : null}
    </div>
    </div>
  );
}
