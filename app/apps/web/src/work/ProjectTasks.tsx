import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLoaderData, useLocation, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Project, ProjectWorkViewQuery, WorkItem, WorkObjectType, WorkRowProjection } from '@flux/contracts';
import { Button, EmptyState, ErrorState, Icon, MEDIA, useMediaQuery, useRowMotion } from '../ui';
import { getProject } from '../project/api';
import { WORK_EVENT, streamLive, useStreamEvents } from '../api/stream';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { remember } from '../app/remembered';
import { STATUS_LABEL, isFinished } from './format';
import { TaskRow, type TaskRowProps } from './TaskRow';
import { useStateChange } from './taskState';
import { getProjectWorkView, workViewReadUrl } from './read-api';
import { useProjectWorkPage } from './WorkReadContext';
import { WorkPagination } from './WorkPagination';
import { useWorkReadingPosition } from './useWorkReadingPosition';
import { useTaskFeedback } from './useTaskFeedback';
import { TaskBoard } from './TaskBoard';
import { useAgentOwners } from '../agents/owners';
import './work.css';
import { preferredMode, rememberMode, type TaskMode } from './taskMode';

interface TasksData { project: Project }

/** Object rows use their separate bounded page; this loader supplies the project contract. */
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

/**
 * The groups of the Tasks tab, in reading order. `status` in the URL shows one of them. Decisions wait in
 * the Inbox, not here (F-026 S1); the old `needs`, `rules`
 * and `results` views are not groups any more and their links lead to the Inbox or to All.
 */
const GROUPS = ['in_progress', 'blocked', 'open', 'finished'] as const;
type GroupId = typeof GROUPS[number];
const GROUP_LABEL: Record<GroupId, string> = {
  // "Done", the board's word for the same tasks (#763 C5); the URL keeps `finished`.
  in_progress: STATUS_LABEL.in_progress, blocked: STATUS_LABEL.blocked, open: STATUS_LABEL.open, finished: STATUS_LABEL.done,
};
const isGroup = (value: string | null): value is GroupId => GROUPS.includes(value as GroupId);

type Mode = TaskMode;

/**
 * The Tasks toolbar (S6, T2): Board | List, Mine and the search in the same places in both views, then the one
 * primary action, "+ Task", at the right end of the row. The search filters the board's loaded cards; the List is read in bounded pages from
 * the server, so its search is dimmed rather than removed, which keeps every other control where it is.
 */
function Toolbar({ mode, onMode, query, onQuery, mine, onMine, onNew }: {
  mode: Mode; onMode: (mode: Mode) => void; query: string; onQuery: (query: string) => void;
  mine: boolean; onMine: (mine: boolean) => void; onNew: () => void;
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
    <div className={`tb-bar tb-bar--${mode}`}>
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
      {/* "+ Task" is the right end of this row on every computer and tablet, in both views and every orientation (§7 Tasks, rule 7, #1366);
          the space's header holds only its own slots. The phone's floating "+" is its one Create, so the row hides it there. */}
      <Button variant="secondary" icon="plus" className="tb-add" onClick={onNew}><span className="ui-vh">New </span>Task</Button>
    </div>
  );
}

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
  const { project } = useLoaderData() as TasksData;
  const owners = useAgentOwners(project);
  const { openDetails, openCreate } = useShellActions();
  const revalidator = useRevalidator();
  const [search, setSearch] = useSearchParams();
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
    const cursor = search.get('cursor') || null;
    const asked = search.get('view');
    const mode: Mode = asked === 'board' || asked === 'list' ? asked : status || cursor ? 'list' : preferredMode(me.user.id);
    return { routeKey, status, mine: search.get('show') === 'mine', cursor: mode === 'list' ? cursor : null, mode };
  };
  const [saved, setSaved] = useState<Record<string, WorkItem>>({});
  const focusRow = useRef<{ id: string; until: number } | null>(null);
  const [stored, setViewState] = useState(fromUrl);
  const [searched, setSearched] = useState({ routeKey: `${me.user.id}:${project.id}`, text: '' });
  // A router POP, account switch or project switch selects its actual URL immediately.
  const view = stored.routeKey === routeKey ? stored : fromUrl();
  const { status: viewStatus, mine, cursor: viewCursor, mode: viewMode } = view;
  // Every device has the same control row and both views (#868): the phone's board scrolls its four columns sideways.
  const phone = useMediaQuery(MEDIA.phone);
  const status = viewStatus;
  const cursor = viewCursor;
  const listing = viewMode === 'list';
  const mode = viewMode;
  const boardSearch = searched.routeKey === `${me.user.id}:${project.id}` ? searched.text : '';
  const setBoardSearch = (text: string) => setSearched({ routeKey: `${me.user.id}:${project.id}`, text });
  // The List reads its chosen view page by page. The board's Open column is the same bounded read
  // of the open group; its other columns are read by the board (see TaskBoard).
  const query = useMemo<ProjectWorkViewQuery>(() => mode === 'list'
    ? { purpose: 'tasks', group: status ?? 'all', mine, kinds: 'work', ...(cursor ? { cursor } : {}) }
    : { purpose: 'tasks', group: 'open', mine, kinds: 'work' }, [mode, status, mine, cursor]);
  const selector = workViewReadUrl(project.id, query);
  const load = useCallback((signal: AbortSignal) => getProjectWorkView(project.id, query, signal), [project.id, query]);
  const { page: read, refresh: refreshPage } = useProjectWorkPage(project.id, selector, load);
  const data = read.phase === 'ready' || read.phase === 'refreshing' ? read.value : null;
  const counts = data ? mine ? data.summary.mine : data.summary.all : null;
  const viewKey = taskViewKey(me.user.id, project.id, status, mine);
  const readingKey = listing ? `${viewKey}:reading:${cursor ?? 'first'}` : `${taskViewKey(me.user.id, project.id, null, mine)}:board:reading`;
  const saveReading = useWorkReadingPosition(scroller, readingKey, data !== null, data?.summary.observedAt);
  // The chosen view is local state mirrored into the URL with `replaceState`: switching views is
  // instant, and back/forward or a shared link restore it. Kanban or List is a personal choice:
  // the URL names it only when it differs from that choice.
  const params = new URLSearchParams();
  if (listing && status) params.set('status', status);
  if (mine) params.set('show', 'mine');
  if (listing && cursor) params.set('cursor', cursor);
  if (mode !== (mode === 'list' && (status || cursor) ? 'list' : preference)) params.set('view', mode);
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
    saveReading();
    if (listing) keepCursor(viewKey, cursor);
    const nextStatus = next.status === undefined ? status : next.status;
    const nextMine = next.mine ?? mine;
    const nextMode = next.mode ?? mode;
    setViewState({ routeKey, status: nextStatus, mine: nextMine, mode: nextMode,
      cursor: nextMode === 'list' ? storedCursor(taskViewKey(me.user.id, project.id, nextStatus, nextMine)) : null });
  };
  const chooseMode = (next: Mode) => { setChosen({ userId: me.user.id, mode: next }); rememberMode(me.user.id, next); setView({ mode: next }); };
  const movePage = (nextCursor: string) => {
    saveReading();
    keepCursor(viewKey, nextCursor);
    setViewState({ ...view, cursor: nextCursor });
  };
  const refresh = () => {
    saveReading();
    if (listing) keepCursor(viewKey, null);
    setViewState({ ...view, cursor: null });
    refreshPage();
  };
  // The board's own column reads follow this revision as well as the router's revalidation.
  const [boardRevision, setBoardRevision] = useState(0);
  const refreshBoard = () => { refreshPage(); setBoardRevision((current) => current + 1); };
  // One tap on a glyph, or the keys 1-4 on a row, change its state; the toast offers Undo (F-026 S9).
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
    if (search.get('new') !== 'task') return;
    const next = new URLSearchParams(search);
    next.delete('new');
    setSearch(next, { replace: true, state: location.state });
    openCreate({ kind: 'task', projectId: project.id });
  }, [search, setSearch, openCreate, project.id, location.state]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') revalidator.revalidate(); };
    window.addEventListener('focus', refresh);
    // A timer only while the live stream is down (#862); while it is open, a change to this space's work reads at once (below).
    const interval = window.setInterval(() => { if (!streamLive()) refresh(); }, 15000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval); };
  }, [revalidator]);
  useStreamEvents(me.user.id, (event) => {
    if (event.objectType === 'project' && event.objectId === project.id && WORK_EVENT.test(event.kind) && document.visibilityState === 'visible') revalidator.revalidate();
  }, () => revalidator.revalidate());

  // A stored state change shows at once; the List's own read catches up with that version.
  const work = (data?.items.filter((item): item is WorkRowProjection => item.kind === 'work') ?? [])
    .map((item) => { const stored = saved[item.id]; return stored && stored.version > item.version ? { ...item, status: stored.status, blocker: stored.blocker, version: stored.version } : item; });
  const by = (state: WorkRowProjection['status']) => work.filter((item) => item.status === state);
  const finished = work.filter(isFinished);
  const groupCount = (id: GroupId, visible: number) => visible ? counts?.[id] ?? 0 : 0;
  // A task opened from its row brings its title: the panel's loading state shows it in its own place (#863 rule 6).
  const openObject = (kind: WorkObjectType, id: string, title?: string) => () => { saveReading(); openDetails({ kind, id, ...(title ? { title } : {}) }); };
  const workRow = (item: WorkRowProjection, muted = false) => <TaskRow key={item.id} item={item} meId={me.user.id} owners={owners} writable muted={muted} onOpen={openObject('work', item.id, item.title)} onChange={changeState} />;
  const nothing = data !== null && cursor === null && !Object.values(data.summary.all).some(Boolean);
  const emptyContinuation = data !== null && cursor !== null && !data.items.length;

  // A task that changes state moves to another group, a new one grows in, a finished list collapses its rows (#593 AC-4).
  useRowMotion(scroller, '.ws-task[data-work-id]', (el) => el.dataset.workId, [mode, status ?? 'all', mine, cursor ?? '', phone, read.phase === 'ready' || read.phase === 'refreshing' ? 'ready' : 'loading'].join('|'));
  return (
    <div className="tb-root">
      <Toolbar mode={mode} onMode={chooseMode} query={boardSearch} onQuery={setBoardSearch} mine={mine} onMine={(next) => setView({ mine: next })} onNew={startNew} />
      <div className="pane-scroll" ref={scroller} data-own-place="">
      {!listing ? (
        <div className="tb" data-work-observed-at={data?.summary.observedAt}>
          <TaskBoard project={project} openRead={read} meId={me.user.id} mine={mine} query={boardSearch.trim().toLowerCase()} writable
            revision={boardRevision}
            openWork={(id, title) => { saveReading(); openDetails({ kind: 'work', id, title }); }} refresh={refreshBoard}
            showInList={(group) => { if (isGroup(group)) setView({ mode: 'list', status: group }); }}
            clearFilters={() => { setBoardSearch(''); setView({ mine: false }); }} />
        </div>
      ) : (
      <div className="pane-in ws-tasks" data-work-observed-at={data?.summary.observedAt}>
        {/* The one control row above holds Mine for both views on every device (#868); a list opened on one state from the board
            says so in one line with its way back. */}
        <div className="ws-task-controls">
          {status ? <p className="ws-only">Only {GROUP_LABEL[status]} · <Button variant="link" size="sm" onClick={() => setView({ status: null })}>Show all tasks</Button></p> : null}
          <WorkPagination noun="tasks" page={data} busy={read.phase !== 'ready' && read.phase !== 'unavailable'} onCursor={movePage} onRefresh={refresh} stepsWhenPaged />
        </div>
        {read.phase === 'unavailable' ? <ErrorState title="Work could not be loaded" actions={<Button variant="secondary" onClick={refresh}>Refresh work</Button>}><p>Your private draft is kept. Refresh to read the current view.</p></ErrorState> : null}
        {nothing ? <div className="view-empty"><EmptyState icon="tasks" title="No tasks yet"><p>A task starts when one of you makes it from a message, or adds it here. Not every idea has to become a task.</p></EmptyState></div> : null}
        {emptyContinuation ? <p className="ws-none" role="status">This page changed and has no rows. Use Previous or Next if available, or <Button variant="link" size="sm" onClick={refresh}>refresh from the start</Button>.</p> : null}
        {data && !nothing && !emptyContinuation && !data.total ? <p className="ws-none" role="status">
          {mine ? `Nothing of yours${status ? ` in ${GROUP_LABEL[status]}` : ''} right now.` : `Nothing in ${status ? GROUP_LABEL[status] : 'this view'} right now.`}{' '}
          <Button variant="link" size="sm" onClick={() => setView(mine ? { mine: false } : { status: null })}>{mine ? 'Show everyone’s' : 'Show all'}</Button>
        </p> : null}
        <Group id="progress" title={GROUP_LABEL.in_progress} count={groupCount('in_progress', by('in_progress').length)}>{by('in_progress').map((item) => workRow(item))}</Group>
        <Group id="blocked" title={GROUP_LABEL.blocked} count={groupCount('blocked', by('blocked').length)}>{by('blocked').map((item) => workRow(item))}</Group>
        <Group id="open" title={GROUP_LABEL.open} count={groupCount('open', by('open').length)}>{by('open').map((item) => workRow(item))}</Group>
        <Group id="finished" title={GROUP_LABEL.finished} count={groupCount('finished', finished.length)}>{finished.map((item) => workRow(item, true))}</Group>
      </div>
      )}
      </div>
    </div>
  );
}
