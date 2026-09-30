import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLoaderData, useLocation, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Decision, Project, WorkItem, WorkResult } from '@flux/contracts';
import { Button, EmptyState, Icon } from '../ui';
import { getProject } from '../app/conversation-api';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { useReadingPosition } from '../app/drafts';
import { createWork, type ProjectWork } from './api';
import { useProjectShell } from '../project/data';
import { STATUS_LABEL, isFinished, linked, shortDate } from './format';
import './work.css';

interface TasksData { project: Project }

/** Work, decisions and results come with the project's parent route (#117). */
export async function projectTasksLoader({ params, request }: LoaderFunctionArgs): Promise<TasksData> {
  return { project: await getProject(params.projectId!, request.signal) };
}

function Group({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section className="ws-group" id={`ws-${id}`} aria-labelledby={`g-${id}`}>
      <h2 className="ws-group__h" id={`g-${id}`}>{title} <span>{count}</span></h2>
      <ul className="ws-list">{children}</ul>
    </section>
  );
}

/** The groups of the Tasks tab, in reading order. `status` in the URL shows one of them. */
const GROUPS = ['needs', 'in_progress', 'blocked', 'open', 'parked', 'finished', 'rules', 'results'] as const;
type GroupId = typeof GROUPS[number];
const GROUP_LABEL: Record<GroupId, string> = {
  needs: 'Needs you', in_progress: 'In progress', blocked: 'Blocked', open: 'Open',
  parked: 'Parked', finished: 'Finished', rules: 'Decisions', results: 'Results',
};
const isGroup = (value: string | null): value is GroupId => GROUPS.includes(value as GroupId);

/**
 * One readable row of views instead of a board of clipped columns (#136 AC-2): All, then only
 * the groups that have something. The chosen view and "Only mine" live in the URL, so returning
 * from a source or Details comes back to the same view and reading position.
 */
function TaskViews({ counts, status, mine, writable, onStatus, onMine }: {
  counts: Record<GroupId, number>; status: GroupId | null; mine: boolean; writable: boolean;
  onStatus: (status: GroupId | null) => void; onMine: (mine: boolean) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  // Keep the chosen view in sight by scrolling only the row sideways; scrollIntoView would also
  // scroll the Tasks pane and undo its restored reading position.
  useEffect(() => {
    const bar = row.current;
    const chosen = bar?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!bar || !chosen || bar.scrollWidth <= bar.clientWidth) return;
    const start = chosen.offsetLeft - bar.offsetLeft;
    const end = start + chosen.offsetWidth;
    if (start < bar.scrollLeft) bar.scrollLeft = Math.max(0, start - 16);
    else if (end > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = end - bar.clientWidth + 16;
  }, [status]);
  const shown = GROUPS.filter((id) => counts[id] || id === status);
  return (
    <nav className="ws-views" aria-label="Task views">
      <div className="ws-views__row" ref={row}>
        <button type="button" className="ws-view" aria-pressed={!status} onClick={() => onStatus(null)}>All</button>
        {shown.map((id) => (
          <button key={id} type="button" className={`ws-view${id === 'needs' && counts.needs ? ' ws-view--need' : ''}`} aria-pressed={status === id} onClick={() => onStatus(id)}>
            {id === 'needs' && !writable ? 'Waiting for a decision' : GROUP_LABEL[id]} <span className="ws-view__n">{counts[id]}</span>
          </button>
        ))}
      </div>
      <label className="ws-mine"><input type="checkbox" checked={mine} onChange={(event) => onMine(event.target.checked)} /> Only mine</label>
    </nav>
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
  const { project } = useLoaderData() as TasksData;
  const lists: ProjectWork = useProjectShell()?.work ?? { work: [], decisions: [], results: [] };
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const writable = project.access !== 'viewer';
  const [title, setTitle] = useState('');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useSearchParams();
  const { me } = useShellData();
  const scroller = useRef<HTMLDivElement>(null);
  const { pathname, search: routerSearch } = useLocation();
  // The chosen view is local state mirrored into the URL with `replaceState`: switching views is
  // instant and does not reload the project, and back/forward or a shared link restore it.
  const fromUrl = () => ({ project: project.id, status: isGroup(search.get('status')) ? search.get('status') as GroupId : null, mine: search.get('show') === 'mine' });
  const [stored, setViewState] = useState(fromUrl);
  // The route stays mounted when another project's Tasks opens: that project starts from its URL.
  const view = stored.project === project.id ? stored : fromUrl();
  const { status, mine } = view;
  // Each view keeps its own reading position, so switching and coming back lands where you were.
  useReadingPosition(scroller, me.user.id, `${pathname}?${status ?? 'all'}${mine ? ':mine' : ''}`);
  const viewSearch = `${status ? `status=${status}` : ''}${status && mine ? '&' : ''}${mine ? 'show=mine' : ''}`;
  useEffect(() => {
    try { sessionStorage.setItem(`flux.project-tasks.${project.id}`, viewSearch ? `?${viewSearch}` : ''); } catch { /* the tab opens All */ }
    const url = new URL(window.location.href);
    url.searchParams.delete('status'); url.searchParams.delete('show');
    if (status) url.searchParams.set('status', status);
    if (mine) url.searchParams.set('show', 'mine');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    // `routerSearch`: a router navigation on this page (e.g. dropping `?open=`) would drop the view.
  }, [project.id, viewSearch, status, mine, routerSearch]);
  const setView = (next: { status?: GroupId | null; mine?: boolean }) => setViewState({ ...view, ...next });

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

  const own = (item: WorkItem) => !mine || item.owner?.id === me.user.id;
  const live = lists.work.filter((item) => own(item) && (!item.parked || isFinished(item)));
  const by = (state: WorkItem['status']) => live.filter((item) => item.status === state);
  const parked = lists.work.filter((item) => own(item) && item.parked && !isFinished(item));
  const finished = live.filter(isFinished);
  const proposed = lists.decisions.filter((item) => item.status === 'proposed');
  const current = mine ? [] : lists.decisions.filter((item) => item.status === 'accepted');
  const earlier = mine ? [] : lists.decisions.filter((item) => item.status === 'superseded');
  const results = lists.results.filter((item) => !mine || item.createdBy.id === me.user.id);
  const counts: Record<GroupId, number> = {
    needs: proposed.length, in_progress: by('in_progress').length, blocked: by('blocked').length, open: by('open').length,
    parked: parked.length, finished: finished.length, rules: current.length + earlier.length, results: results.length,
  };
  const visible = (id: GroupId) => !status || status === id;
  const openWork = (item: WorkItem) => () => openDetails({ kind: 'work', id: item.id });
  const openDecision = (item: Decision) => () => openDetails({ kind: 'decision', id: item.id });
  const openResult = (item: WorkResult) => () => openDetails({ kind: 'result', id: item.id });
  const workRow = (item: WorkItem, muted = false) => <Row key={item.id} icon={dot(item.parked ? 'parked' : item.status)} title={item.title} sub={workSub(item, lists)} right={item.owner ? <span className="ws-av" aria-hidden="true">{item.owner.name.slice(0, 1)}</span> : null} onOpen={openWork(item)} muted={muted} />;
  const nothing = !lists.work.length && !lists.decisions.length && !lists.results.length;

  return (
    <div className="pane-scroll" ref={scroller}>
      <div className="pane-in ws-tasks" data-shift>
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

        {!nothing ? <TaskViews counts={counts} status={status} mine={mine} writable={writable} onStatus={(next) => setView({ status: next })} onMine={(next) => setView({ mine: next })} /> : null}
        {!nothing && (status ? !counts[status] : !Object.values(counts).some(Boolean)) ? (
          <p className="ws-none" role="status">
            {mine ? `Nothing of yours${status ? ` in ${GROUP_LABEL[status].toLowerCase()}` : ''} right now.` : `Nothing in ${GROUP_LABEL[status!].toLowerCase()} right now.`}{' '}
            <button type="button" className="ws-none__b" onClick={() => setView(mine ? { mine: false } : { status: null })}>{mine ? 'Show everyone’s' : 'Show all'}</button>
          </p>
        ) : null}

        <Group id="proposed" title={writable ? 'Needs you' : 'Waiting for a decision'} count={visible('needs') ? proposed.length : 0}>
          {proposed.map((item) => <Row key={item.id} icon={<Icon name="rule" size={16} />} iconClass="ws-need" title={item.title} sub={<>Proposed by {item.proposedBy.name}{item.proposedBy.kind === 'agent' ? ' (agent)' : ''}{item.supersedes ? ' · would replace the current rule' : ''}{writable ? <> · <span className="ws-need">you can accept it</span></> : null}</>} right={shortDate(item.createdAt)} onOpen={openDecision(item)} />)}
        </Group>
        <Group id="progress" title="In progress" count={visible('in_progress') ? counts.in_progress : 0}>{by('in_progress').map((item) => workRow(item))}</Group>
        <Group id="blocked" title="Blocked" count={visible('blocked') ? counts.blocked : 0}>{by('blocked').map((item) => workRow(item))}</Group>
        <Group id="open" title="Open" count={visible('open') ? counts.open : 0}>{by('open').map((item) => workRow(item))}</Group>
        <Group id="parked" title="Parked by a pivot" count={visible('parked') ? counts.parked : 0}>{parked.map((item) => workRow(item, true))}</Group>
        <Group id="finished" title="Finished" count={visible('finished') ? counts.finished : 0}>{finished.map((item) => workRow(item, true))}</Group>
        <Group id="rules" title="Decisions" count={visible('rules') ? counts.rules : 0}>
          {current.map((item) => <Row key={item.id} icon={<Icon name="rule" size={16} />} title={item.title} sub={`Current rule · ${item.decidedBy?.name ?? ''} · ${shortDate(item.decidedAt!)}`} onOpen={openDecision(item)} />)}
          {earlier.map((item) => <Row key={item.id} icon={<Icon name="rule" size={16} />} title={item.title} sub={`Earlier rule · replaced ${shortDate(item.supersededAt!)}`} onOpen={openDecision(item)} muted />)}
        </Group>
        <Group id="results" title="Results" count={visible('results') ? counts.results : 0}>
          {results.map((item) => <Row key={item.id} icon={<Icon name="result" size={16} />} iconClass={item.finding === 'negative' ? 'ws-neg' : 'ws-pos'} title={item.title} sub={`${item.finding === 'negative' ? 'Negative' : 'Positive'} · ${item.createdBy.name}`} right={shortDate(item.createdAt)} onOpen={openResult(item)} />)}
        </Group>
      </div>
    </div>
  );
}
