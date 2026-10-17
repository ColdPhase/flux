import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Navigate, useLoaderData, useLocation, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Project, ProactiveComparisonOutcome, ProjectWorkViewQuery, WorkCounts, WorkItem, WorkObjectType, WorkRowProjection } from '@flux/contracts';
import { Button, EmptyState, ErrorState, Icon, MEDIA, useMediaQuery } from '../ui';
import { getProject } from '../app/conversation-api';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { remember } from '../app/remembered';
import { isFinished } from './format';
import { TaskRow, type TaskRowProps } from './TaskRow';
import { useStateChange } from './taskState';
import { getProjectWorkView, getWorkReferenceRows, workReferenceReadUrl, workViewReadUrl } from './read-api';
import { useWorkRead } from './useWorkRead';
import { OPENING_REVEAL_MS } from '../app/messageParts';
import { useProjectWorkPage } from './WorkReadContext';
import { WorkPagination } from './WorkPagination';
import { useWorkReadingPosition } from './useWorkReadingPosition';
import { useTaskFeedback } from './useTaskFeedback';
import { TaskBoard } from './TaskBoard';
import { useProjectShell } from '../project/data';
import { ProjectProposals } from '../project/ProjectProposals';
import { listComparisonOutcomes } from '../project/proposals';
import { useAgentOwners } from '../agents/owners';
import './work.css';
import { RefLink } from '../place/origin';

interface TasksData { project: Project; outcomes: ProactiveComparisonOutcome[] }

/** Object rows use their separate bounded page; this loader supplies the project contract. */
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

/**
 * The groups of the Tasks tab, in reading order. `status` in the URL shows one of them. Decisions wait in
 * the Inbox, not here (F-026 S1), and a result shows in its task's details (#342); the old `needs`, `rules`
 * and `results` views are not groups any more and their links lead to the Inbox or to All.
 */
const GROUPS = ['in_progress', 'blocked', 'open', 'parked', 'finished'] as const;
type GroupId = typeof GROUPS[number];
const GROUP_LABEL: Record<GroupId, string> = {
  in_progress: 'In progress', blocked: 'Blocked', open: 'Open', parked: 'Parked', finished: 'Finished',
};
const isGroup = (value: string | null): value is GroupId => GROUPS.includes(value as GroupId);
/** Old links to the Decisions view (`?status=needs` or `rules`) lead to the Inbox's Decisions filter. */
const RETIRED_DECISION_VIEWS = ['needs', 'rules'];

/**
 * One readable row of views instead of a board of clipped columns (#136 AC-2): All, then only
 * the groups that have something. The chosen view and "Mine" live in the URL, so returning
 * from a source or Details comes back to the same view and reading position.
 */
function TaskViews({ counts, status, onStatus }: {
  counts: WorkCounts | null; status: GroupId | null;
  onStatus: (status: GroupId | null) => void;
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
  const shown = GROUPS.filter((id) => !counts || counts[id] || id === status);
  return (
    <nav className="ws-views" aria-label="Task views">
      <div className="ws-views__row" ref={row}>
        <button type="button" className="ws-view" aria-pressed={!status} onClick={() => onStatus(null)}>All</button>
        {shown.map((id) => (
          <button key={id} type="button" className="ws-view" aria-pressed={status === id} onClick={() => onStatus(id)}>
            {GROUP_LABEL[id]} <span className="ws-view__n">{counts ? counts[id] : '…'}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

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
 * The Tasks toolbar (S6, T2): Board | List, Mine and the search in the same places in both views, then the one
 * primary action, "+ Task". The search filters the board's loaded cards; the List is read in bounded pages from
 * the server, so its search is dimmed rather than removed, which keeps every other control where it is.
 */
function Toolbar({ mode, onMode, query, onQuery, mine, onMine, writable, onNew }: {
  mode: Mode; onMode: (mode: Mode) => void; query: string; onQuery: (query: string) => void;
  mine: boolean; onMine: (mine: boolean) => void; writable: boolean; onNew: () => void;
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
  // In reading order, as drawn: [Board | List] [Mine] [Search tasks] … [+ Task].
  return (
    <div className="tb-bar">
      <div className="tb-mode" role="radiogroup" aria-label="Show tasks as" ref={radios} onKeyDown={onRadioKey}>
        {(['board', 'list'] as const).map((value) => (
          <button key={value} type="button" role="radio" className="tb-mode__b" data-mode={value} aria-checked={mode === value}
            tabIndex={mode === value ? 0 : -1} onClick={() => onMode(value)}>
            <span className="tb-mode__l">{value === 'board' ? 'Board' : 'List'}</span>
          </button>
        ))}
      </div>
      <button type="button" className="tb-mine" aria-pressed={mine} onClick={() => onMine(!mine)}><Icon name="person" size={15} /><span>Mine</span></button>
      <div className={`tb-search${query ? ' has-query' : ''}${mode === 'list' ? ' is-dimmed' : ''}`}>
        <Icon name="search" size={14} />
        <span className="tb-search__l" aria-hidden="true">Search</span>
        <label className="ui-vh" htmlFor={searchId}>Search tasks</label>
        <input id={searchId} type="search" value={query} placeholder="Search tasks" autoComplete="off" maxLength={200}
          disabled={mode === 'list'} aria-describedby={mode === 'list' ? `${searchId}-note` : undefined}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); onQuery(''); } }} />
        {mode === 'list' ? <span className="ui-vh" id={`${searchId}-note`}>Search works on the board</span> : null}
      </div>
      {writable ? <Button variant="primary" icon="plus" className="tb-add" onClick={onNew}><span className="ui-vh">New </span>Task</Button> : null}
    </div>
  );
}

/** List section anchors (`g-…`) and the List view that holds each of them. */
const SECTION_GROUP: Record<string, GroupId> = {
  'g-progress': 'in_progress', 'g-blocked': 'blocked', 'g-open': 'open', 'g-parked': 'parked', 'g-finished': 'finished',
};

const cursors = new Map<string, string | null>();
const taskViewKey = (accountId: string, projectId: string, status: GroupId | null, mine: boolean) =>
  `flux:task-view:${accountId}:${projectId}:${status ?? 'all'}:${mine ? 'mine' : 'all'}`;
function storedCursor(key: string): string | null {
  if (cursors.has(key)) return cursors.get(key)!;
  try {
    const cursor = sessionStorage.getItem(key);
    return cursor && cursor.length <= 512 ? cursor : null;
  } catch { return null; }
}
function keepCursor(key: string, cursor: string | null) {
  cursors.set(key, cursor);
  try { if (cursor) sessionStorage.setItem(key, cursor); else sessionStorage.removeItem(key); } catch { /* Keep this visit's page. */ }
}

/** The project's Tasks tab: committed work as a board or a grouped list, the rules it follows and what was learned. */
export function ProjectTasks() {
  const { project, outcomes } = useLoaderData() as TasksData;
  const shell = useProjectShell();
  const owners = useAgentOwners(project);
  const { openDetails, openCreate } = useShellActions();
  const revalidator = useRevalidator();
  const [search, setSearch] = useSearchParams();
  const retired = RETIRED_DECISION_VIEWS.includes(search.get('status') ?? '');
  const { me } = useShellData();
  const scroller = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const routeKey = `${me.user.id}:${project.id}:${location.key}`;
  const [chosen, setChosen] = useState(() => ({ userId: me.user.id, mode: preferredMode(me.user.id) }));
  const preference = chosen.userId === me.user.id ? chosen.mode : preferredMode(me.user.id);
  // A List view (`status`, or a page `cursor`) opens the List; otherwise Kanban or List follows
  // the person's own choice unless the URL names one (`view`).
  const fromUrl = () => {
    const status = isGroup(search.get('status')) ? search.get('status') as GroupId : null;
    // The phone lists whatever the address names (a section jump or a shared link) and keeps its own continuation.
    const onPhone = window.matchMedia(MEDIA.phone).matches;
    const cursor = search.get('cursor') || null;
    const asked = search.get('view');
    const mode: Mode = asked === 'board' || asked === 'list' ? asked : status || cursor ? 'list' : preferredMode(me.user.id);
    return { routeKey, status, mine: search.get('show') === 'mine', cursor: mode === 'list' || onPhone ? cursor : null, mode };
  };
  const [saved, setSaved] = useState<Record<string, WorkItem>>({});
  const focusRow = useRef<{ id: string; until: number } | null>(null);
  const [stored, setViewState] = useState(fromUrl);
  const [searched, setSearched] = useState({ routeKey: `${me.user.id}:${project.id}`, text: '' });
  // A router POP, account switch or project switch selects its actual URL immediately.
  const view = stored.routeKey === routeKey ? stored : fromUrl();
  const { status: viewStatus, mine, cursor: viewCursor, mode: viewMode } = view;
  // The phone shows the list as drawn (S-P-Tasks): Mine | All over the rows, no board and no group views.
  const phone = useMediaQuery(MEDIA.phone);
  const status = viewStatus;
  const cursor = viewCursor;
  const listing = phone || viewMode === 'list';
  const mode = viewMode;
  const boardSearch = searched.routeKey === `${me.user.id}:${project.id}` ? searched.text : '';
  const setBoardSearch = (text: string) => setSearched({ routeKey: `${me.user.id}:${project.id}`, text });
  // The List reads its chosen view page by page. The board's Open column is the same bounded read
  // of the open group; its other columns are read by the board (see TaskBoard).
  const query = useMemo<ProjectWorkViewQuery>(() => phone || mode === 'list'
    ? { purpose: 'tasks', group: status ?? 'all', mine, kinds: 'work', ...(cursor ? { cursor } : {}) }
    : { purpose: 'tasks', group: 'open', mine, kinds: 'work' }, [phone, mode, status, mine, cursor]);
  const selector = workViewReadUrl(project.id, query);
  const load = useCallback((signal: AbortSignal) => getProjectWorkView(project.id, query, signal), [project.id, query]);
  const { page: read, refresh: refreshPage } = useProjectWorkPage(project.id, selector, load);
  const data = read.phase === 'ready' || read.phase === 'refreshing' ? read.value : null;
  const writable = (data?.summary.access ?? project.access) !== 'viewer';
  const counts = data ? mine ? data.summary.mine : data.summary.all : null;
  const viewKey = taskViewKey(me.user.id, project.id, status, mine);
  const readingKey = listing ? `${viewKey}:reading:${cursor ?? 'first'}` : `${taskViewKey(me.user.id, project.id, null, mine)}:board:reading`;
  const saveReading = useWorkReadingPosition(scroller, readingKey, data !== null, data?.summary.observedAt);
  // The results that proposals and outcomes name (#155): their current titles come from one bounded
  // reference read (at most 100), not from whichever page of results the List has loaded.
  const outcomeResults = useMemo(() => [...new Set(outcomes.map((outcome) => outcome.kind === 'comparison' ? outcome.proposal.resultId : outcome.resultId))]
    .sort().slice(0, 100).map((id) => `result:${id}`).join(','), [outcomes]);
  const outcomeScope = useMemo(() => outcomeResults ? { accountId: me.user.id, projectId: project.id, selector: workReferenceReadUrl(project.id, outcomeResults) } : null, [me.user.id, project.id, outcomeResults]);
  const loadOutcomeResults = useCallback((signal: AbortSignal) => getWorkReferenceRows(project.id, outcomeResults, signal), [project.id, outcomeResults]);
  const outcomeRead = useWorkRead(outcomeScope, loadOutcomeResults, outcomes.length, revalidator.state === 'idle');
  // A proposal names its result in its first line: proposals are laid out but hidden until those titles
  // have been read (at most OPENING_REVEAL_MS), so the line never changes under the reader (#155).
  const [titlesTimedOut, setTitlesTimedOut] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setTitlesTimedOut(true), OPENING_REVEAL_MS); return () => window.clearTimeout(timer); }, []);
  const [titlesShown, setTitlesShown] = useState(false);
  if (!titlesShown && (outcomeRead.phase !== 'loading' || titlesTimedOut)) setTitlesShown(true);
  const jump = useRef<{ routeKey: string; id: string; group: GroupId } | null>(null);
  // Outcome links refer to the whole project's work in the List. Restore All before
  // scrolling, since a saved status/mine filter or a search can hide their destination.
  const jumpToSection = (id: string) => {
    const group = SECTION_GROUP[id];
    if (!group) return;
    saveReading();
    if (listing) keepCursor(viewKey, cursor);
    jump.current = { routeKey, id, group };
    setBoardSearch('');
    setViewState({ routeKey, status: null, mine: false, cursor: null, mode: 'list' });
  };
  useEffect(() => {
    const target = jump.current;
    if (!target) return;
    if (target.routeKey !== routeKey) { jump.current = null; return; }
    if (read.phase !== 'ready' || mine || cursor) return;
    if (status !== null && status !== target.group) { jump.current = null; return; }
    const heading = document.getElementById(target.id);
    if (!heading && status === null) {
      // All still has its bounded first page. Select the named group only when
      // the actual destination lies outside it; never fetch every object to jump.
      setViewState({ routeKey, status: target.group, mine: false, cursor: null, mode: 'list' });
      return;
    }
    const pane = scroller.current;
    if (heading && pane) {
      const controls = pane.querySelector('.ws-task-controls');
      const inset = (controls?.getBoundingClientRect().height ?? 0) + 12;
      pane.scrollTo({ top: Math.max(0, pane.scrollTop + heading.getBoundingClientRect().top - pane.getBoundingClientRect().top - inset), behavior: 'instant' });
    }
    jump.current = null;
  }, [routeKey, read.phase, data, status, mine, cursor, view]);

  // The chosen view is local state mirrored into the URL with `replaceState`: switching views is
  // instant, and back/forward or a shared link restore it. Kanban or List is a personal choice:
  // the URL names it only when it differs from that choice.
  const params = new URLSearchParams();
  if (listing && status) params.set('status', status);
  if (mine) params.set('show', 'mine');
  if (listing && cursor) params.set('cursor', cursor);
  if (!phone && mode !== (mode === 'list' && (status || cursor) ? 'list' : preference)) params.set('view', mode);
  const viewSearch = params.toString();
  useEffect(() => {
    if (listing) keepCursor(viewKey, cursor);
    remember('tasks', me.user.id, project.id, viewSearch ? `?${viewSearch}` : '');
    const url = new URL(window.location.href);
    for (const key of ['status', 'show', 'cursor', 'view']) url.searchParams.delete(key);
    for (const [key, value] of new URLSearchParams(viewSearch)) url.searchParams.set(key, value);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [viewKey, cursor, mode, listing, viewSearch, me.user.id, project.id, location.search]);

  const setView = (next: { status?: GroupId | null; mine?: boolean; mode?: Mode }) => {
    jump.current = null;
    saveReading();
    if (listing) keepCursor(viewKey, cursor);
    const nextStatus = next.status === undefined ? status : next.status;
    const nextMine = next.mine ?? mine;
    const nextMode = next.mode ?? mode;
    setViewState({ routeKey, status: nextStatus, mine: nextMine, mode: nextMode,
      cursor: nextMode === 'list' || phone ? storedCursor(taskViewKey(me.user.id, project.id, nextStatus, nextMine)) : null });
  };
  const chooseMode = (next: Mode) => { setChosen({ userId: me.user.id, mode: next }); rememberMode(me.user.id, next); setView({ mode: next }); };
  const movePage = (nextCursor: string) => {
    jump.current = null;
    saveReading();
    keepCursor(viewKey, nextCursor);
    setViewState({ ...view, cursor: nextCursor });
  };
  const refresh = () => {
    jump.current = null;
    saveReading();
    if (listing) keepCursor(viewKey, null);
    setViewState({ ...view, cursor: null });
    refreshPage();
  };
  // The board's own column reads follow this revision as well as the router's revalidation.
  const [boardRevision, setBoardRevision] = useState(0);
  const refreshBoard = () => { refreshPage(); setBoardRevision((current) => current + 1); };
  // One tap on a glyph, or the keys 1-5 on a row, change its state; the toast offers Undo (F-026 S9).
  const shownSaved = useCallback((item: WorkItem) => setSaved((now) => ({ ...now, [item.id]: item })), []);
  const storeState = useStateChange(shownSaved, refreshPage);
  useTaskFeedback(scroller, !phone && listing, data?.summary.observedAt, saved);
  const changeState: TaskRowProps['onChange'] = (item, status) => {
    if (document.activeElement?.closest(`[data-work-id="${item.id}"]`)) focusRow.current = { id: item.id, until: performance.now() + 5000 };
    void storeState(item, status);
  };
  // The row is drawn in another group after its state changes: keep focus on it when that is where it was.
  useLayoutEffect(() => {
    const wanted = focusRow.current;
    if (!wanted) return;
    if (performance.now() > wanted.until) { focusRow.current = null; return; }
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const button = scroller.current?.querySelector<HTMLButtonElement>(`[data-work-id="${wanted.id}"] .ws-item`);
    if (button) { button.focus({ preventScroll: true }); focusRow.current = null; }
  });
  // "+ Task" opens the one Create window, here in this project (F-026 S3).
  const startNew = () => openCreate({ kind: 'task', projectId: project.id });
  // New → Task (an old ?new=task link) opens the same window once, then drops the parameter.
  useEffect(() => {
    if (search.get('new') !== 'task' || !writable) return;
    const next = new URLSearchParams(search);
    next.delete('new');
    setSearch(next, { replace: true, state: location.state });
    openCreate({ kind: 'task', projectId: project.id });
  }, [search, writable, setSearch, openCreate, project.id]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') revalidator.revalidate(); };
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 15000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval); };
  }, [revalidator]);

  // A stored state change shows at once; the List's own read catches up with that version.
  const work = (data?.items.filter((item): item is WorkRowProjection => item.kind === 'work') ?? [])
    .map((item) => { const stored = saved[item.id]; return stored && stored.version > item.version ? { ...item, status: stored.status, blocker: stored.blocker, version: stored.version } : item; });
  const by = (state: WorkRowProjection['status']) => work.filter((item) => item.status === state && !item.parked);
  const parked = work.filter((item) => item.parked && !isFinished(item));
  const finished = work.filter(isFinished);
  const groupCount = (id: GroupId, visible: number) => visible ? counts?.[id] ?? 0 : 0;
  const openObject = (kind: WorkObjectType, id: string) => () => { saveReading(); openDetails({ kind, id }); };
  const workRow = (item: WorkRowProjection, muted = false) => <TaskRow key={item.id} item={item} meId={me.user.id} owners={owners} writable={writable} muted={muted} onOpen={openObject('work', item.id)} onChange={changeState} />;
  const summaryCounts = data ? mine ? data.summary.mine : data.summary.all : null;
  // What the board leaves to other places, one step away: work a pivot set aside, and decisions that wait in the Inbox.
  const parkedCount = summaryCounts?.parked ?? 0;
  const waiting = summaryCounts?.needs ?? 0;
  // Only people who can accept find a decision in their Inbox; others are told one waits.
  const inboxLink = !waiting ? null : writable ? (
    <RefLink className="tb-also__b tb-also__b--need" to="/inbox?show=decisions">
      {`${waiting} ${waiting === 1 ? 'decision needs' : 'decisions need'} you in the Inbox`}
    </RefLink>
  ) : <span className="tb-also__b">{`${waiting} waiting for a decision`}</span>;
  const nothing = data !== null && cursor === null && !Object.values(data.summary.all).some(Boolean)
    && !outcomes.some((outcome) => outcome.kind === 'comparison' ? outcome.proposal.status === 'proposed' : outcome.status === 'open');
  const emptyContinuation = data !== null && cursor !== null && !data.items.length;

  const resultTitles = new Map<string, string>();
  if (outcomeRead.phase === 'ready' || outcomeRead.phase === 'refreshing') for (const row of outcomeRead.value.items) if (row.kind === 'result') resultTitles.set(row.id, row.title);
  const proposals = (
    <div className="ws-proposals-gate" style={titlesShown ? undefined : { visibility: 'hidden' }} aria-busy={titlesShown ? undefined : true}>
    <ProjectProposals outcomes={outcomes} people={shell?.people ?? null} projectName={project.name}
      resultTitles={resultTitles}
      workCount={data?.summary.workTotal ?? 0}
      workJumpId={data?.summary.all.in_progress ? 'g-progress' : data?.summary.all.blocked ? 'g-blocked' : data?.summary.all.open ? 'g-open' : data?.summary.all.parked ? 'g-parked' : 'g-finished'}
      jumpToSection={jumpToSection} writable={writable} refresh={() => { if (listing) refresh(); else refreshBoard(); revalidator.revalidate(); }}
      openResult={(id) => openDetails({ kind: 'result', id, projectId: project.id })}
      openWork={(item) => openDetails({ kind: 'work', id: item.id, projectId: project.id })} />
    </div>
  );

  // The Decisions view is gone (F-026 S1): its old links open the Inbox's Decisions filter.
  if (retired) return <Navigate to="/inbox?show=decisions" replace state={location.state} />;
  return (
    <div className="tb-root">
      <Toolbar mode={mode} onMode={chooseMode} query={boardSearch} onQuery={setBoardSearch} mine={mine} onMine={(next) => setView({ mine: next })} writable={writable} onNew={startNew} />
      <div className="pane-scroll" ref={scroller} data-own-place="">
      {!listing ? (
        <div className="tb" data-work-observed-at={data?.summary.observedAt}>
          {parkedCount || waiting ? <nav className="tb-also" aria-label="Also elsewhere">{inboxLink}{parkedCount ? <button type="button" className="tb-also__b" onClick={() => setView({ mode: 'list', status: 'parked' })}>{parkedCount} parked by a pivot</button> : null}</nav> : null}
          <div className="tb-aside">{proposals}</div>
          <TaskBoard project={project} openRead={read} meId={me.user.id} mine={mine} query={boardSearch.trim().toLowerCase()} writable={writable}
            revision={boardRevision}
            openWork={(id) => { saveReading(); openDetails({ kind: 'work', id }); }} refresh={refreshBoard}
            showInList={(group) => { if (isGroup(group)) setView({ mode: 'list', status: group }); }}
            clearFilters={() => { setBoardSearch(''); setView({ mine: false }); }} />
        </div>
      ) : (
      <div className="pane-in ws-tasks" data-shift data-work-observed-at={data?.summary.observedAt}>
        {proposals}
        <div className="ws-task-controls">
          {phone ? (
            <div className="ws-mineall" role="group" aria-label="Whose tasks">
              <button type="button" aria-pressed={mine} onClick={() => setView({ mine: true })}>Mine</button>
              <button type="button" aria-pressed={!mine} onClick={() => setView({ mine: false, status: null })}>All</button>
            </div>
          ) : <TaskViews counts={counts} status={status} onStatus={(next) => setView({ status: next })} />}
          <WorkPagination noun="tasks" page={data} busy={read.phase !== 'ready' && read.phase !== 'unavailable'} onCursor={movePage} onRefresh={refresh} stepsWhenPaged />
        </div>
        {read.phase === 'unavailable' ? <ErrorState title="Work could not be loaded" actions={<button type="button" className="ws-none__b" onClick={refresh}>Refresh work</button>}><p>Your private draft is kept. Refresh to read the current view.</p></ErrorState> : null}
        {nothing ? <div className="view-empty"><EmptyState icon="tasks" title="No tasks yet"><p>A task starts when one of you makes it from a message, or adds it here. Not every idea has to become a task.</p></EmptyState></div> : null}
        {emptyContinuation ? <p className="ws-none" role="status">This page changed and has no rows. Use Previous or Next if available, or <button type="button" className="ws-none__b" onClick={refresh}>refresh from the start</button>.</p> : null}
        {data && !nothing && !emptyContinuation && !data.total ? <p className="ws-none" role="status">
          {mine ? `Nothing of yours${status ? ` in ${GROUP_LABEL[status].toLowerCase()}` : ''} right now.` : `Nothing in ${status ? GROUP_LABEL[status].toLowerCase() : 'this view'} right now.`}{' '}
          <button type="button" className="ws-none__b" onClick={() => setView(mine ? { mine: false } : { status: null })}>{mine ? 'Show everyone’s' : 'Show all'}</button>
        </p> : null}
        <Group id="progress" title="In progress" count={groupCount('in_progress', by('in_progress').length)}>{by('in_progress').map((item) => workRow(item))}</Group>
        <Group id="blocked" title="Blocked" count={groupCount('blocked', by('blocked').length)}>{by('blocked').map((item) => workRow(item))}</Group>
        <Group id="open" title="Open" count={groupCount('open', by('open').length)}>{by('open').map((item) => workRow(item))}</Group>
        <Group id="parked" title="Parked by a pivot" count={groupCount('parked', parked.length)}>{parked.map((item) => workRow(item, true))}</Group>
        <Group id="finished" title="Finished" count={groupCount('finished', finished.length)}>{finished.map((item) => workRow(item, true))}</Group>
      </div>
      )}
      </div>
    </div>
  );
}
