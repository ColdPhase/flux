import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLoaderData, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { AgentOperation, ConversationMessage, ProjectAgentConnection, ProjectAgents as ProjectAgentsData, TaskDiscussion, WorkItem } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useShellData } from '../app/data';
import { useProjectShell } from '../project/data';
import { Button, EmptyState, Icon } from '../ui';
import { STATUS_LABEL, isFinished } from '../work/format';
import { contributeToTask, getProjectAgents, getTaskDiscussion } from './api';
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

const OPERATION_LABEL: Partial<Record<AgentOperation, string>> = {
  'work.create': 'created a task', 'work.update': 'updated a task', 'result.record': 'recorded a result',
  'decision.propose': 'proposed a decision',
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
  return connection.own ? 'Not signed in from your client yet' : 'Not signed in yet';
}

function activityLine(connection: ProjectAgentConnection) {
  const last = connection.lastActivity;
  if (!last) return null;
  const label = OPERATION_LABEL[last.operation] ?? last.operation.replace(/[._]/g, ' ');
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

const DRAFT_KEY = (workId: string) => `flux.task-draft.${workId}`;
function readDraft(workId: string) {
  try { return sessionStorage.getItem(DRAFT_KEY(workId)) ?? ''; } catch { return ''; }
}
function writeDraft(workId: string, text: string) {
  try { if (text) sessionStorage.setItem(DRAFT_KEY(workId), text); else sessionStorage.removeItem(DRAFT_KEY(workId)); } catch { /* private mode */ }
}

function authorName(message: ConversationMessage, names: Map<string, string>) {
  if (message.authorId === null) return `${message.author.name ?? 'Agent'}`;
  return names.get(message.authorId) ?? 'Someone';
}

/** The task's one thread: the real first contribution as root, then its replies. */
function TaskThread({ task, meId, names }: { task: WorkItem; meId: string; names: Map<string, string> }) {
  const [discussion, setDiscussion] = useState<TaskDiscussion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => readDraft(task.id));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // One client message id per submitted text: a retry of the same text never posts twice.
  const pending = useRef<{ body: string; id: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // Keyed by task id: a different task mounts a fresh thread with its own draft.
  useEffect(() => {
    const controller = new AbortController();
    getTaskDiscussion(task.id, controller.signal).then(setDiscussion).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof NetworkError ? 'Flux is unreachable. Try again.' : 'This task thread could not be loaded.');
    });
    return () => controller.abort();
  }, [task.id]);

  const messages = useMemo(() => {
    if (!discussion) return [];
    const all = discussion.root ? [discussion.root, ...discussion.messages.filter((item) => item.id !== discussion.root!.id)] : discussion.messages;
    return [...all].sort((a, b) => a.sequence - b.sequence);
  }, [discussion]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    if (!pending.current || pending.current.body !== body) pending.current = { body, id: crypto.randomUUID() };
    setSending(true); setSendError(null);
    try {
      const message = await contributeToTask(task.id, { body, clientMessageId: pending.current.id, kind: 'text' });
      pending.current = null;
      setDraft(''); writeDraft(task.id, '');
      setDiscussion((current) => current && !current.messages.some((item) => item.id === message.id) && current.root?.id !== message.id
        ? { ...current, rootMessageId: current.rootMessageId ?? message.id, root: current.root ?? message, messages: [...current.messages, message] }
        : current);
      requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'nearest' }));
    } catch (cause) {
      setSendError(cause instanceof ApiError && cause.status === 404 ? 'You can no longer write to this task.'
        : cause instanceof NetworkError ? 'Not sent: Flux is unreachable. Your text is kept; send again.' : 'Not sent. Your text is kept; send again.');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  return (
    <section className="agents-thread" aria-label={`Thread of ${task.title}`}>
      <p className="agents-thread__top">Thread of this task · the same one shown in Conversation and Tasks</p>
      {loadError ? <p className="agents-thread__error" role="alert">{loadError}</p> : null}
      {!discussion && !loadError ? <p className="agents-thread__empty">Loading…</p> : null}
      {discussion && !messages.length ? <p className="agents-thread__empty">No one has written about this task yet. The first message starts its thread.</p> : null}
      <ol className="agents-thread__list">
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
              <p className="agents-msg__body">{message.body}</p>
            </li>
          );
        })}
      </ol>
      <div ref={end} />
      <form className="agents-composer" onSubmit={(event) => { void send(event); }}>
        <label className="ui-vh" htmlFor="agents-draft">Write to this task</label>
        <textarea id="agents-draft" value={draft} rows={2} placeholder="Add to this work…" disabled={sending || !discussion}
          onChange={(event) => { setDraft(event.target.value); writeDraft(task.id, event.target.value); }} onKeyDown={onKeyDown} />
        <div className="agents-composer__row">
          <span className="agents-composer__hint">{sendError ? <span role="alert">{sendError}</span> : 'Goes to the task thread · Enter sends, Shift+Enter new line'}</span>
          <Button type="submit" variant="primary" icon="send" busy={sending} disabled={!draft.trim() || !discussion} aria-label="Send to task">Send</Button>
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
  const selectedId = search.get('task') ?? tasks[0]?.id ?? null;
  const task = (shell?.work.work ?? []).find((item) => item.id === selectedId) ?? null;
  const names = useMemo(() => new Map((shell?.people ?? []).map((person) => [person.id, person.name])), [shell]);
  const select = (id: string) => setSearch((current) => { const next = new URLSearchParams(current); next.set('task', id); return next; }, { replace: true });
  const projectId = shell?.project.id ?? data.projectId;

  return (
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
          {task ? <TaskThread key={task.id} task={task} meId={me.user.id} names={names} /> : null}
        </>
      ) : (
        <p className="agents__no-tasks">No open tasks. Create one in Tasks; agents and people then work on it here.</p>
      )}
    </div>
  );
}
