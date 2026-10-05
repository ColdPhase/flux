import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLoaderData, useLocation, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Decision, Project, ProactiveComparisonOutcome, WorkItem, WorkResult } from '@flux/contracts';
import { Button, EmptyState, Icon } from '../ui';
import { getProject } from '../app/conversation-api';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { useReadingPosition } from '../app/drafts';
import { remember } from '../app/remembered';
import { createWork, type ProjectWork } from './api';
import { useProjectShell } from '../project/data';
import { ProjectProposals } from '../project/ProjectProposals';
import { listComparisonOutcomes } from '../project/proposals';
import { STATUS_LABEL, isFinished, linked, shortDate } from './format';
import { TaskBoard, matchesTask, type ColumnId } from './TaskBoard';
import './work.css';

interface TasksData { project: Project; outcomes: ProactiveComparisonOutcome[] }

/** Work, decisions and results come with the project's parent route (#117). */
export async function projectTasksLoader({ params, request }: LoaderFunctionArgs): Promise<TasksData> {
  const [project, outcomes] = await Promise.all([
    getProject(params.projectId!, request.signal), listComparisonOutcomes(params.projectId!, request.signal),
  ]);
  return { project, outcomes };
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
  const waiting = isFinished(item) ? 0 : item.prerequisites.filter((prerequisite) => !prerequisite.met).length;
  return [
    item.owner ? item.owner.name : 'No owner',
    item.status === 'blocked' && item.blocker ? `waiting for ${item.blocker}` : null,
    waiting ? `waits for ${waiting} ${waiting === 1 ? 'task' : 'tasks'}` : null,
    parkedBy ? `Parked · was ${STATUS_LABEL[item.status].toLowerCase()}` : null,
    rule && !parkedBy ? `follows “${rule.title}”` : null,
    fromMessage ? 'from a message' : null,
    results ? `${results} ${results === 1 ? 'result' : 'results'}` : null,
  ].filter(Boolean).join(' · ');
}

const dot = (kind: string) => <span className={`ws-dot ws-dot--${kind}`} />;

type Mode = 'board' | 'list';
const MODE_KEY = 'flux.tasks.mode.';

/** Kanban or List, as this person last chose on this device (#136). Kanban is the default. */
function preferredMode(userId: string): Mode {
  try { return localStorage.getItem(MODE_KEY + userId) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

function rememberMode(userId: string, mode: Mode) {
  try { localStorage.setItem(MODE_KEY + userId, mode); } catch { /* remembered for this visit only */ }
}

/**
 * The Tasks toolbar (Studio 11.6): an underline search, the way to the project's decisions and
 * results, Kanban | List, Mine on the board and the one primary action, "+ Task". The List keeps
 * its own "Only mine" among its views.
 */
function Toolbar({ mode, onMode, query, onQuery, mine, onMine, writable, onNew, onDecisions }: {
  mode: Mode; onMode: (mode: Mode) => void; query: string; onQuery: (query: string) => void;
  mine: boolean; onMine: (mine: boolean) => void; writable: boolean; onNew: () => void; onDecisions: () => void;
}) {
  const searchId = useId();
  const radios = useRef<HTMLDivElement>(null);
  // One radio group: arrows choose and focus the other view, as the Map's Map | List does.
  const onRadioKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next: Mode = mode === 'board' ? 'list' : 'board';
    onMode(next);
    requestAnimationFrame(() => radios.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus());
  };
  return (
    <div className="tb-bar">
      <div className={`tb-search${query ? ' has-query' : ''}`}>
        <Icon name="search" size={14} />
        <label className="ui-vh" htmlFor={searchId}>Search tasks</label>
        <input id={searchId} type="search" value={query} placeholder="Search tasks" autoComplete="off" maxLength={200}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); onQuery(''); } }} />
      </div>
      {/* The current rule and what was learned stay one step away from the board (Journey A). */}
      <button type="button" className="tb-dr" onClick={onDecisions}><Icon name="rule" size={14} /><span className="tb-dr__l">Decisions &amp; results</span></button>
      <div className="tb-bar__end">
        <div className="tb-mode" role="radiogroup" aria-label="Show tasks as" ref={radios} onKeyDown={onRadioKey}>
          {(['board', 'list'] as const).map((value) => (
            <button key={value} type="button" role="radio" className="tb-mode__b" data-mode={value} aria-checked={mode === value}
              tabIndex={mode === value ? 0 : -1} onClick={() => onMode(value)}>
              <Icon name={value === 'board' ? 'board' : 'list'} size={13} /><span className="tb-mode__l">{value === 'board' ? 'Kanban' : 'List'}</span>
            </button>
          ))}
        </div>
        {mode === 'board' ? (
          <button type="button" className="tb-mine" aria-pressed={mine} onClick={() => onMine(!mine)}><Icon name="person" size={15} /><span>Mine</span></button>
        ) : null}
        {writable ? <Button variant="primary" icon="plus" className="tb-add" onClick={onNew}><span className="ui-vh">New </span>Task</Button> : null}
      </div>
    </div>
  );
}

/** The project's Tasks tab: committed work as a board or a grouped list, the rules it follows and what was learned. */
export function ProjectTasks() {
  const { project, outcomes } = useLoaderData() as TasksData;
  const shell = useProjectShell();
  const lists: ProjectWork = shell?.work ?? { work: [], decisions: [], results: [] };
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const writable = project.access !== 'viewer';
  const [title, setTitle] = useState('');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search] = useSearchParams();
  const { me } = useShellData();
  const scroller = useRef<HTMLDivElement>(null);
  const { pathname, search: routerSearch } = useLocation();
  const [preference, setPreference] = useState<Mode>(() => preferredMode(me.user.id));
  // The chosen view is local state mirrored into the URL with `replaceState`: switching views is
  // instant and does not reload the project, and back/forward or a shared link restore it. A List
  // view (`status`) opens the List; otherwise Kanban or List follows the person's own choice.
  const fromUrl = () => {
    const status = isGroup(search.get('status')) ? search.get('status') as GroupId : null;
    const asked = search.get('view');
    const mode: Mode = asked === 'board' || asked === 'list' ? asked : status ? 'list' : preference;
    return { project: project.id, status, mine: search.get('show') === 'mine', mode };
  };
  const [stored, setViewState] = useState(fromUrl);
  const [searched, setSearched] = useState({ project: project.id, text: '' });
  const [adding, setAdding] = useState<ColumnId | null>(null);
  const jumpId = useRef<string | null>(null);
  // The route stays mounted when another project's Tasks opens: that project starts from its URL.
  const view = stored.project === project.id ? stored : fromUrl();
  const { status, mine, mode } = view;
  const query = searched.project === project.id ? searched.text : '';
  const q = query.trim().toLowerCase();
  // Each view keeps its own reading position, so switching and coming back lands where you were.
  useReadingPosition(scroller, me.user.id, mode === 'list' ? `${pathname}?${status ?? 'all'}${mine ? ':mine' : ''}` : `${pathname}?board${mine ? ':mine' : ''}`);
  const params = new URLSearchParams();
  if (mode === 'list' && status) params.set('status', status);
  if (mine) params.set('show', 'mine');
  // Kanban or List is a personal choice: the URL names it only when it differs from that choice.
  if (mode !== (mode === 'list' && status ? 'list' : preference)) params.set('view', mode);
  const viewSearch = params.toString();
  useEffect(() => {
    remember('tasks', me.user.id, project.id, viewSearch ? `?${viewSearch}` : '');
    const url = new URL(window.location.href);
    for (const key of ['status', 'show', 'view']) url.searchParams.delete(key);
    for (const [key, value] of new URLSearchParams(viewSearch)) url.searchParams.set(key, value);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    // `routerSearch`: a router navigation on this page (e.g. dropping `?open=`) would drop the view.
  }, [project.id, viewSearch, routerSearch]);
  const setView = (next: { status?: GroupId | null; mine?: boolean; mode?: Mode }) => setViewState({ ...view, ...next });
  const chooseMode = (next: Mode) => { setPreference(next); rememberMode(me.user.id, next); setView({ mode: next }); };
  const setQuery = (text: string) => setSearched({ project: project.id, text });
  // Outcome links refer to the whole project's work/results in the List. Restore All before
  // scrolling, since a saved status/mine filter or a search can hide their destination.
  const jumpToSection = (id: string) => { jumpId.current = id; setQuery(''); setView({ status: null, mine: false, mode: 'list' }); };
  useEffect(() => {
    if (!jumpId.current) return;
    document.getElementById(jumpId.current)?.scrollIntoView({ block: 'start' });
    jumpId.current = null;
  }, [view]);

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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the task.'); }
    finally { setBusy(false); }
  }

  // "+ Task" starts the same creation: the List's field, or a field at the top of the board's Open column.
  const startNew = () => {
    if (mode === 'list') document.getElementById('ws-add')?.focus();
    else setAdding('open');
  };

  const own = (item: WorkItem) => !mine || item.owner?.id === me.user.id;
  const found = (item: WorkItem) => matchesTask(item, q);
  const titled = (item: { title: string }) => !q || item.title.toLowerCase().includes(q);
  const live = lists.work.filter((item) => own(item) && found(item) && (!item.parked || isFinished(item)));
  const by = (state: WorkItem['status']) => live.filter((item) => item.status === state);
  const parked = lists.work.filter((item) => own(item) && found(item) && item.parked && !isFinished(item));
  const finished = live.filter(isFinished);
  const proposed = lists.decisions.filter((item) => item.status === 'proposed' && titled(item));
  const current = mine ? [] : lists.decisions.filter((item) => item.status === 'accepted' && titled(item));
  const earlier = mine ? [] : lists.decisions.filter((item) => item.status === 'superseded' && titled(item));
  const results = lists.results.filter((item) => (!mine || item.createdBy.id === me.user.id) && titled(item));
  const counts: Record<GroupId, number> = {
    needs: proposed.length, in_progress: by('in_progress').length, blocked: by('blocked').length, open: by('open').length,
    parked: parked.length, finished: finished.length, rules: current.length + earlier.length, results: results.length,
  };
  const visible = (id: GroupId) => !status || status === id;
  const openWork = (item: WorkItem) => () => openDetails({ kind: 'work', id: item.id });
  const openDecision = (item: Decision) => () => openDetails({ kind: 'decision', id: item.id });
  const openResult = (item: WorkResult) => () => openDetails({ kind: 'result', id: item.id });
  const workRow = (item: WorkItem, muted = false) => <Row key={item.id} icon={dot(item.parked ? 'parked' : item.status)} title={item.title} sub={workSub(item, lists)} right={item.owner ? <span className="ws-av" aria-hidden="true">{item.owner.name.slice(0, 1)}</span> : null} onOpen={openWork(item)} muted={muted} />;
  const nothing = !lists.work.length && !lists.decisions.length && !lists.results.length
    && !outcomes.some((outcome) => outcome.kind === 'comparison' ? outcome.proposal.status === 'proposed' : outcome.status === 'open');
  const proposals = (
    <ProjectProposals outcomes={outcomes} people={shell?.people ?? null} projectName={project.name}
      resultTitles={new Map(lists.results.map((result) => [result.id, result.title]))}
      workCount={lists.work.length} resultCount={lists.results.length}
      workJumpId={lists.work.some((item) => !item.parked && item.status === 'in_progress') ? 'g-progress' : lists.work.some((item) => !item.parked && item.status === 'blocked') ? 'g-blocked' : lists.work.some((item) => !item.parked && item.status === 'open') ? 'g-open' : lists.work.some((item) => item.parked && !isFinished(item)) ? 'g-parked' : 'g-finished'}
      jumpToSection={jumpToSection}
      writable={writable} refresh={() => revalidator.revalidate()}
      openResult={(id) => openDetails({ kind: 'result', id })}
      openWork={(item) => openDetails({ kind: 'work', id: item.id })} />
  );
  // What the board leaves to the List, one step away: a decision waiting for someone and work a pivot set aside.
  const elsewhere: { id: GroupId; text: string; need?: boolean }[] = [];
  if (counts.needs) elsewhere.push({ id: 'needs', text: writable ? `${counts.needs} ${counts.needs === 1 ? 'decision needs' : 'decisions need'} you` : `${counts.needs} waiting for a decision`, need: true });
  if (counts.parked) elsewhere.push({ id: 'parked', text: `${counts.parked} parked by a pivot` });
  // "Decisions & results" opens the whole List at the first of them: proposals, then rules, then results.
  const toDecisions = () => jumpToSection(lists.decisions.some((item) => item.status === 'proposed') ? 'g-proposed'
    : lists.decisions.length ? 'g-rules' : 'g-results');

  return (
    <div className="tb-root">
      <Toolbar mode={mode} onMode={chooseMode} query={query} onQuery={setQuery} mine={mine} onMine={(next) => setView({ mine: next })} writable={writable} onNew={startNew} onDecisions={toDecisions} />
      <div className="pane-scroll" ref={scroller}>
        {mode === 'board' ? (
          <div className="tb">
            {elsewhere.length ? (
              <nav className="tb-also" aria-label="Also in the List">
                <span className="tb-also__k">In the List:</span>
                {elsewhere.map((entry) => (
                  <button key={entry.id} type="button" className={`tb-also__b${entry.need ? ' tb-also__b--need' : ''}`} onClick={() => setView({ mode: 'list', status: entry.id })}>{entry.text}</button>
                ))}
              </nav>
            ) : null}
            <div className="tb-aside">{proposals}</div>
            <TaskBoard project={project} lists={lists} meId={me.user.id} mine={mine} query={q} writable={writable}
              adding={adding} onAdding={setAdding} openWork={(id) => openDetails({ kind: 'work', id })} refresh={() => revalidator.revalidate()}
              clearFilters={() => { setQuery(''); setView({ mine: false }); }} />
          </div>
        ) : (
          <div className="pane-in ws-tasks" data-shift>
            {writable ? (
              <form className="ws-add" onSubmit={(event) => void add(event)}>
                <label className="ui-vh" htmlFor="ws-add">New task</label>
                <input id="ws-add" className="ui-input" value={title} maxLength={200} placeholder="Add a task, e.g. Order a ToF sensor" onChange={(event) => { setTitle(event.target.value); setAttempt(crypto.randomUUID()); setError(''); }} />
                <Button type="submit" variant="secondary" icon="plus" busy={busy} disabled={!title.trim()}>Add task</Button>
              </form>
            ) : null}
            {error ? <p className="wd-error" role="alert">{error}</p> : null}

            {nothing ? (
              <div className="view-empty"><EmptyState icon="tasks" title="No tasks yet">
                <p>A task starts when one of you makes it from a message, or adds it here. Not every idea has to become a task.</p>
              </EmptyState></div>
            ) : null}

            {proposals}
            {!nothing ? <TaskViews counts={counts} status={status} mine={mine} writable={writable} onStatus={(next) => setView({ status: next })} onMine={(next) => setView({ mine: next })} /> : null}
            {!nothing && (status ? !counts[status] : !Object.values(counts).some(Boolean)) ? (
              q ? (
                <p className="ws-none" role="status">
                  Nothing{mine ? ' of yours' : ''}{status ? ` in ${GROUP_LABEL[status].toLowerCase()}` : ''} matches “{query.trim()}”.{' '}
                  <button type="button" className="ws-none__b" onClick={() => setQuery('')}>Clear the search</button>
                </p>
              ) : (
                <p className="ws-none" role="status">
                  {mine ? `Nothing of yours${status ? ` in ${GROUP_LABEL[status].toLowerCase()}` : ''} right now.` : `Nothing in ${GROUP_LABEL[status!].toLowerCase()} right now.`}{' '}
                  <button type="button" className="ws-none__b" onClick={() => setView(mine ? { mine: false } : { status: null })}>{mine ? 'Show everyone’s' : 'Show all'}</button>
                </p>
              )
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
        )}
      </div>
    </div>
  );
}
