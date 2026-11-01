import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ProjectPerson } from '@flux/contracts';
import { Outlet, useLocation, useMatches, useNavigate, useNavigationType, useParams, useRevalidator } from 'react-router';
import { useStreamEvents } from '../api/stream';
import { WORKSPACE_LOCKED_DOM_EVENT, isEncryptionEvent } from '../encryption/api';
import { useLockedPlace } from '../encryption/state';
import { Dissolve, Drawer, IconButton, MEDIA, SidePanel, SizeSwap, Tabs, flip, setTravelDirection, useMediaQuery, useToast, useSidePanelMode, viewDirection } from '../ui';
import { routeView } from '../ui/motion-rules';
import { useShellData } from './data';
import { registerServiceWorker, syncPushSubscription } from '../pwa';
import { DeferredDetails, DeferredJumpTo, DeferredLiveStage } from './DeferredSurfaces';
import { RouteProgress } from './RouteProgress';
import { useInboxDot } from '../notifications/dot';
import { placeOf } from './place';
import { placeOfPath, rememberPlace } from '../search/recent';
import { ShellContext, isOwned, type CreateRequest, type DetailsView, type OwnedPanel } from './shellContext';
import { arrivalEntry, entryOf, onFlush, recall, remember as keepPlace, setCurrentEntry } from '../place/memory';
import { RouteOriginBack, useGoToOrigin, useRouteOrigin } from '../place/origin';
import { restoreTop, usePaneMemory } from '../place/scroll';
import { Sidebar } from './Sidebar';
import { startCapture, viewIndex } from './views';
import { PROJECT_VIEWS, WORKSPACE_AI_POLICY_CHANGED_EVENT, type ProjectViewId } from '@flux/contracts';
import { addProjectView } from '../project/api';
import { addableViews, audienceLine, shownViews, useProjectShell } from '../project/data';
import { useDmSketchCount } from '../dm/useDmSketchCount';
import { LiveProvider } from '../live/LiveProvider';
import { LiveEntry } from '../live/LiveEntry';
import { LiveBar } from '../live/LiveBar';
import '../live/live.css';
import { CreateHost } from '../create/CreateWindow';
import './project-header.css';
import { WorkReadProvider, useProjectWorkSummary } from '../work/WorkReadContext';
import { OverviewContext } from '../project/OverviewContext';
import { remember, remembered } from './remembered';
import { ProjectAgentStop } from './WorkingAgent';
import { useWorkspaceAi } from '../ai/workspaceAi';
import { useFocus } from './focus';
import { FocusPill, HeaderFaces, MoreMenu, NeedsYouChip, type MoreItem } from './HeaderParts';
import { PhoneAvatar, PhoneBack, PhoneCreate, PhoneDock, PhoneHomeLead, PhoneTitleMenu, phoneHidesDock, phoneOffersCreate, phonePlaces, type PhoneMenuItem } from './PhoneChrome';

const lastConversationPath = (userId: string, projectId: string) => remembered('conversation', userId, projectId) ?? `/projects/${projectId}`;
/** The Tasks view last chosen in this project (#136), e.g. `?status=blocked&show=mine`. */
const lastTasksSearch = (userId: string, projectId: string) => remembered('tasks', userId, projectId) ?? '';
/**
 * The Map's last place in this project (#189): its list or the sketch that was open; before any, a
 * project's only sketch opens directly.
 */
function lastMapPath(userId: string, projectId: string, sketches: { items: { id: string }[]; total: number } | null | undefined) {
  const only = sketches?.total === 1 ? sketches.items[0] : undefined;
  return remembered('map', userId, projectId) ?? (only ? `/projects/${projectId}/map/${only.id}` : `/projects/${projectId}/map`);
}

const PROJECT_VIEW_NAMES = ['Conversation', 'Map', 'Tasks', 'Wiki', 'Agents'];
const VIEW_LABEL: Record<ProjectViewId, string> = { map: 'Map', docs: 'Wiki', agents: 'Agents' };
const VIEW_PATH: Record<ProjectViewId, string> = { map: 'map', docs: 'docs', agents: 'agents' };

/** Tab order for the slide direction: Home's views, or a project's Conversation · Map · Tasks · Wiki · Agents. */
function viewOrder(pathname: string) {
  const inProject = pathname.match(/^\/projects\/[^/]+(?:\/(tasks|map|docs|agents))?/);
  if (inProject) return ['conversation', 'map', 'tasks', 'docs', 'agents'].indexOf(inProject[1] ?? 'conversation');
  // A direct message's Messages · Sketches (#96).
  const inDm = pathname.match(/^\/dm\/(?!new$)[^/]+(\/sketches)?/);
  if (inDm) return inDm[1] ? 1 : 0;
  return viewIndex(pathname);
}

const SIDEBAR_KEY = 'flux.sidebar';
/** The width the sidebar settles at when it is full and when it is the rail (tokens.css). */
const SIDE_WIDTHS = { full: '--side-w', rail: '--rail-w' } as const;

/** A view that takes the panel's whole content: opening another one over it leaves "‹ back" (Spokój rule 2). */
const REPLACING = new Set(['owned', 'thought-tasks', 'work', 'decision', 'result', 'attach-result', 'propose-decision']);
const replaces = (view: DetailsView) => typeof view === 'object' && REPLACING.has(view.kind);
const KIND_LABEL: Record<string, string> = { work: 'Task', decision: 'Decision', result: 'Result', 'thought-tasks': 'Tasks' };

/** The place a panel's content belongs to (#763 H11-8): one project or direct message with all its views, else the page itself. */
const panelPlace = (pathname: string) => /^\/(?:projects|dm|spaces)\/[^/]+/.exec(pathname)?.[0] ?? pathname.replace(/\/+$/, '');

const NO_ORIGIN = { key: '', path: '/', label: '' };
/** What a history entry keeps of its panel (#592): an object the panel shows over the page and the way back it left. A thread or an agent a view owns is kept by its own route. */
interface DetailsPlace { open: boolean; view: DetailsView; trail: { label: string; view: DetailsView }[]; scroll: number; owned: boolean }
const panelScrollNow = () => document.querySelector<HTMLElement>('#details .ui-panel__body')?.scrollTop ?? 0;
/**
 * What is kept of a panel view (#592): ids only. A message's text, a thought's text or the fields of a form (Propose a decision,
 * Attach a result, Add to docs, Make it a project) are never written to storage; a view that is not kept shows as a closed panel.
 */
const KEPT_VIEWS = new Set(['work', 'decision', 'result', 'overview', 'recap', 'people', 'owned']);
const persistable = (view: DetailsView): DetailsView | null => {
  if (view === 'place' || view === 'connect-ai') return view;
  if (typeof view !== 'object' || !KEPT_VIEWS.has(view.kind)) return null;
  return view.kind === 'overview' ? { kind: 'overview', ...(view.messageId ? { messageId: view.messageId } : {}), ...(view.focus ? { focus: view.focus } : {}) } : view;
};
const placeOfDetails = (open: boolean, view: DetailsView, trail: { label: string; view: DetailsView }[]): DetailsPlace => {
  const shown = persistable(view);
  const owned = isOwned(view) || trail.some((entry) => isOwned(entry.view));
  if (!shown) return { open: false, view: 'place', trail: [], scroll: 0, owned };
  return { open, view: shown, scroll: panelScrollNow(), owned,
    trail: trail.flatMap((entry) => { const kept = persistable(entry.view); return kept ? [{ label: entry.label, view: kept }] : []; }) };
};
const isPanelView = (value: unknown): value is DetailsView => value === 'place' || value === 'connect-ai' || (!!value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string');
function isDetailsPlace(value: unknown): value is DetailsPlace {
  if (!value || typeof value !== 'object') return false;
  const kept = value as Partial<DetailsPlace>;
  return typeof kept.open === 'boolean' && typeof kept.owned === 'boolean' && isPanelView(kept.view) && Number.isFinite(kept.scroll)
    && Array.isArray(kept.trail) && kept.trail.every((entry) => !!entry && typeof entry.label === 'string' && isPanelView(entry.view));
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest?.('[role="combobox"], [role="listbox"]'));
}

/**
 * Authenticated frame: one sidebar on the outer background and a rounded panel with
 * the place's header, its view tabs and the work area, plus a Details panel closed by default.
 * At 680px and below the sidebar becomes a drawer and the sheet fills the screen; the panel
 * overlays below 1000px and becomes a full-screen sheet on the phone.
 */
export function AppLayout() {
  const { me } = useShellData();
  const { projectId } = useParams();
  return <WorkReadProvider accountId={me.user.id} projectId={projectId ?? null}><AppLayoutContent /></WorkReadProvider>;
}

function AppLayoutContent() {
  const { me, workspace, workspaces, lockedWorkspaces, projects, directMessages } = useShellData();
  // F-030 (#655): the workspaces that wait to be unlocked, as the latest read has them, for the handler of `423` below.
  const lockedNow = useRef(lockedWorkspaces);
  useLayoutEffect(() => { lockedNow.current = lockedWorkspaces; });
  const lockedPlaceId = useLockedPlace();
  const location = useLocation();
  const navType = useNavigationType();
  // The entry on show, for everything that keeps or finds a place (#592). Set while rendering, so effects of this
  // render and its children already see their own entry.
  setCurrentEntry(entryOf(location));
  const routeOrigin = useRouteOrigin();
  const backgroundSettings = location.pathname === '/settings/background-compute';
  const aiConnections = location.pathname === '/settings/ai-connections';
  // A page inside Settings (#266 PF-5): on the phone its header leads back instead of opening the drawer.
  const settingsPage = /^\/settings\/./.test(location.pathname);
  // Back from a direct link goes to the page that leads there: the AI pages to Agents and AI (#513).
  const settingsParent = /^\/settings\/(assistant|background-compute|ai-connections|agents\/connect)(\/|$)/.test(location.pathname) ? '/settings/agents'
    : /^\/settings\/people\/./.test(location.pathname) ? '/settings/people' : '/settings';
  const navDrawer = useMediaQuery(MEDIA.navDrawer);
  const tablet = useMediaQuery(MEDIA.tablet);
  const phone = useMediaQuery(MEDIA.phone);
  const panelMode = useSidePanelMode();
  const [navOpen, setNavOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsView, setDetailsView] = useState<DetailsView>('place');
  // The panel opens at the height it was left at, and its body at the place it was left at, when its entry is returned to (#592).
  const [sheetStart, setSheetStart] = useState<boolean | null>(null);
  const [panelScrollTo, setPanelScrollTo] = useState<{ top: number } | null>(null);
  const [detailsAccount, setDetailsAccount] = useState(me.user.id);
  if (detailsAccount !== me.user.id) { setDetailsAccount(me.user.id); setDetailsView('place'); setDetailsOpen(false); }
  const [jumpOpen, setJumpOpen] = useState(false);
  // The phone's "+" sheet (#341) and the one Create window (#345) are separate: the sheet's Task opens the window.
  const [createOpen, setCreateOpen] = useState(false);
  const [create, setCreate] = useState<CreateRequest | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const drawerTitleId = useId();

  // One panel for a task, a decision, an agent and a thread (F-026 S4, Spokój rule 2): opening another object from it
  // replaces its content and leaves "‹ back", one step at a time; a thread or an agent a view owns takes the same place.
  const [owned, setOwned] = useState<OwnedPanel | null>(null);
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
  const [trail, setTrail] = useState<{ label: string; view: DetailsView }[]>([]);

  const toggleDetails = useCallback((next?: boolean) => {
    const open = next ?? !detailsOpen;
    if (open === detailsOpen) return;
    if (open) setNavOpen(false);
    if (!open) setTrail([]);
    if (panelMode !== 'docked') { setDetailsOpen(open); return; }
    // Docked: the work area shifts over smoothly instead of jumping (FLIP).
    const finish = flip([...document.querySelectorAll('[data-shift]')]);
    flushSync(() => setDetailsOpen(open));
    finish();
  }, [detailsOpen, panelMode]);

  const ownedRef = useRef<OwnedPanel | null>(null);
  const closeRef = useRef<() => void>(() => undefined);
  const now = useRef({ detailsOpen, detailsView, toggleDetails });
  useLayoutEffect(() => { now.current = { detailsOpen, detailsView, toggleDetails }; });
  // The open object names itself for the way back ("Task #2"); without a name its kind does.
  const panelLabel = useRef<string | null>(null);
  const labelOf = useCallback((view: DetailsView) => panelLabel.current ?? (typeof view === 'object' ? (view.kind === 'owned' ? ownedRef.current?.chip : KIND_LABEL[view.kind]) : undefined) ?? 'Back', []);
  const showPanel = useCallback((panel: OwnedPanel) => {
    const current = now.current;
    // A thread that replaces a task keeps the way back to it; another registration of the same view does not.
    if (current.detailsOpen && replaces(current.detailsView) && (current.detailsView as { kind: string }).kind !== 'owned') {
      setTrail((list) => [...list, { label: labelOf(current.detailsView), view: current.detailsView }]);
    }
    ownedRef.current = panel;
    setOwned(panel);
    setDetailsView({ kind: 'owned' });
    now.current = { ...current, detailsView: { kind: 'owned' } };
    if (!current.detailsOpen) current.toggleDetails(true);
  }, [labelOf]);
  const reopenPanel = useCallback((key: string) => {
    if (ownedRef.current?.key !== key) return;
    const current = now.current;
    if (current.detailsOpen && isOwned(current.detailsView)) return;
    // It takes the place of a task or decision that covers it, which keeps the way back.
    if (current.detailsOpen && replaces(current.detailsView)) setTrail((list) => [...list, { label: labelOf(current.detailsView), view: current.detailsView }]);
    setDetailsView({ kind: 'owned' });
    now.current = { ...current, detailsView: { kind: 'owned' } };
    if (!current.detailsOpen) current.toggleDetails(true);
  }, [labelOf]);
  const hidePanel = useCallback((key: string) => {
    if (ownedRef.current?.key !== key) return;
    ownedRef.current = null;
    // A view that swaps one owned panel for another unregisters and registers in one step: only a panel still unowned closes.
    queueMicrotask(() => {
      if (ownedRef.current) return;
      setOwned(null);
      const view = now.current.detailsView;
      if (typeof view === 'object' && view.kind === 'owned') { setDetailsOpen(false); setTrail([]); }
      setTrail((list) => list.filter((entry) => !(typeof entry.view === 'object' && entry.view.kind === 'owned')));
    });
  }, []);

  // Refresh this browser's push subscription for the signed-in account; it never prompts (#41).
  useEffect(() => {
    void registerServiceWorker().then((registration) => {
      if (registration) void syncPushSubscription().catch(() => undefined);
    });
  }, [me.user.id]);

  // New or changed direct messages refresh the sidebar list (#107). An open DM refetches itself.
  const revalidator = useRevalidator();
  const toast = useToast();
  // Map, Wiki and Agents appear when needed; More adds one on purpose (#351, S21) and opens it.
  // The answer may come after the person has moved on: the change stays, but only someone still in that
  // project is taken to its new view (or told it failed).
  const addView = async (projectId: string, view: ProjectViewId) => {
    const stillHere = () => window.location.pathname.startsWith(`/projects/${projectId}`);
    try {
      await addProjectView(projectId, view);
      revalidator.revalidate();
      if (stillHere()) navigate(`/projects/${projectId}/${VIEW_PATH[view]}`);
    } catch {
      if (stillHere()) toast({ message: `${VIEW_LABEL[view]} couldn’t be added. Try again in a moment.`, tone: 'danger' });
    }
  };
  // F-029 (#614): a workspace's AI was turned off or on (the stream), or a refusal says so: the shell reads the policy again.
  // Coming back to the tab does too, at most once a minute, so a missed event never leaves AI showing for long.
  const revalidate = revalidator.revalidate;
  useEffect(() => {
    let last = Date.now();
    const refresh = () => { last = Date.now(); void revalidate(); };
    const back = () => { if (document.visibilityState === 'visible' && Date.now() - last > 60_000) refresh(); };
    // A refusal for AI that the next read does not end (a place of a space that waits to be unlocked keeps answering 403 to its
    // AI reads) must not start one read after another: at most one in a few seconds, as for `423` below.
    let lastAiRefusal = 0;
    const aiBlocked = () => { if (Date.now() - lastAiRefusal < 3000) return; lastAiRefusal = Date.now(); refresh(); };
    window.addEventListener('flux:workspace-ai-blocked', aiBlocked);
    // F-030 (#655): a place answered `423` because its encrypted workspace locked since the shell last read it. A workspace the
    // shell already shows as locked teaches nothing new: the locked panel's own reads answer `423` again, and each answer must
    // not start another read. A shell that still shows it unlocked is read again, at most once in a few seconds.
    let lastRefusal = 0;
    const locked = (event: Event) => {
      const id = (event as CustomEvent<{ workspaceId: string | null }>).detail?.workspaceId;
      if ((id && lockedNow.current.some((space) => space.id === id)) || Date.now() - lastRefusal < 3000) return;
      lastRefusal = Date.now();
      refresh();
    };
    window.addEventListener(WORKSPACE_LOCKED_DOM_EVENT, locked);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('flux:workspace-ai-blocked', aiBlocked);
      window.removeEventListener(WORKSPACE_LOCKED_DOM_EVENT, locked);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [revalidate]);
  useStreamEvents(me.user.id, (event) => {
    if (event.kind === WORKSPACE_AI_POLICY_CHANGED_EVENT) { revalidator.revalidate(); return; }
    // An encrypted workspace was unlocked or locked (F-030, #655): its places turn into the locked panel, or back, without a reload.
    if (isEncryptionEvent(event.kind)) { revalidator.revalidate(); return; }
    // Access was given or taken (#763 FT-8): Home, Projects and the sidebar list the person's projects again at once.
    if (event.kind === 'project.grant_set.v1' || event.kind === 'project.grant_revoked.v1') { revalidator.revalidate(); return; }
    // A project goal changed (#520): the open project's Details, view menu and conversation read it again.
    if (event.objectType === 'project' && event.kind.startsWith('project.goal_') && location.pathname.startsWith(`/projects/${event.objectId}`)) { revalidator.revalidate(); return; }
    // Someone saw a message (#534): only the open conversation shows it, and it asks for itself.
    if (event.objectType !== 'dm' || event.kind === 'dm.observed.v1') return;
    const known = directMessages.some((dm) => dm.id === event.objectId);
    if (!known || event.kind !== 'dm.message_sent.v1' || location.pathname === '/dm') revalidator.revalidate();
  }, () => revalidator.revalidate());

  const inboxCounts = useInboxDot(me.user.id, location.pathname);
  const inboxUnread = inboxCounts.count;
  // The computer's sidebar collapses to its 64px rail with "[" (F-026 S19), remembered on this device.
  const [railed, setRailed] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) === 'rail'; } catch { return false; } });
  const toggleRail = useCallback(() => setRailed((current) => {
    const next = !current;
    try { if (next) localStorage.setItem(SIDEBAR_KEY, 'rail'); else localStorage.removeItem(SIDEBAR_KEY); } catch { /* this visit only */ }
    return next;
  }), []);
  // Focus mode (`F`, F-026 S19): the rail, a quiet header, and push and email held by the server.
  const focus = useFocus(me.user.id);
  const focusing = !!focus.until && !phone;
  const toggleFocus = focus.toggle;
  // "[", the sidebar control and the More menu share one rule: under Focus, ending Focus shows the sidebar (F-026 rule 7).
  const toggleSidebar = useCallback(() => { if (focusing) void toggleFocus(); else toggleRail(); }, [focusing, toggleFocus, toggleRail]);

  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const detailsOwner = useMemo(() => ({ accountId: me.user.id, projectId }), [me.user.id, projectId]);
  const detailsScope = useRef<typeof detailsOwner | null>(detailsOwner);
  useLayoutEffect(() => { detailsScope.current = detailsOwner; return () => { detailsScope.current = null; }; }, [detailsOwner]);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const [metadataSlot, setMetadataSlot] = useState<HTMLElement | null>(null);
  const [viewMenuMetadataSlot, setViewMenuMetadataSlot] = useState<HTMLElement | null>(null);
  const panelGuard = useRef<(() => boolean) | null>(null);
  const shell = useMemo(() => ({
    openDetails(view: DetailsView = 'place', options?: { back?: 'push' | 'keep' }) {
      if (detailsScope.current !== detailsOwner) return;
      const next = typeof view === 'object' && 'id' in view ? { ...view, projectId: view.projectId ?? projectId } : view;
      const current = now.current;
      // Opened from the panel, an object replaces the one shown and keeps the way back; so does anything that takes the place of a
      // thread or an agent a view owns, which has no other way back. Any other opening starts afresh.
      const covers = current.detailsOpen && isOwned(current.detailsView) && ownedRef.current && !isOwned(next);
      if (options?.back !== 'keep' && ((options?.back === 'push' && current.detailsOpen && replaces(current.detailsView) && replaces(next)) || covers)) {
        setTrail((list) => [...list, { label: labelOf(current.detailsView), view: current.detailsView }]);
      } else if (options?.back !== 'keep') setTrail([]);
      panelLabel.current = null;
      setDetailsView(next);
      now.current = { ...current, detailsView: next };
      toggleDetails(true);
    },
    /** The open object's name for "‹ back" from the next one ("Task #2"). */
    labelPanel(label: string | null) { panelLabel.current = label; },
    showPanel, hidePanel, reopenPanel, closePanel: () => closeRef.current(), guardPanel(guard: (() => boolean) | null) { panelGuard.current = guard; }, panelSlot, panelKey: detailsOpen && isOwned(detailsView) ? owned?.key ?? null : null,
    /** On the phone a request that does not yet say what to create opens the "+" sheet first (#341). */
    openCreate(request: CreateRequest = {}) { setNavOpen(false); setJumpOpen(false); if (phone && !request.kind) setCreateOpen(true); else setCreate(request); },
    openSearch() { setNavOpen(false); setJumpOpen(true); },
    openNavigation() { setDetailsOpen(false); setNavOpen(true); },
    actionSlot,
    metadataSlot, viewMenuMetadataSlot,
    toggleFocus() { void toggleFocus(); },
    toggleSidebar,
    sidebarHidden: railed || focusing,
  }), [toggleDetails, actionSlot, metadataSlot, viewMenuMetadataSlot, projectId, detailsOwner, toggleSidebar, railed, toggleFocus, focusing, showPanel, hidePanel, reopenPanel, panelSlot, detailsOpen, detailsView, owned, labelOf]);

  // A link inside an overlaid panel or sheet (#117 overview) leads to its destination.
  const [shownPath, setShownPath] = useState(location.pathname);
  if (shownPath !== location.pathname) {
    setShownPath(location.pathname);
    // A link in the panel that leads to a thread or back to a task keeps the panel (its state says so).
    const keep = (location.state as { keepPanel?: boolean } | null)?.keepPanel === true;
    if (((panelMode !== 'docked' && !keep) || backgroundSettings || aiConnections) && detailsOpen) setDetailsOpen(false);
    // A docked panel that shows an object or a form of the place being left does not follow the person to another place
    // (#763 H11-8): it closes and its "‹ back" trail goes with it, so Details opened there is that place's. The place's
    // own Details ('place') reads the new place by itself; a view-owned thread or agent is closed by its view.
    if (!keep && typeof detailsView === 'object' && !isOwned(detailsView) && panelPlace(shownPath) !== panelPlace(location.pathname)) {
      if (detailsOpen) setDetailsOpen(false);
      setDetailsView('place'); setTrail([]);
    }
  }
  // Back, Forward or the way back to an entry restores the object its panel showed, the way back it left, whether it was open
  // and how far it was scrolled (#592). A thread or an agent a view owns is kept by its own route, so it is not restored here.
  const [shownKey, setShownKey] = useState(location.key);
  if (shownKey !== location.key) {
    setShownKey(location.key);
    const arrival = arrivalEntry(location, navType);
    const kept = arrival ? recall<unknown>('details', arrival) : undefined;
    if (arrival && isDetailsPlace(kept) && !kept.owned) {
      setDetailsView(kept.view); setTrail(kept.trail); setDetailsOpen(kept.open);
      if (kept.open && kept.scroll > 0) setPanelScrollTo({ top: kept.scroll });
    }
    if (arrival) { const height = recall<unknown>('sheet', arrival); setSheetStart(typeof height === 'boolean' ? height : null); }
  }
  const trailNow = useRef(trail);
  useEffect(() => { trailNow.current = trail; });
  useEffect(() => {
    keepPlace('details', placeOfDetails(detailsOpen, detailsView, trail));
  }, [location.key, detailsOpen, detailsView, trail]);
  // The panel's own reading position is kept as it scrolls, and put back with the object it belongs to.
  useEffect(() => {
    const body = () => document.querySelector<HTMLElement>('#details .ui-panel__body');
    const write = () => keepPlace('details', placeOfDetails(now.current.detailsOpen, now.current.detailsView, trailNow.current));
    const onScroll = (event: Event) => { if (event.target === body()) write(); };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const unflush = onFlush(write);
    return () => { document.removeEventListener('scroll', onScroll, true); unflush(); };
  }, []);
  useLayoutEffect(() => {
    if (!panelScrollTo) return;
    return restoreTop(() => document.querySelector<HTMLElement>('#details .ui-panel__body'), panelScrollTo.top);
  }, [panelScrollTo]);
  usePaneMemory(paneRef, location, navType);
  // `?open=work:<id>` (a notification's link, #116, a search result, #114, or a doc reference, #112)
  // opens that object in Details on its project; `?open=people` (a new project, #188) opens its
  // "Who can see this". Each address is handled once, and the flag leaves it without reloading the
  // page's data: that navigation finishes at once, so no load of this page is left running that
  // could land after the person has moved on or signed out.
  const navigate = useNavigate();
  // Closing the Details panel by any path (Esc, the close control, a sheet's scrim, a toggle) while the agents' address names
  // a thread or a task leaves that param behind: a click during the hand-over closes the task's panel before the thread's
  // owner is registered, and nothing else clears the address (#709). Only the open-to-closed change counts, so a reload on
  // `?thread=` (the panel not yet shown) keeps it.
  const wasDetailsOpen = useRef(detailsOpen);
  useEffect(() => {
    const was = wasDetailsOpen.current;
    wasDetailsOpen.current = detailsOpen;
    if (!was || detailsOpen || !/\/agents\/?$/.test(location.pathname)) return;
    const search = new URLSearchParams(location.search);
    if (!search.has('thread') && !search.has('task')) return;
    search.delete('thread');
    search.delete('task');
    const query = search.toString();
    void navigate({ pathname: location.pathname, search: query ? `?${query}` : '', hash: location.hash }, { replace: true, state: location.state });
  }, [detailsOpen, location, navigate]);
  const openedAt = useRef<string | null>(null);
  useEffect(() => {
    if (openedAt.current === location.key) return;
    const params = new URLSearchParams(location.search);
    const open = params.get('open') ?? '';
    const match = /^(work|decision|result):([0-9a-f-]{36})$/i.exec(open);
    const people = open === 'people' && /^\/projects\/[^/]+/.test(location.pathname);
    // The phone's "+" Create → Decision (F-026 S2) opens "Propose a decision" on its project.
    const propose = open === 'propose-decision' && projectId ? projectId : null;
    if (!match && !people && !propose) return;
    openedAt.current = location.key;
    params.delete('open');
    const search = params.toString();
    // The entry keeps its state, so the origin it was followed from survives the flag leaving the address (#592).
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, defaultShouldRevalidate: false, state: location.state });
    shell.openDetails(match ? { kind: match[1]!.toLowerCase() as 'work' | 'decision' | 'result', id: match[2]!.toLowerCase() }
      : propose ? { kind: 'propose-decision', projectId: propose } : { kind: 'overview', focus: 'people' });
  }, [location.key, location.search, location.pathname, location.hash, location.state, navigate, shell, projectId]);
  // A return to a place that is gone lands on its nearest parent with one line saying so (#592); the line is said once.
  const notedAt = useRef<string | null>(null);
  useEffect(() => {
    const state = location.state as { note?: unknown } | null;
    if (typeof state?.note !== 'string' || notedAt.current === location.key) return;
    notedAt.current = location.key;
    toast({ message: state.note });
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, defaultShouldRevalidate: false, state: { ...state, note: undefined } });
  }, [location.key, location.state, location.pathname, location.search, location.hash, navigate, toast]);
  // ⌘K / Ctrl+K opens Jump to… from anywhere, also while typing, as the sidebar hint says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A surface with its own Ctrl+K (the doc editor's link picker) handles it first.
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setNavOpen(false);
      setJumpOpen((open) => !open);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // "[" collapses or expands the sidebar, "F" turns focus on and off, and "G" then "I" goes to the
  // Inbox (F-026 §4 keyboard).
  useEffect(() => {
    let leader = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
      if (document.getElementById('root')?.hasAttribute('data-modal')) return;
      // On a tablet the sidebar is always the rail (Spokój); "[" opens it as the drawer instead.
      if (event.key === '[') { event.preventDefault(); if (tablet) setNavOpen((open) => !open); else toggleSidebar(); return; }
      const key = event.key.toLowerCase();
      if (key === 'f' && !phone) { event.preventDefault(); void toggleFocus(); return; }
      if (key === 'g') { leader = Date.now(); return; }
      if (key === 'i' && Date.now() - leader < 1200) { event.preventDefault(); leader = 0; navigate('/inbox'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleSidebar, toggleFocus, navigate, phone, tablet]);


  // Typing on a touch phone (#266 PF-3): the view bar steps aside for the keyboard once a text field
  // takes focus, stays aside while focus moves to the same composer's buttons (Send, Attach,
  // Sources), and comes back shortly after focus leaves it, so no tap lands on a moved control.
  const appRef = useRef<HTMLDivElement>(null);
  const touch = useMediaQuery(MEDIA.touch);
  useEffect(() => {
    const app = appRef.current;
    const pane = paneRef.current;
    if (!phone || !touch || !app || !pane) return;
    let timer = 0;
    const field = (el: EventTarget | null) => el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)
      || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'range', 'button', 'submit', 'reset', 'color'].includes(el.type));
    const group = (el: EventTarget | null) => (el instanceof Element ? el.closest('.composer, .agents-composer, form') : null);
    const onIn = (event: FocusEvent) => {
      if (field(event.target)) { window.clearTimeout(timer); app.dataset.typing = 'true'; }
      else if (app.dataset.typing && group(event.target)) window.clearTimeout(timer);
    };
    const onOut = (event: FocusEvent) => {
      if (!app.dataset.typing) return;
      const next = event.relatedTarget;
      if (next instanceof Node && pane.contains(next) && (field(next) || (group(next) && group(next) === group(event.target)))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { delete app.dataset.typing; }, 200);
    };
    pane.addEventListener('focusin', onIn);
    pane.addEventListener('focusout', onOut);
    return () => { window.clearTimeout(timer); delete app.dataset.typing; pane.removeEventListener('focusin', onIn); pane.removeEventListener('focusout', onOut); };
  }, [phone, touch]);

  // iOS Safari does not shrink the layout for the on-screen keyboard (no interactive-widget support),
  // so on touch screens the app follows the visual viewport while the keyboard is up, keeping the
  // composer and Send above it (#266 PF-3, #268). Chromium already resizes; there this never applies.
  useEffect(() => {
    const viewport = window.visualViewport;
    const app = appRef.current;
    if (!viewport || !app || !touch) return;
    const update = () => {
      // Pinch-zoom also shrinks the visual viewport: only an unzoomed one that lost height has a keyboard (#341).
      if (viewport.scale <= 1.01 && window.innerHeight - viewport.height > 120) {
        app.style.setProperty('--app-h', `${Math.round(viewport.height)}px`);
        app.style.setProperty('--app-top', `${Math.round(viewport.offsetTop)}px`);
      } else {
        app.style.removeProperty('--app-h');
        app.style.removeProperty('--app-top');
      }
    };
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    update();
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); app.style.removeProperty('--app-h'); app.style.removeProperty('--app-top'); };
  }, [touch]);

  // Switching a project view, a place or a Settings section dissolves the old content into the new in the content area only (#593
  // AC-3, `Dissolve` around the routes below): the old content stays a moment as an inert picture of itself over the new, fades out
  // and travels a few pixels the way the person came from; the new content, with its composer and toolbar, is live and in place from
  // the first frame, and the header, the sidebar and the tab bar are not in it at all (Spokój rule 7). Opening a thread beside the
  // conversation or a page inside the Wiki is not a switch. The reading position is restored by its own owner and never animated.
  // The history sets the direction of travel the detail panel's content follows when it is not told by its depth.
  const navigationType = useNavigationType();
  const [pathway, setPathway] = useState({ from: location.pathname, to: location.pathname });
  if (pathway.to !== location.pathname) setPathway({ from: pathway.to, to: location.pathname });
  const viewWay = viewDirection(pathway.from, pathway.to, navigationType === 'POP');
  useLayoutEffect(() => {
    setTravelDirection(navigationType === 'POP' ? 'back' : 'forward');
    // The view is the pathname's; the navigation type only says how it was reached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // In focus the rail shows no counts.
  const sidebarProps = { workspace, projects, directMessages, user: me.user, session: me.session, inboxUnread: focusing ? 0 : inboxUnread };
  const where = placeOf(location.pathname);
  // Home's computer layout has no header row; keep its name available to assistive technology.
  const homeRoot = where === 'home' && location.pathname === '/';
  const activeProject = projects.find((project) => project.id === projectId);
  // F-029 (#614): a project of a workspace whose AI is off has no Agents view and offers none to add (Spokój rule 7: nothing else moves).
  const aiOff = useWorkspaceAi(activeProject?.workspaceId).blocked;
  // The Conversation tab returns to the conversation that was open before Tasks, Map, Docs or project
  // settings (GitHub), and the
  // Map tab to the sketch (or list) that was open there.
  const onOtherView = /^\/projects\/[^/]+\/(tasks|map|docs|agents|github)(\/|$)/.test(location.pathname);
  const onMap = /^\/projects\/[^/]+\/map(\/|$)/.test(location.pathname);
  const onAgents = /^\/projects\/[^/]+\/agents(\/|$)/.test(location.pathname);
  const onWiki = /^\/projects\/[^/]+\/docs(\/|$)/.test(location.pathname);
  useEffect(() => {
    if (!projectId || (onOtherView && !onMap)) return;
    remember(onMap ? 'map' : 'conversation', me.user.id, projectId, `${location.pathname}${location.search}`);
  }, [me.user.id, projectId, onOtherView, onMap, location.pathname, location.search]);
  const shellProject = useProjectShell();
  const project = shellProject && shellProject.project.id === projectId ? shellProject : undefined;
  const workSummary = useProjectWorkSummary();
  const openWork = project ? workSummary.summary?.unfinishedTotal : undefined;
  // Conversation · Map · Tasks · Wiki · Agents in the final design's order (#117); quiet tabs without
  // counts. The unfinished work count stays readable to assistive technology on the Tasks tab.
  const viewNow = /^\/projects\/[^/]+\/(map|docs|agents)(\/|$)/.exec(location.pathname)?.[1] as ProjectViewId | undefined;
  const shownProjectViews = project ? shownViews(project, viewNow) : null;
  const projectViews = projectId ? [
    { id: 'conversation', label: 'Conversation', to: onOtherView ? lastConversationPath(me.user.id, projectId) : `${location.pathname}${location.search}` },
    { id: 'map', label: 'Map', to: onMap ? location.pathname : lastMapPath(me.user.id, projectId, project?.sketches), end: false },
    { id: 'tasks', label: 'Tasks', to: `/projects/${projectId}/tasks${lastTasksSearch(me.user.id, projectId)}`, ...(openWork ? { countLabel: `, ${openWork} open` } : {}) },
    { id: 'docs', label: 'Wiki', to: `/projects/${projectId}/docs`, end: false },
    { id: 'agents', label: 'Agents', to: `/projects/${projectId}/agents` },
  ].filter((view) => !(aiOff && view.id === 'agents')).filter((view) => !(PROJECT_VIEWS as readonly string[]).includes(view.id) || !shownProjectViews || shownProjectViews.has(view.id as ProjectViewId)) : null;
  const places = phonePlaces(location.pathname, inboxUnread);
  const audienceOpen = project?.project.visibility === 'workspace';
  const audience = project ? audienceLine(project.people, me.user.id, audienceOpen) : 'People with project access';
  // The audience line leads to "Who can see this", where managers change it (#188).
  const openAudience = () => shell.openDetails({ kind: 'overview', focus: 'people' });
  const recapOpen = detailsOpen && typeof detailsView === 'object' && detailsView.kind === 'recap';
  // A task, decision or result opens in the one detail panel with its kind as a chip (F-026 S4).
  const ownedShown = isOwned(detailsView) && owned ? owned : null;
  const objectChip = ownedShown ? ownedShown.chip : typeof detailsView === 'object' ? KIND_LABEL[detailsView.kind] : undefined;
  // "‹ back": the owner's own way back (an agent's thread to its agent), else the step this content replaced.
  const trailTop = trail.at(-1);
  const goToOrigin = useGoToOrigin(routeOrigin ?? NO_ORIGIN);
  const stepBack = () => {
    if (!trailTop) return;
    // A panel kept over the page that a link inside it led to (a task's source message) steps back to the page it was followed
    // from, where that panel returns as it was, not to the conversation that link opened: a sheet or an overlay covers the
    // header's control, and this is the one visible back (#592).
    if (ownedShown && routeOrigin && (location.state as { keepPanel?: boolean } | null)?.keepPanel === true) { goToOrigin(); return; }
    setTrail((list) => list.slice(0, -1));
    // A thread a view owns leaves its address first; the panel stays for what it gives way to.
    if (ownedShown) ownedShown.onClose({ keepPanel: true });
    const view = trailTop.view;
    if (typeof view === 'object' && view.kind === 'owned' && !ownedRef.current) return;
    shell.openDetails(view, { back: 'keep' });
  };
  const back = ownedShown?.back ? { label: ownedShown.back.label, onClick: ownedShown.back.run } : trailTop ? { label: trailTop.label, onClick: stepBack }
    : ownedShown?.origin ? { label: ownedShown.origin.label, onClick: ownedShown.origin.run } : undefined;
  // Esc and × close the whole panel; a thread or an agent a view owns also leaves its address.
  const closePanel = () => {
    if (panelGuard.current?.()) return;
    ownedShown?.onClose();
    toggleDetails(false);
  };
  useLayoutEffect(() => { closeRef.current = closePanel; });
  // "N needs you" counts this project's items of the Inbox's one queue (#763 A2), as the sidebar counts them all; it
  // opens the Inbox on them. "What matters" stays its own quiet entry in More.
  const needsYou = activeProject && projectId ? inboxCounts.byProject.get(projectId) ?? 0 : 0;
  const openNeedsYou = () => { if (projectId) navigate(`/inbox?project=${encodeURIComponent(projectId)}`); };
  const dmId = location.pathname.match(/^\/dm\/([^/]+)/)?.[1];
  const activeDm = directMessages.find((dm) => dm.id === dmId);
  // Messages · Sketches: a DM's sketches stay inside it, for exactly its people (#96).
  const dmSketches = useDmSketchCount(activeDm?.workspaceId, activeDm?.id, me.user.id);
  const dmViews = activeDm ? [
    { id: 'messages', label: 'Messages', to: `/dm/${activeDm.id}` },
    { id: 'sketches', label: 'Sketches', to: `/dm/${activeDm.id}/sketches`, end: false, ...(dmSketches ? { count: dmSketches, countLabel: `, ${dmSketches} ${dmSketches === 1 ? 'sketch' : 'sketches'}` } : {}) },
  ] : null;
  const matches = useMatches();
  const notFound = matches.some((match) => (match.handle as { notFound?: boolean } | undefined)?.notFound === true);
  // A space that waits to be unlocked: the address of its row, or any place of it that turned into the locked panel (F-030, #655).
  const lockedId = location.pathname.match(/^\/spaces\/([^/]+)/)?.[1] ?? lockedPlaceId;
  const lockedSpace = lockedId ? [...workspaces, ...lockedWorkspaces].find((space) => space.id === lockedId) : undefined;
  const lockedHere = !!lockedId && lockedSpace?.encryption?.state === 'locked';
  const place = lockedHere
    ? { crumb: null, title: lockedSpace.name, topic: 'Waiting to be unlocked', noDetails: true }
    : location.pathname === '/projects'
    ? { crumb: null, title: 'Projects', topic: 'Every project you can open', noDetails: true }
    : /^\/settings(\/(appearance|account|people|notifications|agents|shortcuts)(\/.*)?)?$/.test(location.pathname)
    ? { crumb: null, title: 'Settings', topic: 'Appearance, notifications, agents and AI', noDetails: true }
    : backgroundSettings
    ? { crumb: null, title: 'Background suggestions', topic: 'Your usage and project rules', noDetails: true }
    : aiConnections
    ? { crumb: null, title: 'AI connections', topic: 'Your own keys, payers and allowances', noDetails: true }
    : location.pathname === '/search'
    ? { crumb: null, title: 'Search', topic: 'Only what you can open is searched', noDetails: true }
    : location.pathname === '/settings/assistant/how'
    ? { crumb: null, title: 'How your assistant works', topic: 'Only you can use it · optional', noDetails: true }
    : location.pathname === '/settings/assistant'
    ? { crumb: null, title: 'Your assistant', topic: 'Only you can use it · optional', noDetails: true }
    : activeProject
    ? { crumb: activeProject.workspaceName ?? null, title: activeProject.name, topic: audience }
    : location.pathname === '/map'
    // The Sketchbook is named as such (#508); its privacy line is the first line of the page, at every width.
    ? { crumb: null, title: 'Sketchbook', topic: '' }
    : where === 'inbox'
      ? location.pathname.startsWith('/settings/')
        ? { crumb: null, title: 'Notification settings', topic: 'What reaches you, where and when', noDetails: true }
        // The count beside the title says what the Inbox holds ("Inbox · 6 need you", #763 IN-5); no second line repeats it.
        : { crumb: null, title: 'Inbox', topic: '', noDetails: true }
    : where === 'dm'
      ? activeDm
        // A DM's header names its exact audience (design principle 5).
        ? { crumb: null, title: activeDm.title, topic: activeDm.audience }
        : dmId === 'new'
          ? { crumb: null, title: 'New message', topic: 'Only the people you choose can read it', noDetails: true }
          : { crumb: null, title: 'Direct messages', topic: 'Conversations with people, outside any project', noDetails: true }
      // Pages reached from Home name themselves (#763 NV-1); only `/` is Home. Your tasks span every workspace, so no
      // single workspace is named above them (#190).
      : location.pathname === '/tasks'
        ? { crumb: null, title: 'Your tasks', topic: 'Assigned to you, in every project' }
      : location.pathname === '/docs'
        ? { crumb: null, title: 'Wiki', topic: 'Pages of every space you are in', noDetails: true }
      : location.pathname === '/projects/new'
        ? { crumb: null, title: 'New project', topic: '', noDetails: true }
      : notFound
        ? { crumb: null, title: 'Page not found', topic: '', noDetails: true }
      : { crumb: workspace?.name ?? null, title: 'Home', topic: 'What needs you and where you left off' };
  // The phone Wiki is drawn with its title as the view menu and no chip row of views (F-026 §4, #354).
  // A place without its own Details (Search, Inbox, the DM list) never keeps the generic panel open.
  if ('noDetails' in place && detailsOpen && detailsView === 'place') setDetailsOpen(false);

  // The computer's header is one row (F-026 §4): the name, the place's views as a segmented control,
  // then what needs you, the people and agents, and More. Focus keeps only the name, the view and
  // the way out.
  // ⌘K's "Recent" lists the places the person opened on this device (F-026 E02): a project's view, a direct message, the
  // Inbox, Home. A project or conversation this account cannot open (the not-found page) is not remembered.
  const openable = projectId ? !!activeProject : dmId && dmId !== 'new' ? !!activeDm : true;
  // A Wiki page is remembered with its own title, read from the doc the reader loaded (its current title, for any version).
  const shownDoc = (matches[matches.length - 1]?.loaderData as { doc?: { title?: unknown } } | undefined)?.doc;
  const docTitle = typeof shownDoc?.title === 'string' && shownDoc.title.trim() ? shownDoc.title : undefined;
  useEffect(() => {
    const opened = placeOfPath(location.pathname);
    if (!opened || !openable) return;
    rememberPlace(me.user.id, opened.key.endsWith(':docs') && docTitle && /\/docs\/[^/]+$/.test(opened.path) ? { ...opened, title: docTitle } : opened);
  }, [location.pathname, openable, me.user.id, docTitle]);
  const rowViews = phone ? null
    : activeProject && projectViews ? { items: projectViews, label: 'Project views' }
      : dmViews ? { items: dmViews, label: 'Direct message views' }
        : null;
  const viewName = activeProject ? PROJECT_VIEW_NAMES[Math.max(0, viewOrder(location.pathname))] : null;
  const addViewItems: { label: string; run: () => void }[] = project && shownProjectViews && projectId && project.project.access !== 'viewer'
    ? addableViews(shownProjectViews).filter((view) => !(aiOff && view === 'agents')).map((view) => ({ label: `Add ${VIEW_LABEL[view]}`, run: () => void addView(projectId, view) })) : [];
  const moreItems: MoreItem[] = [
    // A header with no room for them (Spokój rule 3) moves the people and Together here; the views stay in the row.
    ...(project?.people ? [{ label: 'Who can see this', run: openAudience, narrow: true }] : []),
    ...(activeProject ? [{ label: 'Together', node: <LiveEntry variant="more" /> }] : []),
    ...('noDetails' in place ? [] : [{ label: activeProject ? 'Project details' : activeDm ? 'Message info' : 'Details', run: () => shell.openDetails('place') }]),
    ...(activeProject && projectId ? [{ label: 'What matters', run: () => shell.openDetails({ kind: 'recap', projectId }) }] : []),
    ...addViewItems,
    { label: focus.uncertain ? 'Check notification pause' : 'Focus', keys: 'F', checked: focusing, run: () => void focus.toggle() },
    tablet ? { label: 'Show the sidebar', keys: '[', run: () => setNavOpen(true) } : { label: railed || focusing ? 'Show the sidebar' : 'Hide the sidebar', keys: '[', run: toggleSidebar },
  ];

  // The phone's header (F-026 §4 Phone): inside a project or a conversation the round Back and the
  // title as the view menu with the view and who is here beneath it. The dock owns Search whenever
  // it is present; a conversation keeps header Search because it hides the dock.
  const goBack = (fallback: string) => { if (location.key !== 'default') void navigate(-1); else void navigate(fallback); };
  // CW-11: Back follows the way the person came (#341 AC-4), one place at a time: entries that only opened or changed a
  // sheet on the same page (`?open=…`, a #message) are stepped over together, so Back never walks through old sheets.
  const steps = useRef<{ key: string; path: string }[]>([]);
  useEffect(() => {
    const entry = { key: location.key, path: location.pathname };
    const at = steps.current.findIndex((item) => item.key === location.key);
    if (at >= 0) steps.current = steps.current.slice(0, at + 1);
    else if (navigationType === 'REPLACE' && steps.current.length) steps.current = [...steps.current.slice(0, -1), entry];
    // A step back or forward to an entry this tab never recorded: start again from here.
    else if (navigationType === 'POP') steps.current = [entry];
    else steps.current = [...steps.current, entry].slice(-50);
  }, [location.key, location.pathname, navigationType]);
  const goBackAPlace = (fallback: string) => {
    const entries = steps.current;
    const here = entries.length - 1;
    let to = here - 1;
    while (to >= 0 && entries[to]!.path === location.pathname) to--;
    // Land on that page as it first opened, not on a sheet it showed later.
    while (to > 0 && entries[to - 1]!.path === entries[to]!.path) to--;
    if (to >= 0 && location.key !== 'default') void navigate(to - here);
    else goBack(fallback);
  };
  // An opened reference leads back to where it was followed from, in the place of the generic back (#592).
  const phoneBack = (fallback: string) => routeOrigin ? <RouteOriginBack origin={routeOrigin} className="origin-back--phone" /> : <PhoneBack onBack={() => goBack(fallback)} />;
  const searchButton = <IconButton icon="search" label="Search" size={20} className="phead__round" onClick={shell.openSearch} />;
  const detailsEntry = () => shell.openDetails('place');
  const peopleLine = (people: ProjectPerson[] | null, includeAgents = true) => {
    if (!people) return '';
    const humans = people.filter((person) => person.kind === 'human').length;
    const agents = includeAgents ? people.length - humans : 0;
    return `${humans} ${humans === 1 ? 'person' : 'people'}${agents ? ` · ${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}`;
  };
  const currentProjectView = ['conversation', 'map', 'tasks', 'docs', 'agents'][Math.max(0, viewOrder(location.pathname))];
  const projectMenu: PhoneMenuItem[] = projectViews ? ([
    ['conversation', 'chat', undefined], ['tasks', 'tasks', openWork ? `${openWork} open` : undefined], ['map', 'edit', undefined], ['docs', 'doc', undefined],
    ['agents', 'spark', onAgents ? <span ref={setViewMenuMetadataSlot} /> : undefined],
  ] as const).flatMap(([id, icon, note]) => {
    // A view the project has not added yet (#351) is not in the menu; "Add …" rows offer it.
    const view = projectViews.find((item) => item.id === id);
    return view ? [{ id, label: view.label, to: view.to, icon, note, current: currentProjectView === id }] : [];
  }) : [];
  const tabletMenu = tablet && !phone && !focusing && !!activeProject && projectMenu.length > 0;
  const mainPlace = ['/projects', '/inbox', '/search', '/dm', '/settings'].includes(location.pathname) || /^\/inbox\//.test(location.pathname);
  const homePage = /^\/(tasks|map|docs)(\/|$)/.test(location.pathname);
  const backOnly = settingsPage || location.pathname === '/projects/new' || dmId === 'new' || homePage;
  const phoneHeader = (
    <header className={`phead${mainPlace ? ' phead--large' : ''}`}>
      {backOnly ? (
        <>{phoneBack(settingsPage ? settingsParent : homePage ? '/' : '/projects')}
          <div className="phead__id"><div className="phead__title"><h1>{location.pathname === '/projects/new' ? 'New project' : place.title}</h1></div></div></>
      ) : activeProject && projectViews ? (
        <>{routeOrigin ? phoneBack('/projects') : <PhoneBack onBack={() => goBackAPlace('/projects')} />}
          <PhoneTitleMenu title={place.title} items={projectMenu} onDetails={detailsEntry}
            goal={project?.project.goal && !project.project.goal.reachedAt ? project.project.goal.title : undefined}
            metadataSlot={onWiki || onAgents ? setMetadataSlot : undefined}
            adds={addViewItems.map((item) => ({ label: item.label, run: item.run }))}
            subtitle={onWiki ? peopleLine(project?.people ?? null) : <>{onAgents && aiOff ? 'AI is off' : PROJECT_VIEW_NAMES[Math.max(0, viewOrder(location.pathname))]}{project?.people ? <span className="phead__people"> · {peopleLine(project.people, !onAgents)}</span> : null}</>} /></>
      ) : activeDm && dmViews ? (
        <>{phoneBack('/projects')}
          <PhoneTitleMenu title={activeDm.title} items={dmViews.map((view) => ({ id: view.id, label: view.label, to: view.to, icon: view.id === 'messages' ? 'chat' as const : 'edit' as const, current: view.id === (/\/sketches/.test(location.pathname) ? 'sketches' : 'messages') }))}
            onDetails={detailsEntry} detailsLabel="Message info"
            subtitle={`${/\/sketches/.test(location.pathname) ? 'Sketches' : 'Messages'} · ${activeDm.audience}`} /></>
      ) : location.pathname === '/' ? (
        <div className="phead__id">
          <PhoneHomeLead />
          <div className="phead__title"><h1><span className="ui-vh">Home</span><span className="phead__word" aria-hidden="true">flux</span></h1></div>
        </div>
      ) : (
        // A place of a locked space opened at its own address (a deep link) keeps a way back on the phone (LK-2): an
        // installed app has no browser Back. The sidebar row's own page (/spaces/:id) is a main place with the tab bar.
        <>{routeOrigin ? <RouteOriginBack origin={routeOrigin} className="origin-back--phone" />
            : lockedHere && !location.pathname.startsWith('/spaces/') ? <PhoneBack onBack={() => goBack('/')} /> : null}
          <div className="phead__id"><div className="phead__title"><h1>{place.title}</h1>{'topic' in place && place.topic ? <p className="phead__sub">{place.topic}</p> : null}</div></div></>
      )}
      <div className="phead__right">
        <span className="top__actions" ref={setActionSlot} />
        {activeProject && /^\/projects\/[^/]+(\/conversations\/|\/?$)/.test(location.pathname) ? <ProjectAgentStop projectId={activeProject.id} /> : null}
        {/* The same two controls in every project view and direct message (Spokój #507); Together is dimmed where it is unavailable. */}
        {activeProject || activeDm ? <><LiveEntry />{searchButton}</> : null}
        {!backOnly && !activeProject && !activeDm && location.pathname !== '/settings' ? <PhoneAvatar name={me.user.name} /> : null}
      </div>
    </header>
  );

  return (
    <ShellContext.Provider value={shell}>
    {/* One live session per tab, above the routes, so navigation keeps it (#62). */}
    <LiveProvider meId={me.user.id}>
    <div className={`app${phone && !detailsOpen && !lockedHere && phoneOffersCreate(location.pathname) ? ' app--fab' : ''}`} ref={appRef}>
      <a className="ui-skip" href="#content">Skip to content</a>
      {phone ? null : navDrawer ? (
        <Drawer open={navOpen && navDrawer} onClose={() => setNavOpen(false)} labelledBy={drawerTitleId} id="nav-drawer" className="nav-drawer">
          <Sidebar {...sidebarProps} onClose={() => setNavOpen(false)} titleId={drawerTitleId} />
        </Drawer>
      ) : (
        // Tablet (Spokój): the sidebar is the 64 px rail (its width is set in CSS); its expand control opens the sidebar as a drawer.
        <aside className={`app__side${railed || focusing ? ' app__side--rail' : ''}`} aria-label="Sidebar" ref={sideRef}>
          {/* Folding to the rail and unfolding take a short size change; the control used keeps focus (#720). */}
          <SizeSwap id={railed || focusing ? 'rail' : 'full'} host={sideRef} dress="app__side" keep=".side__toggle" widths={SIDE_WIDTHS} still={tablet}>
            <Sidebar {...sidebarProps} collapsed={railed || focusing || tablet} onToggleCollapsed={focusing ? () => void focus.toggle() : tablet ? () => setNavOpen(true) : toggleSidebar} />
          </SizeSwap>
        </aside>
      )}
      {!phone && !navDrawer && tablet ? (
        <Drawer open={navOpen} onClose={() => setNavOpen(false)} labelledBy={drawerTitleId} id="nav-drawer" className="nav-drawer">
          <Sidebar {...sidebarProps} onClose={() => setNavOpen(false)} titleId={drawerTitleId} />
        </Drawer>
      ) : null}

      <div className="app__main">
        {phone ? phoneHeader : (
        <header className={`top${activeProject ? ' top--project' : ''} top--row${focusing ? ' top--focus' : ''}${homeRoot ? ' top--bare' : ''}`}>
          {navDrawer ? (
            <IconButton icon="menu" label="Open navigation" size={18} aria-expanded={navOpen} aria-controls={navOpen ? 'nav-drawer' : undefined}
              aria-haspopup="dialog" data-tip-align="start" onClick={() => { setDetailsOpen(false); setNavOpen(true); }} className="top__menu" />
          ) : null}
          {routeOrigin ? <RouteOriginBack origin={routeOrigin} className="origin-back--header" /> : null}
          {tabletMenu ? (
            // A tablet's project title is the view menu, as on the phone (Spokój layout per screen).
            <PhoneTitleMenu title={place.title} items={projectMenu} onDetails={null} subtitle={viewName} />
          ) : (
            <div className="top__title">
              {place.crumb && !activeProject ? <><span className="top__crumb">{place.crumb}</span><span className="top__slash" aria-hidden="true">/</span></> : null}
              <h1 title={place.title}>{place.title}</h1>
              {focusing && viewName ? <span className="top__topic">{viewName}</span>
                : !rowViews || where === 'dm' ? <span className="top__topic">{activeProject ? null : place.topic}</span> : null}
            </div>
          )}
          {rowViews && !focusing && !tabletMenu ? <Tabs variant="segmented" className="top__views" label={rowViews.label} items={rowViews.items} /> : null}
          <div className="top__right" data-shift>
            {/* A view can put one quiet action here (a DM's Select, #96). */}
            <span className="top__actions" ref={setActionSlot} />
            {focusing && focus.until ? <FocusPill until={focus.until} uncertain={focus.uncertain} onEnd={() => void focus.toggle()} /> : (
              <>
                {activeProject && needsYou ? <NeedsYouChip count={needsYou} project={activeProject?.name ?? null} onOpen={openNeedsYou} /> : null}
                {project?.people ? <HeaderFaces people={project.people} audience={audience} onOpen={openAudience} /> : null}
                {activeProject ? <LiveEntry /> : null}
                <MoreMenu items={moreItems} />
              </>
            )}
          </div>
        </header>
        )}
        <LiveBar />
        {/* The conversation and its one panel share a row under the one header (Spokój, F-026 layout per screen). */}
        <div className="app__body">
          <RouteProgress />
          {/* The one main landmark, the skip link's target (#763 AX-1): a view's own header is then not a second banner. */}
          <main className="app__pane" id="content" ref={paneRef} tabIndex={-1}>
            <Dissolve id={routeView(location.pathname)} direction={viewWay} host={paneRef} dress=".app" shift="--shift-view" time="--dur-view" layer={19} skip=".deferred-surface--stage">
              <Outlet />
              <DeferredLiveStage />
            </Dissolve>
          </main>
          <SidePanel open={detailsOpen} onClose={closePanel} title={recapOpen ? 'What matters' : ownedShown ? ownedShown.label : 'Details'} closeLabel={ownedShown?.closeLabel} chip={objectChip} id="details" back={back} startFull={sheetStart ?? ownedShown?.startFull} onHeight={(full) => keepPlace('sheet', full)}
            contentKey={ownedShown ? `owned:${ownedShown.key}` : typeof detailsView === 'object' ? JSON.stringify(detailsView) : detailsView} depth={trail.length + (ownedShown?.back ? 1 : 0)}
            context={phone && (detailsView === 'place' || typeof detailsView === 'object' && detailsView.kind === 'overview') ? <OverviewContext message={typeof detailsView === 'object' && detailsView.kind === 'overview' && !!detailsView.messageId} /> : undefined}>
            {isOwned(detailsView) ? <div className="ui-panel__slot" ref={setPanelSlot} /> : <DeferredDetails view={detailsView} workspace={workspace} placeTitle={place.title} dm={activeDm ? { id: activeDm.id, kind: activeDm.kind, title: activeDm.title, me: me.user.name, people: activeDm.people, audience: activeDm.audience } : null} onBack={() => setDetailsView('place')} onClose={() => toggleDetails(false)} />}
          </SidePanel>
        </div>
        {/* A locked space's place keeps the tab bar on the phone (LK-2), and offers no "+" there. */}
        {phone && !detailsOpen && (lockedHere || !phoneHidesDock(location.pathname) || phoneOffersCreate(location.pathname)) ? (
          <PhoneDock places={places} onSearch={shell.openSearch} onCreate={() => setCreateOpen(true)} create={!lockedHere && phoneOffersCreate(location.pathname)} capsule={lockedHere || !phoneHidesDock(location.pathname)} />
        ) : null}
      </div>

      {phone ? <PhoneCreate open={createOpen} onClose={() => setCreateOpen(false)} projects={projects} projectId={projectId} go={(to) => void navigate(to)} onThought={() => startCapture(navigate)} /> : null}
      <CreateHost request={create} onClose={() => setCreate(null)} />
      <DeferredJumpTo open={jumpOpen} onClose={() => setJumpOpen(false)} userId={me.user.id} />
    </div>
    </LiveProvider>
    </ShellContext.Provider>
  );
}
