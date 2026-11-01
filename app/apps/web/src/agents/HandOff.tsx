import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { Agent, AgentProjectPolicy, Project, ProjectAgentConnection, ProjectPerson, WorkRowProjection } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button, Icon, Kreska, MEDIA, Overlay, Sheet, agentHue, useMediaQuery, useToast, type KreskaExpression, Select, Option } from '../ui';
import { listProjectPeople } from '../project/data';
import { useShellData } from '../app/data';
import { updateWork, listAgents } from '../work/api';
import { getProjectWorkView } from '../work/read-api';
import { contributeToTask } from '../composer/api';
import { getAgentPolicy, getProjectAgents } from './api';
import { createActionGrant, listActionGrants, requestAgentAccess } from '../agent-connection/api';
import type { AgentOperation, AgentStandingGrant } from '@flux/contracts';
import { agentEntries, connectionState, currentWorkLine, firstName, isAgentWorking, mayDo, tasksHeldBy, teammateOf, type AgentEntry } from './roster';
import { useSessionClock } from './useSessionClock';
import './handoff.css';

/** The task being handed off; `version` is the one its owner is changed from. */
export interface HandOffTask { id: string; version: number; number: number; title: string }

interface Loaded {
  people: ProjectPerson[];
  connections: ProjectAgentConnection[];
  workspaceAgents: Agent[];
  tasks: WorkRowProjection[];
  policy: AgentProjectPolicy | null;
}

/** The Kreska of an agent: Working only for a claimed unit on a usable live session (C-1); asleep when paused or not live. */
const kreskaFor = (entry: AgentEntry, now: number): KreskaExpression => isAgentWorking(entry, now) ? 'working'
  : entry.connection?.state === 'unavailable' ? 'worried' : entry.connection?.currentWork?.state === 'paused' || (entry.connection && connectionState(entry.connection, now) !== 'session_open') ? 'asleep' : 'idle';

/**
 * What is known about an agent's load. A live claimed unit is execution; native task ownership alone is handed work, never an
 * automatic queue (C-1). A handed task says when the agent's app is offline or not signed in (P1-1).
 */
export function loadLine(entry: AgentEntry, held: readonly WorkRowProjection[], now: number, state: 'online' | 'offline' | 'not_signed_in'): string {
  const work = entry.connection?.currentWork;
  if (work) return currentWorkLine(work, isAgentWorking(entry, now));
  const first = held[0];
  if (!first) return `${state === 'online' ? 'online' : state === 'offline' ? 'offline' : 'not signed in yet'} · no task now`;
  const where = state === 'online' ? '' : ` · ${state === 'not_signed_in' ? 'not signed in yet' : 'offline'}`;
  return `has #${first.number}${where}${held.length > 1 ? `, ${held.length - 1} more handed` : ''}`;
}

/** An agent's connection state for the load line: online only with a live session; an agent with no connection is not signed in. */
export function agentState(entry: AgentEntry, loaded: Loaded | null, now: number): 'online' | 'offline' | 'not_signed_in' {
  const connection = loaded?.connections.filter((item) => item.agent.id === entry.agentId) ?? [];
  if (connection.some((item) => connectionState(item, now) === 'session_open')) return 'online';
  if (connection.some((item) => connectionState(item, now) === 'offline')) return 'offline';
  return 'not_signed_in';
}

/**
 * What an agent needs to do a handed task (#763 FT-2): change that task and take it, then record results, talk in its thread
 * and write Wiki docs in its project. The task-specific changes name the task; all of them end after a week.
 */
const WORK_GRANTS: { operation: AgentOperation; task?: true }[] = [
  { operation: 'work.update', task: true }, { operation: 'cowork.unit.create', task: true }, { operation: 'cowork.claim' },
  { operation: 'cowork.renew' }, { operation: 'cowork.release' }, { operation: 'cowork.unit.complete' }, { operation: 'result.record' },
  { operation: 'conversation.reply' }, { operation: 'doc.create' },
];
const WORK_DAYS = 7;

/** The work grants a connection still lacks for this task: each needs a live execute grant on the task or the whole project. */
export function missingWorkGrants(grants: readonly AgentStandingGrant[], projectId: string, taskId: string, now: number) {
  const live = grants.filter((grant) => grant.projectId === projectId && !grant.revokedAt && Date.parse(grant.expiresAt) > now
    && grant.used < grant.maximumUses && grant.peerRequestClass === 'execute');
  return WORK_GRANTS.filter((need) => !live.some((grant) => grant.operation === need.operation && (grant.objectId === null || grant.objectId === taskId)));
}

/** Where an own agent stands on doing the task: ready, missing grants (one click), missing the action scope, or not connected. */
type Readiness = { kind: 'checking' } | { kind: 'ready' } | { kind: 'grants'; connectionIds: string[] } | { kind: 'scope' } | { kind: 'offline' } | { kind: 'unknown' };

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
    ? <Sheet open={open} onClose={onClose} label="Hand off a task" className="handoff-sheet"><div className="ui-grabber" aria-hidden="true"><span /></div>{body}</Sheet>
    : <Overlay placement="center" open={open} onClose={onClose} label="Hand off a task" className="handoff-dialog">{body}</Overlay>;
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
  const [observedNow, setObservedNow] = useState(() => Date.now());
  const now = useSessionClock(loaded?.connections, observedNow);
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
      setObservedNow(Date.now());
      setCursor(page.next);
    }, () => { if (!signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, [project.id, project.workspaceId]);

  const humans = useMemo(() => new Map((loaded?.people ?? []).filter((person) => person.kind === 'human').map((person) => [person.id, person.name])), [loaded]);
  const entries = useMemo(() => {
    const all = loaded ? agentEntries(loaded.people, loaded.connections, loaded.workspaceAgents, humans) : [];
    // An agent with several connections is one choice: the task goes to the agent.
    return all.filter((entry, index) => all.findIndex((other) => other.agentId === entry.agentId) === index)
      .map((entry) => all.find((other) => other.agentId === entry.agentId && isAgentWorking(other, now))
        ?? all.find((other) => other.agentId === entry.agentId && other.connection?.currentWork) ?? entry);
  }, [loaded, humans, now]);
  const empty = !!loaded && !entries.some((item) => item.access !== null);
  const held = (id: string) => tasksHeldBy(id, loaded?.tasks ?? []);
  const task: HandOffTask | null = given && taskId === given.id ? given : loaded?.tasks.find((row) => row.id === taskId) ?? null;
  const entry = entries.find((item) => item.agentId === chosen) ?? null;
  const grant = mayDo(entry?.access ?? null);
  // A teammate's agent is asked for, never handed work: its owner decides (#347 P1-3).
  const teammate = !!entry && teammateOf(entry, me.user.id);
  const manager = project.access === 'manager';
  const free = useMemo(() => (loaded?.tasks ?? []).filter((row) => !row.owner || row.owner.kind !== 'agent'), [loaded]);
  // #763 FT-2: your own agent must be able to change the task it is handed. Its connections' grants are read here (owner-only)
  // and, when they are missing, the one button below grants exactly what the task needs before handing it off.
  const own = !!entry && !teammate && entry.ownerId === me.user.id;
  const ownConnections = useMemo(() => (loaded?.connections ?? []).filter((item) => item.own && !item.assistant && item.agent.id === entry?.agentId), [loaded, entry?.agentId]);
  const [readyKey, setReadyKey] = useState(0);
  const acting = useMemo(() => ownConnections.filter((item) => item.scopes.includes('flux.action.execute')), [ownConnections]);
  const taskId2 = task?.id ?? null;
  const checkKey = step === 2 && own && grant.canTake && taskId2 && !entry?.connection?.assistant
    ? `${taskId2}:${ownConnections.map((item) => item.id).join(',')}:${readyKey}` : null;
  const [checked, setChecked] = useState<{ key: string; result: Readiness } | null>(null);
  useEffect(() => {
    if (!checkKey || !acting.length || !taskId2) return undefined;
    const controller = new AbortController();
    Promise.all(acting.map(async (item) => [item.id, missingWorkGrants(await listActionGrants(item.id, controller.signal), project.id, taskId2, Date.now()).length] as const))
      .then((rows) => {
        if (controller.signal.aborted) return;
        const lacking = rows.filter(([, missing]) => missing > 0).map(([id]) => id);
        setChecked({ key: checkKey, result: lacking.length === rows.length ? { kind: 'grants', connectionIds: lacking } : { kind: 'ready' } });
      }, () => { if (!controller.signal.aborted) setChecked({ key: checkKey, result: { kind: 'unknown' } }); });
    return () => controller.abort();
  }, [checkKey, acting, project.id, taskId2]);
  const readiness: Readiness = !checkKey ? { kind: 'unknown' } : !ownConnections.length ? { kind: 'offline' } : !acting.length ? { kind: 'scope' }
    : checked?.key === checkKey ? checked.result : { kind: 'checking' };

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
  const reading = !!loaded && !empty && !given && !!cursor && !free.length && !pageFailed;
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
      await contributeToTask(task.id, { body: `@${entry.owner} can your ${entry.name} take #${task.number} · ${task.title}? If yes, hand #${task.number} to it in Agents.`, clientMessageId: attempt.current.id, kind: 'text' });
      attempt.current = null;
      toast({ message: `Asked ${firstName(entry.owner ?? 'them')} about #${task.number}`, tone: 'success' });
      onClose();
      onDone?.();
    } catch (cause) {
      setError(failure(cause));
      if (cause instanceof ApiError) attempt.current = null;
    } finally { setBusy(false); }
  };

  // #763 FT-1: your own agent without access here can be asked in from the hand-off too.
  const [asked, setAsked] = useState(false);
  const askIn = async () => {
    if (!entry) return;
    try { await requestAgentAccess(project.id, entry.agentId, 'contributor'); setAsked(true); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === 'AGENT_ALREADY_IN_PROJECT') setAsked(true);
      else if (cause instanceof ApiError && cause.code === 'AGENT_REQUEST_DECLINED') setError('A project manager declined this a moment ago. You can ask again tomorrow.');
      else setError(failure(cause));
    }
  };

  /** Grants the task's work to each of your connections that lacks it (existing owner grant routes; retries reuse their ids). */
  const grantWork = async (connectionIds: string[]) => {
    if (!task) return;
    const ends = new Date(Date.now() + WORK_DAYS * 86_400_000).toISOString();
    for (const connectionId of connectionIds) {
      const missing = missingWorkGrants(await listActionGrants(connectionId), project.id, task.id, Date.now());
      for (const need of missing) {
        await createActionGrant(connectionId, { clientCommandId: crypto.randomUUID(), projectId: project.id, operation: need.operation,
          peerRequestClass: 'execute', ...(need.task ? { objectId: task.id } : {}), maximumUses: 100, expiresAt: ends });
      }
    }
  };

  const submit = async () => {
    if (teammate) return ask();
    if (!task || !entry || !grant.canTake || busy) return;
    if (readiness.kind === 'grants') {
      setBusy(true); setError('');
      try { await grantWork(readiness.connectionIds); }
      catch (cause) {
        setBusy(false);
        setError(cause instanceof ApiError && cause.status === 403
          ? `Flux couldn’t let ${entry.name} work here: a project manager must let it into ${project.name} first. Nothing was handed off.`
          : `Flux couldn’t let ${entry.name} change #${task.number}. Nothing was handed off; try again.`);
        setReadyKey((n) => n + 1);
        return;
      }
      setBusy(false);
    }
    const key = `${task.id}:${task.version}:${entry.agentId}`;
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      // Undo puts the owner it had back (#763 WF-6, principle 6).
      const before = loaded?.tasks.find((row) => row.id === task.id)?.owner ?? null;
      const handed = await updateWork(task, { owner: { kind: 'agent', id: entry.agentId } }, attempt.current.id);
      attempt.current = null;
      toast({ message: `Handed #${task.number} to ${entry.name}`, tone: 'success', timeout: 8000, action: { label: 'Undo', key: 'Z', onClick: () => {
        void updateWork(handed, { owner: before ? { kind: before.kind, id: before.id } : null }, crypto.randomUUID()).then(
          () => { toast({ message: `#${task.number} is back${before ? ` with ${before.kind === 'human' && before.id === me.user.id ? 'you' : before.name}` : ' without an owner'}` }); onDone?.(); },
          () => toast({ tone: 'danger', message: `#${task.number} has changed since, so it stays with ${entry.name}. Take it back in Agents.` }));
      } } });
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

  if (empty) return (
    <div className="handoff handoff--empty" aria-labelledby={titleId}>
      <header className="handoff__head">
        <span className="handoff__step">Hand off</span>
        <span className="handoff__what">{given ? <><span className="ui-task-number">#{given.number}</span> · {given.title}</> : 'Hand off a task'}</span>
        <button type="button" className="handoff__close" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
      </header>
      <div className="handoff__body handoff__empty">
        <Kreska size={56} expression="idle" />
        <h2 className="handoff__title" id={titleId}>No agents in this project yet</h2>
        <p>Connect Claude Code, Codex or your assistant once. After that, handing off a task takes two clicks.</p>
      </div>
      <footer className="handoff__foot">
        <span className="handoff__tip">The task stays yours until you hand it off.</span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Link ref={(node) => { first.current = node; }} className="ui-btn ui-btn--primary" to="/connect-agent" onClick={onClose}>Connect your own agent</Link>
      </footer>
    </div>
  );

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
                <Select id={`${titleId}-task`} ref={(node) => { if (!entry) first.current = node; }} value={taskId ?? ''} disabled={!loaded || !free.length} onChange={(next) => setTaskId(next || null)}>
                  <Option value="">{loaded && !free.length && !cursor ? 'No open task without an agent' : paging || reading ? 'Reading tasks…' : 'Choose a task'}</Option>
                  {free.map((row) => <Option key={row.id} value={row.id}>#{row.number} · {row.title}</Option>)}
                </Select>
                {cursor && free.length ? <Button variant="quiet" busy={paging} onClick={() => void loadMore()}>More tasks</Button> : null}
              </div>
            )}
            {pageFailed ? <p className="handoff__note" role="alert">More tasks couldn’t be read. <button type="button" className="ui-link" onClick={() => { setPageFailed(false); void loadMore(); }}>Try again</button></p> : null}
            {status ? <p className="handoff__note" role="status">{status}</p> : null}
            <div className="handoff__list" role="radiogroup" aria-label="Agent">
              {entries.map((item, index) => {
                const busyWith = held(item.agentId);
                const note = item.access === null ? 'no access here yet' : loadLine(item, busyWith, now, agentState(item, loaded, now));
                const asks = teammateOf(item, me.user.id);
                const id = `${titleId}-${item.agentId}`;
                return (
                  <label key={item.agentId} htmlFor={id} className="handoff__agent" data-checked={chosen === item.agentId || undefined}>
                    <input id={id} type="radio" name="handoff-agent" value={item.agentId} checked={chosen === item.agentId}
                      ref={(node) => { if ((chosen ? chosen === item.agentId : index === 0) && (given || taskId)) first.current = node; }}
                      onChange={() => setChosen(item.agentId)} />
                    <Kreska size={36} expression={kreskaFor(item, now)} hue={agentHue(item.agentId)} />
                    <span className="handoff__who"><b>{item.name}</b>
                      <small>{asks && item.owner ? `for ${item.owner} · ${firstName(item.owner)} decides · ${note}` : [item.owner ? `for ${item.owner}` : null, item.connection?.name, note].filter(Boolean).join(' · ')}</small></span>
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
                  <Kreska size={36} expression={kreskaFor(entry, now)} hue={agentHue(entry.agentId)} />
                  <span className="handoff__who"><b>{entry.name}</b><small>{[entry.owner ? `for ${entry.owner}` : null, entry.connection?.name].filter(Boolean).join(' · ')}</small></span>
                </div>
                <p className="handoff__can">{`${entry.name} works for ${entry.owner}. Only ${firstName(entry.owner ?? 'them')} can hand work to it. Flux will ask ${firstName(entry.owner ?? 'them')} in the thread of #${task?.number ?? ''}.`}</p>
              </>
            ) : (
              <>
            <h2 className="handoff__title" id={titleId}>What {entry?.name ?? 'it'} may do</h2>
            {entry ? (
              <div className="handoff__chosen">
                <Kreska size={36} expression={kreskaFor(entry, now)} hue={agentHue(entry.agentId)} />
                <span className="handoff__who"><b>{entry.name}</b><small>{[entry.owner ? `for ${entry.owner}` : null, entry.connection?.name, entry.access ? loadLine(entry, held(entry.agentId), now, agentState(entry, loaded, now)) : 'no access here yet'].filter(Boolean).join(' · ')}</small></span>
              </div>
            ) : <p className="handoff__note" role="status">{status ?? 'That agent is no longer here. Go back and choose another.'}</p>}
            {entry && own && grant.canTake && readiness.kind === 'grants' ? (
              <p className="handoff__can" data-needs-grants=""><b>{entry.name} can read {project.name}, but can’t work on #{task?.number} yet.</b>{' '}
                Allow it to change #{task?.number}, take it, record results, write in its thread and start Wiki docs here, for {WORK_DAYS} days. Nothing else changes.</p>
            ) : entry && own && grant.canTake && readiness.kind === 'scope' ? (
              <p className="handoff__can" data-needs-scope=""><b>{entry.name} can read {project.name} and suggest, but can’t change tasks.</b>{' '}
                Its connection was approved without “Run approved project actions”. Sign in to Flux again from your agent app (for Claude Code: <code>claude mcp login flux</code>) and keep that box ticked, then hand #{task?.number} off.</p>
            ) : entry ? (
              <p className="handoff__can" data-allowed={grant.canTake || undefined}><b>{entry.name} will be able to</b> {grant.can}</p>
            ) : null}
            {entry && !grant.canTake ? (
              <p className="handoff__note" role="status">
                {entry.access === null ? `${entry.name} has no access to ${project.name}, so it can’t take this task.` : `${entry.name} can only read ${project.name}, so it can’t take this task.`}{' '}
                {manager ? <>You can give it access: <Link className="ui-link" to="/connect-agent">Connect an agent</Link>. Nothing is granted from here.</>
                  : own && entry.access === null ? (asked ? `Asked a project manager to let ${entry.name} in. You’ll get a notice when they answer.`
                    : <>A project manager lets it in. <button type="button" className="ui-link" onClick={() => void askIn()}>Ask a manager to let it in</button></>)
                  : 'A project manager can give it access. Nothing is granted from here.'}
              </p>
            ) : null}
            {/* An agent that is not connected yet takes the task when it signs in (#763 WF-6). */}
            {entry && own && grant.canTake && readiness.kind === 'offline' ? <p className="handoff__note" role="status">{`${entry.name} has no connection to Flux yet, so it can’t work on #${task?.number ?? ''}. `}<Link className="ui-link" to="/settings/agents/connect">Connect it</Link>{' with “Run approved project actions”, then hand the task off.'}</p>
              : entry && grant.canTake && agentState(entry, loaded, now) !== 'online' ? <p className="handoff__note" role="status">{`${entry.name} isn’t connected right now; it picks up #${task?.number ?? ''} when it signs in.`}</p> : null}
            {entry && grant.canTake && loaded?.policy ? <p className="handoff__note">The project’s agent policy (revision {loaded.policy.revision}) applies to its work.</p> : null}
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
          : <Button type="submit" variant="primary" busy={busy} disabled={!ready || (own && readiness.kind === 'checking')} ref={(node) => { if (ready) first.current = node; }}>{teammate ? `Ask ${firstName(entry?.owner ?? 'them')}` : readiness.kind === 'grants' && own ? 'Allow and hand off' : 'Hand off'}<kbd className="handoff__kbd">Ctrl ↵</kbd></Button>}
      </footer>
    </form>
  );
}
