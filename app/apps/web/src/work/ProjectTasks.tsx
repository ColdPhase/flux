import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLoaderData, useLocation, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { DecisionRowProjection, Project, ProjectWorkViewQuery, ResultRowProjection, WorkCounts, WorkObjectType, WorkRowProjection } from '@flux/contracts';
import { EmptyState, ErrorState, Icon } from '../ui';
import { getProject } from '../app/conversation-api';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { NewWorkComposer } from './NewWorkComposer';
import { STATUS_LABEL, isFinished, shortDate } from './format';
import { getProjectWorkView, workViewReadUrl } from './read-api';
import { useProjectWorkPage } from './WorkReadContext';
import { WorkPagination } from './WorkPagination';
import { useWorkReadingPosition } from './useWorkReadingPosition';
import './work.css';

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
  counts: WorkCounts | null; status: GroupId | null; mine: boolean; writable: boolean;
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
  const shown = GROUPS.filter((id) => !counts || counts[id] || id === status);
  return (
    <nav className="ws-views" aria-label="Task views">
      <div className="ws-views__row" ref={row}>
        <button type="button" className="ws-view" aria-pressed={!status} onClick={() => onStatus(null)}>All</button>
        {shown.map((id) => (
          <button key={id} type="button" className={`ws-view${id === 'needs' && counts?.needs ? ' ws-view--need' : ''}`} aria-pressed={status === id} onClick={() => onStatus(id)}>
            {id === 'needs' && !writable ? 'Waiting for a decision' : GROUP_LABEL[id]} <span className="ws-view__n">{counts ? counts[id] : '…'}</span>
          </button>
        ))}
      </div>
      <label className="ws-mine"><input type="checkbox" checked={mine} onChange={(event) => onMine(event.target.checked)} /> Only mine</label>
    </nav>
  );
}

function Row({ kind, id, icon, iconClass, title, sub, right, onOpen, muted }: { kind: WorkObjectType; id: string; icon: ReactNode; iconClass?: string; title: string; sub: ReactNode; right?: ReactNode; onOpen: () => void; muted?: boolean }) {
  return (
    <li data-work-kind={kind} data-work-id={id}>
      <button type="button" className={`ws-item${muted ? ' ws-item--muted' : ''}`} onClick={onOpen}>
        <span className={`ws-item__st ${iconClass ?? ''}`} aria-hidden="true">{icon}</span>
        <span className="ws-item__b"><span className="ws-item__t">{title}</span><span className="ws-item__s">{sub}</span></span>
        {right ? <span className="ws-item__r">{right}</span> : null}
      </button>
    </li>
  );
}

function workSub(item: WorkRowProjection) {
  const { rule, parkedBy } = item;
  const results = item.relations.results;
  const fromMessage = item.relations.sourceMessages > 0;
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

export function ProjectTasks() {
  const { project } = useLoaderData() as TasksData;
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const [search, setSearch] = useSearchParams();
  const { me } = useShellData();
  const scroller = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const routeKey = `${me.user.id}:${project.id}:${location.key}`;
  const fromUrl = () => ({ routeKey, status: isGroup(search.get('status')) ? search.get('status') as GroupId : null, mine: search.get('show') === 'mine', cursor: search.get('cursor') || null });
  const [stored, setViewState] = useState(fromUrl);
  // A router POP, account switch or project switch selects its actual URL immediately.
  const view = stored.routeKey === routeKey ? stored : fromUrl();
  const { status, mine, cursor } = view;
  const query = useMemo<ProjectWorkViewQuery>(() => ({ purpose: 'tasks', group: status ?? 'all', mine, ...(cursor ? { cursor } : {}) }), [status, mine, cursor]);
  const selector = workViewReadUrl(project.id, query);
  const load = useCallback((signal: AbortSignal) => getProjectWorkView(project.id, query, signal), [project.id, query]);
  const { page: read, refresh: refreshPage } = useProjectWorkPage(project.id, selector, load);
  const data = read.phase === 'ready' || read.phase === 'refreshing' ? read.value : null;
  const writable = (data?.summary.access ?? project.access) !== 'viewer';
  const counts = data ? mine ? data.summary.mine : data.summary.all : null;
  const viewKey = taskViewKey(me.user.id, project.id, status, mine);
  const saveReading = useWorkReadingPosition(scroller, `${viewKey}:reading:${cursor ?? 'first'}`, data !== null, data?.summary.observedAt);

  useEffect(() => {
    keepCursor(viewKey, cursor);
    const url = new URL(window.location.href);
    url.searchParams.delete('status'); url.searchParams.delete('show'); url.searchParams.delete('cursor');
    if (status) url.searchParams.set('status', status);
    if (mine) url.searchParams.set('show', 'mine');
    if (cursor) url.searchParams.set('cursor', cursor);
    const remembered = new URLSearchParams(url.search);
    remembered.delete('open');
    try { sessionStorage.setItem(`flux.project-tasks.${me.user.id}.${project.id}`, remembered.toString() ? `?${remembered}` : ''); } catch { /* Visit-local controls still work. */ }
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [viewKey, cursor, status, mine, me.user.id, project.id, location.search]);

  const setView = (next: { status?: GroupId | null; mine?: boolean }) => {
    saveReading();
    keepCursor(viewKey, cursor);
    const nextStatus = next.status === undefined ? status : next.status;
    const nextMine = next.mine ?? mine;
    setViewState({ routeKey, status: nextStatus, mine: nextMine, cursor: storedCursor(taskViewKey(me.user.id, project.id, nextStatus, nextMine)) });
  };
  const movePage = (nextCursor: string) => {
    saveReading();
    keepCursor(viewKey, nextCursor);
    setViewState({ ...view, cursor: nextCursor });
  };
  const refresh = () => {
    saveReading();
    keepCursor(viewKey, null);
    setViewState({ ...view, cursor: null });
    refreshPage();
  };

  const open = search.get('open');
  useEffect(() => {
    const match = /^(work|decision|result):([0-9a-f-]{36})$/i.exec(open ?? '');
    if (!match) return;
    openDetails({ kind: match[1] as WorkObjectType, id: match[2]! });
    const current = new URLSearchParams(window.location.search);
    current.delete('open');
    setSearch(current, { replace: true });
  }, [open, openDetails, setSearch]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') revalidator.revalidate(); };
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 15000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval); };
  }, [revalidator]);

  const work = data?.items.filter((item): item is WorkRowProjection => item.kind === 'work') ?? [];
  const decisions = data?.items.filter((item): item is DecisionRowProjection => item.kind === 'decision') ?? [];
  const results = data?.items.filter((item): item is ResultRowProjection => item.kind === 'result') ?? [];
  const by = (state: WorkRowProjection['status']) => work.filter((item) => item.status === state && !item.parked);
  const parked = work.filter((item) => item.parked && !isFinished(item));
  const finished = work.filter(isFinished);
  const proposed = decisions.filter((item) => item.status === 'proposed');
  const current = decisions.filter((item) => item.status === 'accepted');
  const earlier = decisions.filter((item) => item.status === 'superseded');
  const groupCount = (id: GroupId, visible: number) => visible ? counts?.[id] ?? 0 : 0;
  const openObject = (kind: WorkObjectType, id: string) => () => { saveReading(); openDetails({ kind, id }); };
  const workRow = (item: WorkRowProjection, muted = false) => <Row key={item.id} kind="work" id={item.id} icon={dot(item.parked ? 'parked' : item.status)} title={item.title} sub={workSub(item)} right={item.owner ? <span className="ws-av" aria-hidden="true">{item.owner.name.slice(0, 1)}</span> : null} onOpen={openObject('work', item.id)} muted={muted} />;
  const nothing = data !== null && cursor === null && !Object.values(data.summary.all).some(Boolean);
  const emptyContinuation = data !== null && cursor !== null && !data.items.length;

  return (
    <div className="pane-scroll" ref={scroller}>
      <div className="pane-in ws-tasks" data-shift data-work-observed-at={data?.summary.observedAt}>
        {writable ? <NewWorkComposer key={`${me.user.id}:${project.id}`} userId={me.user.id} projectId={project.id} /> : null}
        <div className="ws-task-controls">
          <TaskViews counts={counts} status={status} mine={mine} writable={writable} onStatus={(next) => setView({ status: next })} onMine={(next) => setView({ mine: next })} />
          <WorkPagination page={data} busy={read.phase !== 'ready' && read.phase !== 'unavailable'} onCursor={movePage} onRefresh={refresh} />
        </div>
        {read.phase === 'unavailable' ? <ErrorState title="Work could not be loaded" actions={<button type="button" className="ws-none__b" onClick={refresh}>Refresh work</button>}><p>Your private draft is kept. Refresh to read the current view.</p></ErrorState> : null}
        {nothing ? <div className="view-empty"><EmptyState icon="tasks" title="No work yet"><p>Work starts when one of you makes it from a message, or adds it here. Not every idea has to become a task.</p></EmptyState></div> : null}
        {emptyContinuation ? <p className="ws-none" role="status">This page changed and has no rows. Use Previous or Next if available, or <button type="button" className="ws-none__b" onClick={refresh}>refresh from the start</button>.</p> : null}
        {data && !nothing && !emptyContinuation && !data.total ? <p className="ws-none" role="status">
          {mine ? `Nothing of yours${status ? ` in ${GROUP_LABEL[status].toLowerCase()}` : ''} right now.` : `Nothing in ${status ? GROUP_LABEL[status].toLowerCase() : 'this view'} right now.`}{' '}
          <button type="button" className="ws-none__b" onClick={() => setView(mine ? { mine: false } : { status: null })}>{mine ? 'Show everyone’s' : 'Show all'}</button>
        </p> : null}
        <Group id="proposed" title={writable ? 'Needs you' : 'Waiting for a decision'} count={groupCount('needs', proposed.length)}>
          {proposed.map((item) => <Row key={item.id} kind="decision" id={item.id} icon={<Icon name="rule" size={16} />} iconClass="ws-need" title={item.title} sub={<>Proposed by {item.proposedBy.name}{item.proposedBy.kind === 'agent' ? ' (agent)' : ''}{item.supersedes ? ' · would replace the current rule' : ''}{writable ? <> · <span className="ws-need">you can accept it</span></> : null}</>} right={shortDate(item.createdAt)} onOpen={openObject('decision', item.id)} />)}
        </Group>
        <Group id="progress" title="In progress" count={groupCount('in_progress', by('in_progress').length)}>{by('in_progress').map((item) => workRow(item))}</Group>
        <Group id="blocked" title="Blocked" count={groupCount('blocked', by('blocked').length)}>{by('blocked').map((item) => workRow(item))}</Group>
        <Group id="open" title="Open" count={groupCount('open', by('open').length)}>{by('open').map((item) => workRow(item))}</Group>
        <Group id="parked" title="Parked by a pivot" count={groupCount('parked', parked.length)}>{parked.map((item) => workRow(item, true))}</Group>
        <Group id="finished" title="Finished" count={groupCount('finished', finished.length)}>{finished.map((item) => workRow(item, true))}</Group>
        <Group id="rules" title="Decisions" count={groupCount('rules', current.length + earlier.length)}>
          {current.map((item) => <Row key={item.id} kind="decision" id={item.id} icon={<Icon name="rule" size={16} />} title={item.title} sub={`Current rule · ${item.decidedBy?.name ?? ''} · ${shortDate(item.decidedAt!)}`} onOpen={openObject('decision', item.id)} />)}
          {earlier.map((item) => <Row key={item.id} kind="decision" id={item.id} icon={<Icon name="rule" size={16} />} title={item.title} sub={`Earlier rule · replaced ${shortDate(item.supersededAt!)}`} onOpen={openObject('decision', item.id)} muted />)}
        </Group>
        <Group id="results" title="Results" count={groupCount('results', results.length)}>
          {results.map((item) => <Row key={item.id} kind="result" id={item.id} icon={<Icon name="result" size={16} />} iconClass={item.finding === 'negative' ? 'ws-neg' : 'ws-pos'} title={item.title} sub={`${item.finding === 'negative' ? 'Negative' : 'Positive'} · ${item.createdBy.name}`} right={shortDate(item.createdAt)} onOpen={openObject('result', item.id)} />)}
        </Group>
      </div>
    </div>
  );
}
