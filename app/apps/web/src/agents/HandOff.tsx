import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { Agent, AgentProjectPolicy, Project, ProjectAgentConnection, ProjectPerson, WorkRowProjection } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button, Icon, Kreska, MEDIA, Overlay, Sheet, agentHue, useMediaQuery, useToast, type KreskaExpression } from '../ui';
import { listProjectPeople } from '../project/data';
import { useShellData } from '../app/data';
import { updateWork, listAgents } from '../work/api';
import { getProjectWorkView } from '../work/read-api';
import { contributeToTask } from '../composer/api';
import { getAgentPolicy, getProjectAgents } from './api';
import { agentEntries, firstName, mayDo, tasksHeldBy, teammateOf, type AgentEntry } from './roster';

/** The task being handed off; `version` is the one its owner is changed from. */
export interface HandOffTask { id: string; version: number; number: number; title: string }

interface Loaded {
  people: ProjectPerson[];
  connections: ProjectAgentConnection[];
  workspaceAgents: Agent[];
  tasks: WorkRowProjection[];
  policy: AgentProjectPolicy | null;
}

/** The Kreska of an agent in the list: working only with an open session (P1-1); asleep when it holds work offline. */
const kreskaFor = (entry: AgentEntry, held: readonly WorkRowProjection[], online: boolean): KreskaExpression => {
  if (held[0]?.status === 'in_progress' && online) return 'working';
  if (entry.connection?.state === 'unavailable') return 'worried';
  if (held[0]?.status === 'in_progress') return 'asleep';
  return 'idle';
};

/**
 * What is known about an agent's load, from the tasks it owns. Working is claimed only with an open client session (P1-1);
 * an agent whose app is closed "holds" its task.
 */
export function loadLine(held: readonly WorkRowProjection[], online: boolean): string {
  const first = held[0];
  if (!first) return 'no task now';
  const working = first.status === 'in_progress';
  const queued = held.length - (working ? 1 : 0);
  const head = !online ? `holds #${first.number} · offline` : `${working ? `working on #${first.number}` : `has #${first.number}`}`;
  return `${head}${queued > 0 ? `, ${queued} more queued` : ''}`;
}

/** What a failed hand-off says to the person; shared with the Agents view's Hand back. */
export function handOffFailure(cause: unknown): string {
  return failure(cause);
}

function failure(cause: unknown): string {
  if (cause instanceof NetworkError) return 'Flux can’t be reached right now. Nothing changed; try again in a moment.';
  if (cause instanceof ApiError) {
    if (cause.code === 'VERSION_CONFLICT') return 'Someone changed this task a moment ago. Close this and try again from its latest state.';
    if (cause.code === 'OWNER_WITHOUT_ACCESS') return 'That agent no longer has access to this project, so the task wasn’t handed off.';
    if (cause.status === 403) return 'You can read this project but not change its tasks.';
    if (cause.status === 404) return 'This task is no longer available to you.';
  }
  return 'That didn’t work. Nothing changed; try again.';
}

/**
 * Hand a task to an agent in two steps (F-026 S12): choose the agent, then see what its grant lets it do
 * here and confirm. The handing is the task's owner (an existing, permission-checked change); it grants
 * nothing. An agent without access is shown with the way to give it access, never granted from here.
 * `agentId` starts at the second step (a task dropped on an agent, or an agent's own panel).
 */
export function HandOffDialog({ open, onClose, project, task, agentId = null, onDone }: {
  open: boolean; onClose: () => void; project: Pick<Project, 'id' | 'workspaceId' | 'name' | 'access'>; task?: HandOffTask | null;
  agentId?: string | null; onDone?: () => void;
}) {
  const phone = useMediaQuery(MEDIA.phone);
  const body = open ? <HandOffBody onClose={onClose} project={project} task={task ?? null} agentId={agentId} onDone={onDone} /> : null;
  return phone
    ? <Sheet open={open} onClose={onClose} label="Hand off a task">{body}</Sheet>
    : <Overlay placement="center" open={open} onClose={onClose} label="Hand off a task">{body}</Overlay>;
}

function HandOffBody({ onClose, project, task: given, agentId, onDone }: {
  onClose: () => void; project: Pick<Project, 'id' | 'workspaceId' | 'name' | 'access'>; task: HandOffTask | null; agentId: string | null; onDone?: () => void;
}) {
  const toast = useToast();
  const { me } = useShellData();
  const titleId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The bounded read's continuation: tasks past the first page are reached page by page, never as the whole project.
  const [cursor, setCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const [step, setStep] = useState<1 | 2>(agentId && given ? 2 : 1);
  const [chosen, setChosen] = useState<string | null>(agentId);
  const [taskId, setTaskId] = useState<string | null>(given?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const first = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    // The agents, who can read here, their load and the policy are one observation; a manager-only or failed read of
    // the workspace's agents just means no "without access" rows, never a failed hand-off.
    Promise.all([
      listProjectPeople(project.id, signal), getProjectAgents(project.id, signal), listAgents(project.workspaceId, signal).catch(() => [] as Agent[]),
      getProjectWorkView(project.id, { purpose: 'choices', choice: 'pivot_work' }, signal).then((page) => ({ rows: page.items.filter((row): row is WorkRowProjection => row.kind === 'work'), next: page.nextCursor })),
      getAgentPolicy(project.id, signal).then((read) => read.policy).catch(() => null),
    ]).then(([people, agents, workspaceAgents, page, policy]) => {
      if (signal.aborted) return;
      setLoaded({ people, connections: agents.connections, workspaceAgents, tasks: page.rows, policy });
      setCursor(page.next);
    }, () => { if (!signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, [project.id, project.workspaceId]);

  const humans = useMemo(() => new Map((loaded?.people ?? []).filter((person) => person.kind === 'human').map((person) => [person.id, person.name])), [loaded]);
  const entries = useMemo(() => {
    const all = loaded ? agentEntries(loaded.people, loaded.connections, loaded.workspaceAgents, humans) : [];
    // An agent with several connections is one choice: the task goes to the agent.
    return all.filter((entry, index) => all.findIndex((other) => other.agentId === entry.agentId) === index);
  }, [loaded, humans]);
  const held = (id: string) => tasksHeldBy(id, loaded?.tasks ?? []);
  const task: HandOffTask | null = given && taskId === given.id ? given : loaded?.tasks.find((row) => row.id === taskId) ?? null;
  const entry = entries.find((item) => item.agentId === chosen) ?? null;
  const grant = mayDo(entry?.access ?? null);
  // A teammate's agent is asked for, never handed work: its owner decides (#347 P1-3).
  const teammate = !!entry && teammateOf(entry, me.user.id);
  // An agent is online when one of its connections has an open session (P1-1).
  const online = (agentId: string) => !!loaded?.connections.some((connection) => connection.agent.id === agentId && connection.state === 'session_open');
  const manager = project.access === 'manager';
  const free = useMemo(() => (loaded?.tasks ?? []).filter((row) => !row.owner || row.owner.kind !== 'agent'), [loaded]);

  const append = (page: { rows: WorkRowProjection[]; next: string | null }) => {
    setLoaded((current) => current && { ...current, tasks: [...current.tasks, ...page.rows.filter((row) => !current.tasks.some((known) => known.id === row.id))] });
    setCursor(page.next);
  };
  const readPage = async (after: string, signal?: AbortSignal) => {
    const page = await getProjectWorkView(project.id, { purpose: 'choices', choice: 'pivot_work', cursor: after }, signal);
    return { rows: page.items.filter((row): row is WorkRowProjection => row.kind === 'work'), next: page.nextCursor };
  };
  const loadMore = async () => {
    if (!cursor || paging) return;
    setPaging(true); setPageFailed(false);
    try { append(await readPage(cursor)); } catch { setPageFailed(true); } finally { setPaging(false); }
  };
  // A page of tasks that all have an agent is not "no task": keep reading until one is free or the list ends.
  const reading = !!loaded && !given && !!cursor && !free.length && !pageFailed;
  useEffect(() => {
    if (!reading || !cursor) return undefined;
    const controller = new AbortController();
    readPage(cursor, controller.signal).then((page) => { if (!controller.signal.aborted) append(page); }, () => { if (!controller.signal.aborted) setPageFailed(true); });
    return () => controller.abort();
    // One read per cursor; the helpers only close over the project and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, cursor]);

  // Focus follows the step so keyboard use never starts on the dialog's edge.
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, [step, loaded]);

  const ask = async () => {
    if (!task || !entry || busy) return;
    const key = `ask:${task.id}:${entry.agentId}`;
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await contributeToTask(task.id, { body: `@${entry.owner} can your ${entry.name} take #${task.number} · ${task.title}?`, clientMessageId: attempt.current.id, kind: 'text' });
      attempt.current = null;
      toast({ message: `Asked ${firstName(entry.owner ?? 'them')} about #${task.number}`, tone: 'success' });
      onClose();
      onDone?.();
    } catch (cause) {
      setError(failure(cause));
      if (cause instanceof ApiError) attempt.current = null;
    } finally { setBusy(false); }
  };

  const submit = async () => {
    if (teammate) return ask();
    if (!task || !entry || !grant.canTake || busy) return;
    const key = `${task.id}:${task.version}:${entry.agentId}`;
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await updateWork(task, { owner: { kind: 'agent', id: entry.agentId } }, attempt.current.id);
      attempt.current = null;
      toast({ message: `Handed #${task.number} to ${entry.name}`, tone: 'success' });
      onClose();
      onDone?.();
    } catch (cause) {
      setError(failure(cause));
      if (cause instanceof ApiError) attempt.current = null;
    } finally { setBusy(false); }
  };

  const next = (event: FormEvent) => {
    event.preventDefault();
    if (step === 1) { if (chosen && task) setStep(2); } else void submit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (step === 2) void submit(); else if (chosen && task) setStep(2); }
  };

  const status = !loaded ? (loadFailed ? 'Agents couldn’t be loaded.' : 'Loading agents…') : null;
  const ready = !!task && !!entry && (teammate || grant.canTake);

  return (
    <form className="handoff" aria-labelledby={titleId} onSubmit={next} onKeyDown={onKeyDown} data-step={step}>
      <header className="handoff__head">
        <span className="handoff__step">Step {step} of 2</span>
        <span className="handoff__what">{task ? <>{teammate && step === 2 ? 'Ask about' : 'Hand off'} <span className="ui-task-number">#{task.number}</span> · {task.title}</> : 'Hand off a task'}</span>
        <button type="button" className="handoff__close" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
      </header>
      <div className="handoff__body">
        {step === 1 ? (
          <>
            <h2 className="handoff__title" id={titleId}>Who should do it?</h2>
            {given ? null : (
              <div className="handoff__task">
                <label htmlFor={`${titleId}-task`}>Task</label>
                <select id={`${titleId}-task`} ref={(node) => { if (!entry) first.current = node; }} value={taskId ?? ''} disabled={!loaded || !free.length} onChange={(event) => setTaskId(event.target.value || null)}>
                  <option value="">{loaded && !free.length && !cursor ? 'No open task without an agent' : paging || reading ? 'Reading tasks…' : 'Choose a task'}</option>
                  {free.map((row) => <option key={row.id} value={row.id}>#{row.number} · {row.title}</option>)}
                </select>
                {cursor && free.length ? <Button variant="quiet" busy={paging} onClick={() => void loadMore()}>More tasks</Button> : null}
              </div>
            )}
            {pageFailed ? <p className="handoff__note" role="alert">More tasks couldn’t be read. <button type="button" className="ui-link" onClick={() => { setPageFailed(false); void loadMore(); }}>Try again</button></p> : null}
            {status ? <p className="handoff__note" role="status">{status}</p> : null}
            {loaded && !entries.length ? <p className="handoff__note">No agents are connected here yet. {manager ? 'Connect one first.' : 'Ask a project manager to connect one.'} <Link className="ui-link" to="/connect-agent">Connect an agent</Link></p> : null}
            <div className="handoff__list" role="radiogroup" aria-label="Agent">
              {entries.map((item, index) => {
                const busyWith = held(item.agentId);
                const note = item.access === null ? 'no access here yet' : loadLine(busyWith, online(item.agentId));
                const asks = teammateOf(item, me.user.id);
                const id = `${titleId}-${item.agentId}`;
                return (
                  <label key={item.agentId} htmlFor={id} className="handoff__agent" data-checked={chosen === item.agentId || undefined}>
                    <input id={id} type="radio" name="handoff-agent" value={item.agentId} checked={chosen === item.agentId}
                      ref={(node) => { if ((chosen ? chosen === item.agentId : index === 0) && (given || taskId)) first.current = node; }}
                      onChange={() => setChosen(item.agentId)} />
                    <Kreska size={36} expression={kreskaFor(item, busyWith, online(item.agentId))} hue={agentHue(item.agentId)} />
                    <span className="handoff__who"><b>{item.name}</b>
                      <small>{asks && item.owner ? `for ${item.owner} · ${firstName(item.owner)} decides` : [item.owner ? `for ${item.owner}` : null, item.connection?.name, note].filter(Boolean).join(' · ')}</small></span>
                    <span className="handoff__mark" aria-hidden="true">{chosen === item.agentId ? <Icon name="check" size={14} /> : null}</span>
                  </label>
                );
              })}
            </div>
          </>
        ) : (
          <>
            {teammate && entry ? (
              <>
                <h2 className="handoff__title" id={titleId}>Ask {firstName(entry.owner ?? 'them')} first</h2>
                <div className="handoff__chosen">
                  <Kreska size={36} expression="idle" hue={agentHue(entry.agentId)} />
                  <span className="handoff__who"><b>{entry.name}</b><small>{[entry.owner ? `for ${entry.owner}` : null, entry.connection?.name].filter(Boolean).join(' · ')}</small></span>
                </div>
                <p className="handoff__can">{`${entry.name} works for ${entry.owner}. Only ${entry.owner} can hand work to it. Flux will ask ${entry.owner} in the thread of #${task?.number ?? ''}.`}</p>
              </>
            ) : (
              <>
            <h2 className="handoff__title" id={titleId}>What {entry?.name ?? 'it'} may do</h2>
            {entry ? (
              <div className="handoff__chosen">
                <Kreska size={36} expression="idle" hue={agentHue(entry.agentId)} />
                <span className="handoff__who"><b>{entry.name}</b><small>{[entry.owner ? `for ${entry.owner}` : null, entry.connection?.name, entry.access ? loadLine(held(entry.agentId), online(entry.agentId)) : 'no access here yet'].filter(Boolean).join(' · ')}</small></span>
              </div>
            ) : <p className="handoff__note" role="status">{status ?? 'That agent is no longer here. Go back and choose another.'}</p>}
            {entry ? (
              <p className="handoff__can" data-allowed={grant.canTake || undefined}><b>{entry.name} will be able to</b> {grant.can}</p>
            ) : null}
            {entry && !grant.canTake ? (
              <p className="handoff__note" role="status">
                {entry.access === null ? `${entry.name} has no access to ${project.name}, so it can’t take this task.` : `${entry.name} can only read ${project.name}, so it can’t take this task.`}{' '}
                {manager ? <>You can give it access: <Link className="ui-link" to="/connect-agent">Connect an agent</Link>. Nothing is granted from here.</> : 'A project manager can give it access. Nothing is granted from here.'}
              </p>
            ) : null}
            {entry && grant.canTake && loaded?.policy ? <p className="handoff__note">The project’s agent policy (revision {loaded.policy.revision}) applies to its work.</p> : null}
            {entry && grant.canTake && held(entry.agentId).some((row) => row.status === 'in_progress') ? <p className="handoff__note">{online(entry.agentId) ? 'It is' : 'It'} {loadLine(held(entry.agentId), online(entry.agentId))}; this task is queued behind that work.</p> : null}
              </>
            )}
          </>
        )}
        {error ? <p className="handoff__error" role="alert">{error}</p> : null}
      </div>
      <footer className="handoff__foot">
        <span className="handoff__tip">Tip: drag a task onto an agent in Agents</span>
        {step === 2 ? <Button variant="secondary" onClick={() => { setStep(1); setError(''); }}>Back</Button> : <Button variant="secondary" onClick={onClose}>Cancel</Button>}
        {step === 1
          ? <Button type="submit" variant="primary" disabled={!chosen || !task}>Next</Button>
          : <Button type="submit" variant="primary" busy={busy} disabled={!ready} ref={(node) => { if (ready) first.current = node; }}>{teammate ? `Ask ${firstName(entry?.owner ?? 'them')}` : 'Hand off'}<kbd className="handoff__kbd">Ctrl ↵</kbd></Button>}
      </footer>
    </form>
  );
}
