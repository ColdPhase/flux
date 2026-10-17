import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ProjectPerson } from '@flux/contracts';
import { Outlet, useLocation, useMatches, useNavigate, useParams, useRevalidator } from 'react-router';
import { useStreamEvents } from '../api/stream';
import { Drawer, IconButton, MEDIA, SidePanel, Tabs, duration, flip, play, useMediaQuery, useToast, useSidePanelMode } from '../ui';
import { useShellData } from './data';
import { registerServiceWorker, syncPushSubscription } from '../pwa';
import { DeferredDetails, DeferredJumpTo, DeferredLiveStage } from './DeferredSurfaces';
import { RouteProgress } from './RouteProgress';
import { useInboxDot } from '../notifications/dot';
import { placeOf } from './place';
import { placeOfPath, rememberPlace } from '../search/recent';
import { ShellContext, type CreateRequest, type DetailsView } from './shellContext';
import { Sidebar } from './Sidebar';
import { startCapture, viewIndex } from './views';
import { PROJECT_VIEWS, type ProjectViewId } from '@flux/contracts';
import { addProjectView } from './conversation-api';
import { addableViews, audienceLine, shownViews, useProjectShell } from '../project/data';
import { useDmSketchCount } from '../dm/useDmSketchCount';
import { LiveProvider } from '../live/LiveProvider';
import { LiveEntry } from '../live/LiveEntry';
import { LiveBar } from '../live/LiveBar';
import '../live/live.css';
import { CreateHost } from '../create/CreateWindow';
import './project-header.css';
import { useNeedsYou } from '../returns/useNeedsYou';
import { WorkReadProvider, useProjectWorkSummary } from '../work/WorkReadContext';
import { OverviewContext } from '../project/OverviewContext';
import { remember, remembered } from './remembered';
import { ProjectAgentStop } from './WorkingAgent';
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

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
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
  const { me, workspace, projects, directMessages } = useShellData();
  const location = useLocation();
  const backgroundSettings = location.pathname === '/settings/background-compute';
  const aiConnections = location.pathname === '/settings/ai-connections';
  // A page inside Settings (#266 PF-5): on the phone its header leads back instead of opening the drawer.
  const settingsPage = /^\/settings\/./.test(location.pathname);
  // Back from a direct link goes to the page that leads there: the AI pages to Agents and AI (#513).
  const settingsParent = /^\/settings\/(assistant|background-compute|ai-connections)(\/|$)/.test(location.pathname) ? '/settings/agents' : '/settings';
  const navDrawer = useMediaQuery(MEDIA.navDrawer);
  const tablet = useMediaQuery(MEDIA.tablet);
  const phone = useMediaQuery(MEDIA.phone);
  const panelMode = useSidePanelMode();
  const [navOpen, setNavOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsView, setDetailsView] = useState<DetailsView>('place');
  const [detailsAccount, setDetailsAccount] = useState(me.user.id);
  if (detailsAccount !== me.user.id) { setDetailsAccount(me.user.id); setDetailsView('place'); setDetailsOpen(false); }
  const [jumpOpen, setJumpOpen] = useState(false);
  // The phone's "+" sheet (#341) and the one Create window (#345) are separate: the sheet's Task opens the window.
  const [createOpen, setCreateOpen] = useState(false);
  const [create, setCreate] = useState<CreateRequest | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(viewOrder(location.pathname));
  const drawerTitleId = useId();

  const toggleDetails = useCallback((next?: boolean) => {
    const open = next ?? !detailsOpen;
    if (open === detailsOpen) return;
    if (open) setNavOpen(false);
    if (panelMode !== 'docked') { setDetailsOpen(open); return; }
    // Docked: the work area shifts over smoothly instead of jumping (FLIP).
    const finish = flip([...document.querySelectorAll('[data-shift]')]);
    flushSync(() => setDetailsOpen(open));
    finish();
  }, [detailsOpen, panelMode]);

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
  useStreamEvents(me.user.id, (event) => {
    // A project goal changed (#520): the open project's Details, view menu and conversation read it again.
    if (event.objectType === 'project' && event.kind.startsWith('project.goal_') && location.pathname.startsWith(`/projects/${event.objectId}`)) { revalidator.revalidate(); return; }
    // Someone saw a message (#534): only the open conversation shows it, and it asks for itself.
    if (event.objectType !== 'dm' || event.kind === 'dm.observed.v1') return;
    const known = directMessages.some((dm) => dm.id === event.objectId);
    if (!known || event.kind !== 'dm.message_sent.v1' || location.pathname === '/dm') revalidator.revalidate();
  }, () => revalidator.revalidate());

  const inboxUnread = useInboxDot(me.user.id, location.pathname);
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
  const shell = useMemo(() => ({
    openDetails(view: DetailsView = 'place') {
      if (detailsScope.current !== detailsOwner) return;
      setDetailsView(typeof view === 'object' && 'id' in view ? { ...view, projectId: view.projectId ?? projectId } : view);
      toggleDetails(true);
    },
    /** On the phone a request that does not yet say what to create opens the "+" sheet first (#341). */
    openCreate(request: CreateRequest = {}) { setNavOpen(false); setJumpOpen(false); if (phone && !request.kind) setCreateOpen(true); else setCreate(request); },
    openSearch() { setNavOpen(false); setJumpOpen(true); },
    openNavigation() { setDetailsOpen(false); setNavOpen(true); },
    actionSlot,
    metadataSlot, viewMenuMetadataSlot,
    toggleFocus() { void toggleFocus(); },
    toggleSidebar,
    sidebarHidden: railed || focusing,
  }), [toggleDetails, actionSlot, metadataSlot, viewMenuMetadataSlot, projectId, detailsOwner, toggleSidebar, railed, toggleFocus, focusing]);

  // A link inside an overlaid panel or sheet (#117 overview) leads to its destination.
  const [shownPath, setShownPath] = useState(location.pathname);
  if (shownPath !== location.pathname) {
    setShownPath(location.pathname);
    if ((panelMode !== 'docked' || backgroundSettings || aiConnections) && detailsOpen) setDetailsOpen(false);
  }
  // `?open=work:<id>` (a notification's link, #116, a search result, #114, or a doc reference, #112)
  // opens that object in Details on its project; `?open=people` (a new project, #188) opens its
  // "Who can see this". Each address is handled once, and the flag leaves it without reloading the
  // page's data: that navigation finishes at once, so no load of this page is left running that
  // could land after the person has moved on or signed out.
  const navigate = useNavigate();
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
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, defaultShouldRevalidate: false });
    shell.openDetails(match ? { kind: match[1]!.toLowerCase() as 'work' | 'decision' | 'result', id: match[2]!.toLowerCase() }
      : propose ? { kind: 'propose-decision', projectId: propose } : { kind: 'overview', focus: 'people' });
  }, [location.key, location.search, location.pathname, location.hash, navigate, shell, projectId]);
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
      if (document.getElementById('root')?.inert) return;
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

  // A new view slides in from the side its tab sits on; a Settings page slides in from the right
  // and back from the left, like a pushed page (#266 PF-4).
  const previousPath = useRef(location.pathname);
  useLayoutEffect(() => {
    const index = viewOrder(location.pathname);
    const settingsDepth = (path: string) => (path === '/settings' ? 1 : /^\/settings\/./.test(path) ? 2 : 0);
    const from = settingsDepth(previousPath.current);
    const to = settingsDepth(location.pathname);
    previousPath.current = location.pathname;
    const direction = from && to && from !== to ? Math.sign(to - from) : Math.sign(index - previousView.current);
    const distance = from && to && from !== to ? 28 : 12;
    previousView.current = index;
    if (!direction) return;
    void play(paneRef.current, [{ opacity: 0, transform: `translateX(${direction * distance}px)` }, { opacity: 1, transform: 'none' }], duration('--dur-2'), '--ease-out', { fill: 'backwards' });
  }, [location.pathname]);

  // In focus the rail shows no counts.
  const sidebarProps = { workspace, projects, directMessages, user: me.user, session: me.session, inboxUnread: focusing ? 0 : inboxUnread };
  const where = placeOf(location.pathname);
  // Home's computer layout has no header row; keep its name available to assistive technology.
  const homeRoot = where === 'home' && location.pathname === '/';
  const activeProject = projects.find((project) => project.id === projectId);
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
  ].filter((view) => !(PROJECT_VIEWS as readonly string[]).includes(view.id) || !shownProjectViews || shownProjectViews.has(view.id as ProjectViewId)) : null;
  const places = phonePlaces(location.pathname, inboxUnread);
  const audienceOpen = project?.project.visibility === 'workspace';
  const audience = project ? audienceLine(project.people, me.user.id, audienceOpen) : 'People with project access';
  // The audience line leads to "Who can see this", where managers change it (#188).
  const openAudience = () => { setDetailsView({ kind: 'overview', focus: 'people' }); toggleDetails(true); };
  const recapOpen = detailsOpen && typeof detailsView === 'object' && detailsView.kind === 'recap';
  // A task, decision or result opens in the one detail panel with its kind as a chip (F-026 S4).
  const objectChip = typeof detailsView === 'object' ? ({ work: 'Task', decision: 'Decision', result: 'Result' } as Record<string, string | undefined>)[detailsView.kind] : undefined;
  // "What matters" (#133): a quiet count of what needs you; refreshed when the panel closes.
  const needsYou = useNeedsYou(activeProject ? projectId ?? null : null, recapOpen);
  const toggleRecap = () => {
    if (!projectId) return;
    if (recapOpen) toggleDetails(false); else { setDetailsView({ kind: 'recap', projectId }); toggleDetails(true); }
  };
  const dmId = location.pathname.match(/^\/dm\/([^/]+)/)?.[1];
  const activeDm = directMessages.find((dm) => dm.id === dmId);
  // Messages · Sketches: a DM's sketches stay inside it, for exactly its people (#96).
  const dmSketches = useDmSketchCount(activeDm?.workspaceId, activeDm?.id, me.user.id);
  const dmViews = activeDm ? [
    { id: 'messages', label: 'Messages', to: `/dm/${activeDm.id}` },
    { id: 'sketches', label: 'Sketches', to: `/dm/${activeDm.id}/sketches`, end: false, ...(dmSketches ? { count: dmSketches, countLabel: `, ${dmSketches} ${dmSketches === 1 ? 'sketch' : 'sketches'}` } : {}) },
  ] : null;
  const place = location.pathname === '/projects'
    ? { crumb: null, title: 'Projects', topic: 'Every project you can open', noDetails: true }
    : /^\/settings(\/(appearance|account|notifications|agents|shortcuts)(\/.*)?)?$/.test(location.pathname)
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
        : { crumb: null, title: 'Inbox', topic: 'What involves you, with a link to each source', noDetails: true }
    : where === 'dm'
      ? activeDm
        // A DM's header names its exact audience (design principle 5).
        ? { crumb: null, title: activeDm.title, topic: activeDm.audience }
        : dmId === 'new'
          ? { crumb: null, title: 'New message', topic: 'Only the people you choose can read it', noDetails: true }
          : { crumb: null, title: 'Direct messages', topic: 'Conversations with people, outside any project', noDetails: true }
      // Home's Tasks span every workspace, so no single workspace is named above them (#190).
      : { crumb: location.pathname.startsWith('/tasks') ? null : workspace?.name ?? null, title: 'Home', topic: 'Your private notes and where you left off' };
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
  const matches = useMatches();
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
    ? addableViews(shownProjectViews).map((view) => ({ label: `Add ${VIEW_LABEL[view]}`, run: () => void addView(projectId, view) })) : [];
  const moreItems: MoreItem[] = [
    // A header with no room for them (Spokój rule 3) moves the people and Together here; the views stay in the row.
    ...(project?.people ? [{ label: 'Who can see this', run: openAudience, narrow: true }] : []),
    ...(activeProject ? [{ label: 'Together', node: <LiveEntry variant="more" /> }] : []),
    ...('noDetails' in place ? [] : [{ label: activeProject ? 'Project details' : activeDm ? 'Message info' : 'Details', run: () => { setDetailsView('place'); toggleDetails(true); } }]),
    ...(activeProject && projectId ? [{ label: 'What matters', run: () => { setDetailsView({ kind: 'recap', projectId }); toggleDetails(true); } }] : []),
    ...addViewItems,
    { label: focus.uncertain ? 'Check notification pause' : 'Focus', keys: 'F', checked: focusing, run: () => void focus.toggle() },
    tablet ? { label: 'Show the sidebar', keys: '[', run: () => setNavOpen(true) } : { label: railed || focusing ? 'Show the sidebar' : 'Hide the sidebar', keys: '[', run: toggleSidebar },
  ];

  // The phone's header (F-026 §4 Phone): inside a project or a conversation the round Back and the
  // title as the view menu with the view and who is here beneath it. The dock owns Search whenever
  // it is present; a conversation keeps header Search because it hides the dock.
  const goBack = (fallback: string) => { if (location.key !== 'default') void navigate(-1); else void navigate(fallback); };
  const searchButton = <IconButton icon="search" label="Search" size={20} className="phead__round" onClick={shell.openSearch} />;
  const detailsEntry = () => { setDetailsView('place'); toggleDetails(true); };
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
        <><PhoneBack onBack={() => goBack(settingsPage ? settingsParent : homePage ? '/' : '/projects')} />
          <div className="phead__id"><div className="phead__title"><h1>{location.pathname === '/projects/new' ? 'New project' : place.title}</h1></div></div></>
      ) : activeProject && projectViews ? (
        <><PhoneBack onBack={() => goBack('/projects')} />
          <PhoneTitleMenu title={place.title} items={projectMenu} onDetails={detailsEntry}
            goal={project?.project.goal && !project.project.goal.reachedAt ? project.project.goal.title : undefined}
            metadataSlot={onWiki || onAgents ? setMetadataSlot : undefined}
            adds={addViewItems.map((item) => ({ label: item.label, run: item.run }))}
            subtitle={onWiki ? peopleLine(project?.people ?? null) : <>{PROJECT_VIEW_NAMES[Math.max(0, viewOrder(location.pathname))]}{project?.people ? <span className="phead__people"> · {peopleLine(project.people, !onAgents)}</span> : null}</>} /></>
      ) : activeDm && dmViews ? (
        <><PhoneBack onBack={() => goBack('/projects')} />
          <PhoneTitleMenu title={activeDm.title} items={dmViews.map((view) => ({ id: view.id, label: view.label, to: view.to, icon: view.id === 'messages' ? 'chat' as const : 'edit' as const, current: view.id === (/\/sketches/.test(location.pathname) ? 'sketches' : 'messages') }))}
            onDetails={detailsEntry} detailsLabel="Message info"
            subtitle={`${/\/sketches/.test(location.pathname) ? 'Sketches' : 'Messages'} · ${activeDm.audience}`} /></>
      ) : location.pathname === '/' ? (
        <div className="phead__id">
          <PhoneHomeLead />
          <div className="phead__title"><h1><span className="ui-vh">Home</span><span className="phead__word" aria-hidden="true">flux</span></h1></div>
        </div>
      ) : (
        <div className="phead__id"><div className="phead__title"><h1>{place.title}</h1>{'topic' in place && place.topic ? <p className="phead__sub">{place.topic}</p> : null}</div></div>
      )}
      <div className="phead__right">
        <span className="top__actions" ref={setActionSlot} />
        {activeProject && /^\/projects\/[^/]+\/conversations\//.test(location.pathname) ? <ProjectAgentStop projectId={activeProject.id} /> : null}
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
    <div className={`app${phone && !detailsOpen && phoneOffersCreate(location.pathname) ? ' app--fab' : ''}`} ref={appRef}>
      <a className="ui-skip" href="#content">Skip to content</a>
      {phone ? null : navDrawer ? (
        <Drawer open={navOpen && navDrawer} onClose={() => setNavOpen(false)} labelledBy={drawerTitleId} id="nav-drawer" className="nav-drawer">
          <Sidebar {...sidebarProps} onClose={() => setNavOpen(false)} titleId={drawerTitleId} />
        </Drawer>
      ) : (
        // Tablet (Spokój): the sidebar is the 64 px rail (its width is set in CSS); its expand control opens the sidebar as a drawer.
        <aside className={`app__side${railed || focusing ? ' app__side--rail' : ''}`} aria-label="Sidebar"><Sidebar {...sidebarProps} collapsed={railed || focusing || tablet} onToggleCollapsed={focusing ? () => void focus.toggle() : tablet ? () => setNavOpen(true) : toggleSidebar} /></aside>
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
                {activeProject && needsYou ? <NeedsYouChip count={needsYou} open={recapOpen} onToggle={toggleRecap} /> : null}
                {project?.people ? <HeaderFaces people={project.people} audience={audience} onOpen={openAudience} /> : null}
                {activeProject ? <LiveEntry /> : null}
                <MoreMenu items={moreItems} />
              </>
            )}
          </div>
        </header>
        )}
        <RouteProgress />
        <LiveBar />
        {/* The conversation and its one panel share a row under the one header (Spokój, F-026 layout per screen). */}
        <div className="app__body">
          <div className="app__pane" id="content" ref={paneRef} tabIndex={-1}>
            <Outlet />
            <DeferredLiveStage />
          </div>
          <SidePanel open={detailsOpen} onClose={() => toggleDetails(false)} title={recapOpen ? 'What matters' : 'Details'} chip={objectChip} id="details"
            context={phone && (detailsView === 'place' || typeof detailsView === 'object' && detailsView.kind === 'overview') ? <OverviewContext message={typeof detailsView === 'object' && detailsView.kind === 'overview' && !!detailsView.messageId} /> : undefined}>
            <DeferredDetails view={detailsView} workspace={workspace} placeTitle={place.title} dm={activeDm ? { id: activeDm.id, kind: activeDm.kind, title: activeDm.title, me: me.user.name, people: activeDm.people, audience: activeDm.audience } : null} onBack={() => setDetailsView('place')} onClose={() => toggleDetails(false)} />
          </SidePanel>
        </div>
        {phone && !detailsOpen && (!phoneHidesDock(location.pathname) || phoneOffersCreate(location.pathname)) ? (
          <PhoneDock places={places} onSearch={shell.openSearch} onCreate={() => setCreateOpen(true)} create={phoneOffersCreate(location.pathname)} capsule={!phoneHidesDock(location.pathname)} />
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
