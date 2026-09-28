import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLoaderData, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Decision, Project, WorkItem, WorkResult } from '@flux/contracts';
import { Button, EmptyState, Icon } from '../ui';
import { getProject } from '../app/conversation-api';
import { useShellActions } from '../app/shellContext';
import { createWork, loadProjectWork, type ProjectWork } from './api';
import { STATUS_LABEL, isFinished, linked, shortDate } from './format';
import { ProjectStateLine } from './inline';
import './work.css';

interface TasksData { project: Project; lists: ProjectWork }

export async function projectTasksLoader({ params, request }: LoaderFunctionArgs): Promise<TasksData> {
  const project = await getProject(params.projectId!, request.signal);
  return { project, lists: await loadProjectWork(project.id, request.signal) };
}

function Group({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section className="ws-group" aria-labelledby={`g-${id}`}>
      <h2 className="ws-group__h" id={`g-${id}`}>{title} <span>{count}</span></h2>
      <ul className="ws-list">{children}</ul>
    </section>
  );
}

function Row({ icon, iconClass, title, sub, right, onOpen, muted }: { icon: ReactNode; iconClass?: string; title: string; sub: ReactNode; right?: ReactNode; onOpen: () => void; muted?: boolean }) {
  return (
    <li>
      <button type="button" className={`ws-item${muted ? ' ws-item--muted' : ''}`} onClick={onOpen}>
        <span className={`ws-item__st ${iconClass ?? ''}`} aria-hidden="true">{icon}</span>
        <span className="ws-item__b"><span className="ws-item__t">{title}</span><span className="ws-item__s">{sub}</span></span>
        {right ? <span className="ws-item__r">{right}</span> : null}
      </button>
    </li>
  );
}

function workSub(item: WorkItem, lists: ProjectWork) {
  const results = linked(item.links, item.id, 'result').length;
  const fromMessage = item.links.some((link) => link.from.id === item.id && link.role === 'source' && link.to.type === 'message');
  const rule = linked(item.links, item.id, 'decision')[0];
  const parkedBy = item.parked ? lists.decisions.find((decision) => decision.id === item.parked!.decisionId) : null;
  return [
    item.owner ? item.owner.name : 'No owner',
    item.status === 'blocked' && item.blocker ? `waiting for ${item.blocker}` : null,
    parkedBy ? `Parked · was ${STATUS_LABEL[item.status].toLowerCase()}` : null,
    rule && !parkedBy ? `follows “${rule.title}”` : null,
    fromMessage ? 'from a message' : null,
    results ? `${results} ${results === 1 ? 'result' : 'results'}` : null,
  ].filter(Boolean).join(' · ');
}

const dot = (kind: string) => <span className={`ws-dot ws-dot--${kind}`} />;

/** The project's Tasks tab: committed work, the rules it follows and what was learned. */
export function ProjectTasks() {
  const { project, lists } = useLoaderData() as TasksData;
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const writable = project.access !== 'viewer';
  const [title, setTitle] = useState('');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useSearchParams();

  // `?open=work:<id>` (a doc reference opened in a new tab, #112) opens that object's details.
  const open = search.get('open');
  useEffect(() => {
    const match = /^(work|decision|result):([0-9a-f-]{36})$/i.exec(open ?? '');
    if (!match) return;
    openDetails({ kind: match[1] as 'work' | 'decision' | 'result', id: match[2]! });
    setSearch((current) => { current.delete('open'); return current; }, { replace: true });
  }, [open, openDetails, setSearch]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') revalidator.revalidate(); };
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 15000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval); };
  }, [revalidator]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const item = await createWork(project.id, { title: title.trim() }, attempt);
      setTitle(''); setAttempt(crypto.randomUUID());
      revalidator.revalidate();
      openDetails({ kind: 'work', id: item.id });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the work.'); }
    finally { setBusy(false); }
  }

  const live = lists.work.filter((item) => !item.parked || isFinished(item));
  const by = (status: WorkItem['status']) => live.filter((item) => item.status === status);
  const parked = lists.work.filter((item) => item.parked && !isFinished(item));
  const finished = live.filter(isFinished);
  const proposed = lists.decisions.filter((item) => item.status === 'proposed');
  const current = lists.decisions.filter((item) => item.status === 'accepted');
  const earlier = lists.decisions.filter((item) => item.status === 'superseded');
  const openWork = (item: WorkItem) => () => openDetails({ kind: 'work', id: item.id });
  const openDecision = (item: Decision) => () => openDetails({ kind: 'decision', id: item.id });
  const openResult = (item: WorkResult) => () => openDetails({ kind: 'result', id: item.id });
  const workRow = (item: WorkItem, muted = false) => <Row key={item.id} icon={dot(item.parked ? 'parked' : item.status)} title={item.title} sub={workSub(item, lists)} right={item.owner ? <span className="ws-av" aria-hidden="true">{item.owner.name.slice(0, 1)}</span> : null} onOpen={openWork(item)} muted={muted} />;
  const nothing = !lists.work.length && !lists.decisions.length && !lists.results.length;

  return (
    <div className="pane-scroll">
      <div className="pane-in ws-tasks" data-shift>
        <ProjectStateLine lists={lists} canDecide={writable} />
        <p className="ws-audience"><Icon name="lock" size={13} />{project.name} · Everyone with project access sees this work</p>
        {writable ? (
          <form className="ws-add" onSubmit={(event) => void add(event)}>
            <label className="ui-vh" htmlFor="ws-add">New work</label>
            <input id="ws-add" className="ui-input" value={title} maxLength={200} placeholder="Add work, e.g. Order a ToF sensor" onChange={(event) => { setTitle(event.target.value); setAttempt(crypto.randomUUID()); setError(''); }} />
            <Button type="submit" variant="secondary" icon="plus" busy={busy} disabled={!title.trim()}>Add work</Button>
          </form>
        ) : null}
        {error ? <p className="wd-error" role="alert">{error}</p> : null}

        {nothing ? (
          <div className="view-empty"><EmptyState icon="tasks" title="No work yet">
            <p>Work starts when one of you makes it from a message, or adds it here. Not every idea has to become a task.</p>
          </EmptyState></div>
        ) : null}

        <Group id="proposed" title={writable ? 'Needs you' : 'Waiting for a decision'} count={proposed.length}>
          {proposed.map((item) => <Row key={item.id} icon={<Icon name="rule" size={16} />} iconClass="ws-need" title={item.title} sub={<>Proposed by {item.proposedBy.name}{item.proposedBy.kind === 'agent' ? ' (agent)' : ''}{item.supersedes ? ' · would replace the current rule' : ''}{writable ? <> · <span className="ws-need">you can accept it</span></> : null}</>} right={shortDate(item.createdAt)} onOpen={openDecision(item)} />)}
        </Group>
        <Group id="progress" title="In progress" count={by('in_progress').length}>{by('in_progress').map((item) => workRow(item))}</Group>
        <Group id="blocked" title="Blocked" count={by('blocked').length}>{by('blocked').map((item) => workRow(item))}</Group>
        <Group id="open" title="Open" count={by('open').length}>{by('open').map((item) => workRow(item))}</Group>
        <Group id="parked" title="Parked by a pivot" count={parked.length}>{parked.map((item) => workRow(item, true))}</Group>
        <Group id="finished" title="Finished" count={finished.length}>{finished.map((item) => workRow(item, true))}</Group>
        <Group id="rules" title="Decisions" count={current.length + earlier.length}>
          {current.map((item) => <Row key={item.id} icon={<Icon name="rule" size={16} />} title={item.title} sub={`Current rule · ${item.decidedBy?.name ?? ''} · ${shortDate(item.decidedAt!)}`} onOpen={openDecision(item)} />)}
          {earlier.map((item) => <Row key={item.id} icon={<Icon name="rule" size={16} />} title={item.title} sub={`Earlier rule · replaced ${shortDate(item.supersededAt!)}`} onOpen={openDecision(item)} muted />)}
        </Group>
        <Group id="results" title="Results" count={lists.results.length}>
          {lists.results.map((item) => <Row key={item.id} icon={<Icon name="result" size={16} />} iconClass={item.finding === 'negative' ? 'ws-neg' : 'ws-pos'} title={item.title} sub={`${item.finding === 'negative' ? 'Negative' : 'Positive'} · ${item.createdBy.name}`} right={shortDate(item.createdAt)} onOpen={openResult(item)} />)}
        </Group>
      </div>
    </div>
  );
}
