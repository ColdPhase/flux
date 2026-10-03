import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLoaderData, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { AgentOperation, ConversationMessage, ProjectAgentConnection, ProjectAgents as ProjectAgentsData, TaskDiscussion, WorkItem } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { useComposerDraft, useComposerScope } from '../composer/draft';
import { ComposerFiles, MessageFiles } from '../composer/Files';
import { contributeToTask, getTaskDiscussion } from '../composer/api';
import { useProjectShell } from '../project/data';
import { Button, EmptyState, Icon } from '../ui';
import { STATUS_LABEL, isFinished } from '../work/format';
import { getProjectAgents } from './api';
import './agents.css';

/**
 * Agents (Studio 11.6 UI116-2, #136): a view of the project's existing work, not a second
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
};

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function when(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? time.format(date) : dayTime.format(date);
}

/** What Flux can prove about a connection; a configured or offline one never looks busy. */
function stateLine(connection: ProjectAgentConnection) {
  if (connection.state === 'session_open') return `Session open since ${when(connection.session!.startedAt)}`;
  if (connection.state === 'offline') return 'Offline';
  if (connection.state === 'unavailable') return connection.own ? 'Can’t act here now: check this agent’s project access' : 'Can’t act here now';
  return connection.own ? 'Not signed in from your client yet' : 'Not signed in yet';
}

function activityLine(connection: ProjectAgentConnection) {
  const last = connection.lastActivity;
  if (!last) return null;
  const label = OPERATION_LABEL[last.operation];
  return `Last: ${label} · ${when(last.at)}`;
}

function Connection({ connection }: { connection: ProjectAgentConnection }) {
  const activity = activityLine(connection);
  return (
    <li className="agents-conn" data-state={connection.state}>
      <span className="agents-conn__icon" aria-hidden="true"><Icon name="terminal" size={16} /></span>
      <span className="agents-conn__body">
        <span className="agents-conn__who">
          <b>{CLIENT_LABEL[connection.clientDesignation]}</b>
          <span> · {connection.owner.name}{connection.own ? ' (you)' : ''}</span>
        </span>
        <span className="agents-conn__name">{connection.name}</span>
        <span className="agents-conn__state"><span className="agents-conn__dot" aria-hidden="true" />{stateLine(connection)}</span>
        {activity ? <span className="agents-conn__activity">{activity}</span> : null}
      </span>
    </li>
  );
}

function authorName(message: ConversationMessage, names: Map<string, string>) {
  if (message.authorId === null) return `${message.author.name ?? 'Agent'}`;
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
function TaskThread({ task, projectId, meId, names, canWrite }: { task: WorkItem; projectId: string; meId: string; names: Map<string, string>; canWrite: boolean }) {
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
  const sending = composer.sending;
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
    return [...all].sort((a, b) => a.sequence - b.sequence);
  }, [discussion]);
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
    if (!canWrite || accessLost || !discussion) return;
    const command = composer.begin();
    if (!command) return;
    const active = captureScope();
    try {
      const message = await contributeToTask(task.id, { ...command, kind: 'text' });
      composer.finish(command.clientMessageId);
      if (!active()) return;
      // The sent message is on the page before the pane scrolls to it.
      flushSync(() => show((current) => current && !current.messages.some((item) => item.id === message.id) && current.root?.id !== message.id
        ? { ...current, conversationId: current.conversationId ?? message.conversationId, rootMessageId: current.rootMessageId ?? message.id,
          root: current.root ?? message, messages: [...current.messages, message] }
        : current));
      scrollPaneToEnd(end.current);
      box.current?.focus({ preventScroll: true });
    } catch (cause) { composer.finish(command.clientMessageId, cause); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  return (
    <section className="agents-thread" aria-label={`Thread of ${task.title}`}>
      <p className="agents-thread__top">Thread of this task · the same one shown in Conversation{inConversation ? <> · <Link className="ui-link" to={inConversation}>Open in Conversation</Link></> : null}</p>
      {loadError ? <p className="agents-thread__error" role="alert">{loadError} <button type="button" className="ui-link" onClick={() => reload.current()}>Try again</button></p> : null}
      {accessLost ? <p className="agents-thread__error" role="alert">You can no longer read this task. Your unsent text is kept on this device.</p> : null}
      {!discussion && !loadError ? <p className="agents-thread__empty">Loading…</p> : null}
      {discussion && !accessLost && !messages.length ? <p className="agents-thread__empty">No one has written about this task yet. The first message starts its thread.</p> : null}
      {accessLost ? null : <ol className="agents-thread__list" aria-live="polite">
        {messages.map((message) => {
          const own = message.authorId === meId;
          const agent = message.authorId === null;
          return (
            <li key={message.id} className={`agents-msg${own ? ' agents-msg--own' : ''}${agent ? ' agents-msg--agent' : ''}`}>
              <span className="agents-msg__meta">
                <b>{own ? 'You' : authorName(message, names)}</b>{agent ? <span className="agents-msg__kind"> · agent</span> : null}
                <time dateTime={message.createdAt}>{when(message.createdAt)}</time>
                {message.contribution ? <span className="agents-msg__kind"> · {message.contribution.kind}</span> : null}
              </span>
              {message.body ? <p className="agents-msg__body">{message.body}</p> : null}
              <MessageFiles files={message.files} />
            </li>
          );
        })}
      </ol>}
      {discussion?.messagePage.hasMoreBefore && !accessLost ? <p className="agents-thread__empty">Earlier messages are in the task's thread in {inConversation ? <Link className="ui-link" to={inConversation}>Conversation</Link> : 'Conversation'}.</p> : null}
      <div ref={end} />
      <form className="agents-composer" onSubmit={(event) => { void send(event); }}>
        <label className="ui-vh" htmlFor="agents-draft">Write to this task</label>
        <textarea id="agents-draft" ref={box} value={composer.draft.body} rows={2} readOnly={sending} aria-busy={sending}
          placeholder={canWrite ? 'Add to this work…' : 'You can read this task but not write to it.'} disabled={!discussion || !canWrite || accessLost}
          onChange={(event) => composer.setBody(event.target.value)} onKeyDown={onKeyDown} />
        <ComposerFiles state={composer} disabled={!discussion || !canWrite || accessLost} />
        <div className="agents-composer__row">
          <span className="agents-composer__hint">Goes to the task thread · Enter sends, Shift+Enter new line</span>
          <Button type="submit" variant="primary" icon="send" busy={sending} disabled={!composer.canSend || !discussion || !canWrite || accessLost} aria-label="Send to task">Send</Button>
        </div>
      </form>
    </section>
  );
}

export function ProjectAgents() {
  const data = useLoaderData() as ProjectAgentsData;
  const shell = useProjectShell();
  const { me } = useShellData();
  const [search, setSearch] = useSearchParams();
  const tasks = useMemo(() => (shell?.work.work ?? []).filter((item) => !item.parked && !isFinished(item)), [shell]);
  // A `?task=` that is not one of this project's tasks falls back to the first open one.
  const requested = (shell?.work.work ?? []).find((item) => item.id === search.get('task'));
  const task = requested ?? tasks[0] ?? null;
  const names = useMemo(() => new Map((shell?.people ?? []).map((person) => [person.id, person.name])), [shell]);
  const select = (id: string) => setSearch((current) => { const next = new URLSearchParams(current); next.set('task', id); return next; }, { replace: true });
  const projectId = shell?.project.id ?? data.projectId;

  // The view scrolls in its own pane like every other view, so a long thread stays reachable
  // above the sticky composer on any screen.
  return (
    <div className="pane-scroll agents-scroll">
    <div className="agents">
      <header className="agents__head">
        <h1 className="agents__title">Working together</h1>
        <Link className="ui-link agents__connect" to="/connect-agent"><Icon name="plus" size={14} />Connect my agent</Link>
      </header>
      {data.connections.length ? (
        <ul className="agents__connections" aria-label="Agent connections in this project">
          {data.connections.map((connection) => <Connection key={connection.id} connection={connection} />)}
        </ul>
      ) : (
        <EmptyState icon="terminal" title="No agents connected to this project">
          Each person can connect their own clients, such as Codex or Claude Code, and choose this project. They work on the same tasks and threads you see here.
        </EmptyState>
      )}
      {tasks.length ? (
        <>
          <div className="agents__task">
            <label className="agents__task-label" htmlFor="agents-task">Task</label>
            <select id="agents-task" value={task?.id ?? ''} onChange={(event) => select(event.target.value)}>
              {task && !tasks.some((item) => item.id === task.id) ? <option value={task.id}>{task.title}</option> : null}
              {tasks.map((item) => <option key={item.id} value={item.id}>{item.title} · {STATUS_LABEL[item.status]}</option>)}
            </select>
            {task ? <Link className="ui-link agents__open" to={`/projects/${projectId}/tasks?open=work:${task.id}`}>Open task<Icon name="chevron-right" size={12} /></Link> : null}
          </div>
          {task ? <TaskThread key={`${me.user.id}:${projectId}:${task.id}`} task={task} projectId={projectId} meId={me.user.id} names={names} canWrite={shell?.project.access !== 'viewer'} /> : null}
        </>
      ) : (
        <p className="agents__no-tasks">No open tasks. Create one in Tasks; agents and people then work on it here.</p>
      )}
    </div>
    </div>
  );
}
