import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, useLocation, useNavigate, useParams, useRevalidator } from 'react-router';
import { useStreamEvents } from '../api/stream';
import { BottomNav, Button, Drawer, Icon, IconButton, MEDIA, SidePanel, Tabs, duration, flip, play, useMediaQuery, useSidePanelMode, type BottomNavItem, type TabItem } from '../ui';
import { useShellData } from './data';
import { registerServiceWorker, syncPushSubscription } from '../pwa';
import { Details } from './Details';
import { useInboxDot } from '../notifications/dot';
import { placeOf } from './place';
import { ShellContext, type DetailsView } from './shellContext';
import { Sidebar } from './Sidebar';
import { VIEWS, viewIndex } from './views';
import { ProjectStateLine, ProjectStateRow } from '../work/inline';
import { audienceLine, useProjectShell } from '../project/data';
import { useDmSketchCount } from '../dm/DmSketches';
import { LiveProvider } from '../live/LiveProvider';
import { LiveEntry } from '../live/LiveEntry';
import { LiveBar } from '../live/LiveBar';
import { LiveStage } from '../live/LiveStage';
import '../live/live.css';
import { JumpTo } from '../search/JumpTo';
import { useNeedsYou } from '../returns/useNeedsYou';
import { WorkReadProvider, useProjectWorkSummary } from '../work/WorkReadContext';
import { OverviewContext } from '../project/ProjectOverview';
import { ProjectGoal } from '../project/ProjectGoal';
import { remember, remembered } from './remembered';

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

/** Tab order for the slide direction: Home's views, or a project's Conversation · Map · Tasks · Wiki · Agents. */
function viewOrder(pathname: string) {
  const inProject = pathname.match(/^\/projects\/[^/]+(?:\/(tasks|map|docs|agents))?/);
  if (inProject) return ['conversation', 'map', 'tasks', 'docs', 'agents'].indexOf(inProject[1] ?? 'conversation');
  // A direct message's Messages · Sketches (#96).
  const inDm = pathname.match(/^\/dm\/(?!new$)[^/]+(\/sketches)?/);
  if (inDm) return inDm[1] ? 1 : 0;
  return viewIndex(pathname);
}

/**
 * The phone's bottom bar of main places (#266 PF-1, founder feedback on #264; #272 FF-3): Home,
 * Projects, Messages, Inbox and Sketchbook. It stays on every page, so people always see which area
 * they are in and can reach the others with a thumb (Apple HIG, Tab bars: "Make sure the tab bar is
 * visible when people navigate to different sections of your app"). Inside a project, a conversation
 * or a sketch its section stays current. Only a modal sheet or the on-screen keyboard covers it.
 */
function mainPlaces(pathname: string, inboxUnread: boolean): BottomNavItem[] {
  const home = pathname === '/' || /^\/(tasks|docs)(\/|$)/.test(pathname);
  const projects = /^\/projects(\/|$)/.test(pathname);
  const messages = /^\/dm(\/|$)/.test(pathname);
  const inbox = /^\/inbox(\/|$)/.test(pathname);
  const sketchbook = /^\/(notes|map)(\/|$)/.test(pathname);
  return [
    { id: 'home', label: 'Home', to: '/', icon: 'home', current: home },
    { id: 'projects', label: 'Projects', to: '/projects', icon: 'spark', current: projects },
    { id: 'messages', label: 'Messages', to: '/dm', icon: 'chat', current: messages },
    { id: 'inbox', label: 'Inbox', to: '/inbox', icon: 'inbox', current: inbox, ...(inboxUnread ? { countLabel: ', something new', dot: true } : {}) },
    { id: 'sketchbook', label: 'Sketchbook', to: '/notes', icon: 'edit', current: sketchbook },
  ];
}

/** Which place a path belongs to, for the transition between places: a project, a conversation, My sketchbook, or a page. */
function areaOf(pathname: string) {
  const inside = pathname.match(/^\/(projects|dm)\/[^/]+/)?.[0];
  if (inside) return inside;
  const first = pathname.split('/')[1] ?? '';
  return first === 'notes' || first === 'map' ? 'sketchbook' : first;
}

/** The desktop sidebar's hidden state is remembered on this device (#272 FF-5). */
const SIDE_KEY = 'flux.sidebar';
function readSideHidden() {
  try { return localStorage.getItem(SIDE_KEY) === 'hidden'; } catch { return false; }
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/**
 * Authenticated frame, Studio 11.6 (#136): one sidebar on the chrome and a rounded sheet with
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
  // A page inside Settings (#266 PF-5): on the phone its header leads back instead of opening the drawer.
  const settingsPage = /^\/settings\/./.test(location.pathname);
  const navDrawer = useMediaQuery(MEDIA.navDrawer);
  const phone = useMediaQuery(MEDIA.phone);
  const panelMode = useSidePanelMode();
  const [navOpen, setNavOpen] = useState(false);
  // Beside the sheet the sidebar can be hidden, so the work takes the width (#272 FF-5).
  const [sideHidden, setSideHidden] = useState(readSideHidden);
  const toggleSide = useCallback((hidden?: boolean) => {
    setSideHidden((was) => {
      const next = hidden ?? !was;
      try { if (next) localStorage.setItem(SIDE_KEY, 'hidden'); else localStorage.removeItem(SIDE_KEY); } catch { /* this visit only */ }
      return next;
    });
  }, []);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsView, setDetailsView] = useState<DetailsView>('place');
  const [detailsAccount, setDetailsAccount] = useState(me.user.id);
  if (detailsAccount !== me.user.id) { setDetailsAccount(me.user.id); setDetailsView('place'); setDetailsOpen(false); }
  const [jumpOpen, setJumpOpen] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
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
  useStreamEvents(me.user.id, (event) => {
    if (event.objectType !== 'dm') return;
    const known = directMessages.some((dm) => dm.id === event.objectId);
    if (!known || event.kind !== 'dm.message_sent.v1' || location.pathname === '/dm') revalidator.revalidate();
  }, () => revalidator.revalidate());

  const inboxUnread = useInboxDot(me.user.id, location.pathname);

  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const detailsOwner = useMemo(() => ({ accountId: me.user.id, projectId }), [me.user.id, projectId]);
  const detailsScope = useRef<typeof detailsOwner | null>(detailsOwner);
  useLayoutEffect(() => { detailsScope.current = detailsOwner; return () => { detailsScope.current = null; }; }, [detailsOwner]);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const shell = useMemo(() => ({
    openDetails(view: DetailsView = 'place') {
      if (detailsScope.current !== detailsOwner) return;
      setDetailsView(typeof view === 'object' && 'id' in view ? { ...view, projectId: view.projectId ?? projectId } : view);
      toggleDetails(true);
    },
    openSearch() { setNavOpen(false); setJumpOpen(true); },
    openNavigation() { setDetailsOpen(false); setNavOpen(true); },
    actionSlot,
  }), [toggleDetails, actionSlot, projectId, detailsOwner]);

  // A link inside an overlaid panel or sheet (#117 overview) leads to its destination.
  const [shownPath, setShownPath] = useState(location.pathname);
  if (shownPath !== location.pathname) {
    setShownPath(location.pathname);
    if ((panelMode !== 'docked' || backgroundSettings) && detailsOpen) setDetailsOpen(false);
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
    const inProject = /^\/projects\/[^/]+/.test(location.pathname);
    const people = open === 'people' && inProject;
    // `?open=recap` (Home's "What matters", #272) opens the project's recap.
    const recap = open === 'recap' && inProject;
    if (!match && !people && !recap) return;
    openedAt.current = location.key;
    params.delete('open');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, defaultShouldRevalidate: false });
    const recapProject = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
    shell.openDetails(match ? { kind: match[1]!.toLowerCase() as 'work' | 'decision' | 'result', id: match[2]!.toLowerCase() }
      : recap && recapProject ? { kind: 'recap', projectId: recapProject } : { kind: 'overview', focus: 'people' });
  }, [location.key, location.search, location.pathname, location.hash, navigate, shell]);
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

  // Focus follows the sidebar: hiding it moves focus to "Show sidebar", showing it to "Hide sidebar",
  // so a keyboard never lands in content that just became inert.
  const sideShown = useRef(sideHidden);
  useEffect(() => {
    if (sideShown.current === sideHidden) return;
    sideShown.current = sideHidden;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('.app__side, .top__show-side')) return;
    document.querySelector<HTMLElement>(sideHidden ? '.top__show-side' : '.side__collapse')?.focus();
  }, [sideHidden]);

  // "[" hides or shows the sidebar beside the sheet (#272 FF-5), as "]" does for Details.
  useEffect(() => {
    if (navDrawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '[' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.getElementById('root')?.inert) return;
      event.preventDefault();
      toggleSide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navDrawer, toggleSide]);

  // "]" toggles Details, as in the header tooltip, only where the header offers Details.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!detailsButtonRef.current) return;
      if (event.key !== ']' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.getElementById('root')?.inert && !detailsOpen) return;
      event.preventDefault();
      setDetailsView('place');
      toggleDetails();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleDetails, detailsOpen]);


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
      if (window.innerHeight - viewport.height > 120) {
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
  const previousArea = useRef(areaOf(location.pathname));
  useLayoutEffect(() => {
    const index = viewOrder(location.pathname);
    const settingsDepth = (path: string) => (path === '/settings' ? 1 : /^\/settings\/./.test(path) ? 2 : 0);
    const from = settingsDepth(previousPath.current);
    const to = settingsDepth(location.pathname);
    previousPath.current = location.pathname;
    const direction = from && to && from !== to ? Math.sign(to - from) : Math.sign(index - previousView.current);
    const distance = from && to && from !== to ? 28 : 12;
    previousView.current = index;
    const area = areaOf(location.pathname);
    const before = previousArea.current;
    previousArea.current = area;
    // Moving to another place (Home, a project, a conversation) rises in gently, so the change of place is
    // felt as well as seen (#272 FF-9); views within a place keep their sideways slide.
    if (!direction && area !== before) {
      // A list opening one of its places pushes in from the right, and going back to the list slides in
      // from the left, as a phone's navigation does (#264: "push in, swipe back"); other moves rise in.
      const depth = (key: string) => (/^\/(projects|dm)\//.test(key) ? 2 : 1);
      const push = Math.sign(depth(area) - depth(before));
      void play(paneRef.current, push
        ? [{ opacity: 0, transform: `translateX(${push * 24}px)` }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], duration('--dur-2'), '--ease-out', { fill: 'backwards' });
      return;
    }
    if (!direction) return;
    void play(paneRef.current, [{ opacity: 0, transform: `translateX(${direction * distance}px)` }, { opacity: 1, transform: 'none' }], duration('--dur-2'), '--ease-out', { fill: 'backwards' });
  }, [location.pathname]);

  const sidebarProps = { workspace, projects, directMessages, user: me.user, session: me.session, inboxUnread };
  const where = placeOf(location.pathname);
  const activeProject = projects.find((project) => project.id === projectId);
  // The Conversation tab returns to the conversation that was open before Tasks, Map, Docs or project
  // settings (GitHub), and the
  // Map tab to the sketch (or list) that was open there.
  const onOtherView = /^\/projects\/[^/]+\/(tasks|map|docs|agents|github)(\/|$)/.test(location.pathname);
  const onMap = /^\/projects\/[^/]+\/map(\/|$)/.test(location.pathname);
  useEffect(() => {
    if (!projectId || (onOtherView && !onMap)) return;
    remember(onMap ? 'map' : 'conversation', me.user.id, projectId, `${location.pathname}${location.search}`);
  }, [me.user.id, projectId, onOtherView, onMap, location.pathname, location.search]);
  const shellProject = useProjectShell();
  const project = shellProject && shellProject.project.id === projectId ? shellProject : undefined;
  const workSummary = useProjectWorkSummary();
  const openWork = project ? workSummary.summary?.unfinishedTotal : undefined;
  // Conversation · Map · Tasks · Wiki · Agents in the Studio 11.6 order (#117, #136); quiet tabs without
  // counts. The unfinished work count stays readable to assistive technology on the Tasks tab.
  const projectViews = projectId ? [
    { id: 'conversation', label: 'Conversation', to: onOtherView ? lastConversationPath(me.user.id, projectId) : `${location.pathname}${location.search}` },
    { id: 'map', label: 'Map', to: onMap ? location.pathname : lastMapPath(me.user.id, projectId, project?.sketches), end: false },
    { id: 'tasks', label: 'Tasks', to: `/projects/${projectId}/tasks${lastTasksSearch(me.user.id, projectId)}`, ...(openWork ? { countLabel: `, ${openWork} open` } : {}) },
    { id: 'docs', label: 'Wiki', to: `/projects/${projectId}/docs`, end: false },
    { id: 'agents', label: 'Agents', to: `/projects/${projectId}/agents` },
  ] : null;
  const homeViews: TabItem[] = VIEWS.map((view) => ({ id: view.id, label: view.label, to: view.path, end: false }));
  const places = mainPlaces(location.pathname, inboxUnread);
  const backTo = !phone ? null
    : /^\/projects\/(?!new$)[^/]+/.test(location.pathname) ? { to: '/projects', label: 'All projects' }
      : /^\/dm\/(?!new$)[^/]+/.test(location.pathname) ? { to: '/dm', label: 'All messages' }
        : /^\/map\/[^/]+/.test(location.pathname) ? { to: '/map', label: 'My sketchbook' } : null;
  const audienceOpen = project?.project.visibility === 'workspace';
  const audience = project ? audienceLine(project.people, me.user.id, audienceOpen) : 'People with project access';
  // The audience line leads to "Who can see this", where managers change it (#188).
  const openAudience = () => { setDetailsView({ kind: 'overview', focus: 'people' }); toggleDetails(true); };
  const recapOpen = detailsOpen && typeof detailsView === 'object' && detailsView.kind === 'recap';
  // "What matters" (#133): a quiet count of what needs you; refreshed when the panel closes.
  const needsYou = useNeedsYou(activeProject ? projectId ?? null : null, recapOpen);
  // One stable entry at the end of the project's view tabs, as in Studio v11, so the header keeps
  // its room for the title, audience and state line.
  const recapEntry = activeProject && projectId ? (
    <Button variant="quiet" icon="leaf" className="views__recap" aria-expanded={recapOpen}
      aria-controls={recapOpen ? 'details' : undefined}
      onClick={() => { if (recapOpen) toggleDetails(false); else { setDetailsView({ kind: 'recap', projectId }); toggleDetails(true); } }}>
      What matters
      {needsYou ? <span className="views__recap-n">{needsYou}<span className="ui-vh"> {needsYou === 1 ? 'needs' : 'need'} you</span></span> : null}
    </Button>
  ) : null;

  const dmId = location.pathname.match(/^\/dm\/([^/]+)/)?.[1];
  const activeDm = directMessages.find((dm) => dm.id === dmId);
  // Messages · Sketches: a DM's sketches stay inside it, for exactly its people (#96).
  const dmSketches = useDmSketchCount(activeDm?.workspaceId, activeDm?.id, me.user.id);
  const dmViews = activeDm ? [
    { id: 'messages', label: 'Messages', to: `/dm/${activeDm.id}` },
    { id: 'sketches', label: 'Sketches', to: `/dm/${activeDm.id}/sketches`, end: false, ...(dmSketches ? { count: dmSketches, countLabel: `, ${dmSketches} ${dmSketches === 1 ? 'sketch' : 'sketches'}` } : {}) },
  ] : null;
  const place = location.pathname === '/projects'
    ? { crumb: null, title: 'Projects', topic: 'Every project you can open', views: false, noDetails: true }
    : location.pathname === '/settings'
    ? { crumb: null, title: 'Settings', topic: 'Your account, this device and your AI', views: false, noDetails: true }
    : backgroundSettings
    ? { crumb: null, title: 'Background suggestions', topic: 'Your connection and allowance', views: false, noDetails: true }
    : location.pathname === '/search'
    ? { crumb: null, title: 'Search', topic: 'Only what you can open is searched', views: false, noDetails: true }
    : location.pathname === '/settings/assistant'
    ? { crumb: null, title: 'Your assistant', topic: 'Only you can use it · optional', views: false, noDetails: true }
    : activeProject
    ? { crumb: activeProject.workspaceName ?? null, title: activeProject.name, topic: audience, views: false }
    : where === 'inbox'
      ? location.pathname.startsWith('/settings/')
        ? { crumb: null, title: 'Notification settings', topic: 'What reaches you, where and when', views: false, noDetails: true }
        : { crumb: null, title: 'Inbox', topic: 'What involves you, with a link to each source', views: false, noDetails: true }
    : where === 'dm'
      ? activeDm
        // A DM's header names its exact audience (design principle 5).
        ? { crumb: null, title: activeDm.title, topic: activeDm.audience, views: false }
        : dmId === 'new'
          ? { crumb: null, title: 'New message', topic: 'Only the people you choose can read it', views: false, noDetails: true }
          : { crumb: null, title: 'Direct messages', topic: 'Conversations with people, outside any project', views: false, noDetails: true }
      : location.pathname === '/'
        // The page itself greets and explains (#272 FF-2), so the header stays quiet.
        ? { crumb: null, title: 'Home', topic: '', views: false, noDetails: true }
        // All my tasks span every workspace, so no single workspace is named above them (#190).
        : location.pathname === '/tasks'
          ? { crumb: null, title: 'My work', topic: 'Tasks you own in every project', views: false, noDetails: true }
          : location.pathname === '/docs'
            ? { crumb: null, title: 'Wiki pages', topic: 'Pages in the projects you can read', views: false, noDetails: true }
            // My sketchbook (#272 FF-3): a private place with its notes and sketches.
            : { crumb: null, title: 'My sketchbook', topic: 'Only you', views: true };
  // A place without its own Details (Search, Inbox, the DM list) never keeps the generic panel open.
  if ('noDetails' in place && detailsOpen && detailsView === 'place') setDetailsOpen(false);

  return (
    <ShellContext.Provider value={shell}>
    {/* One live session per tab, above the routes, so navigation keeps it (#62). */}
    <LiveProvider meId={me.user.id}>
    <div className="app" ref={appRef} data-side={!navDrawer && sideHidden ? 'hidden' : undefined}>
      <a className="ui-skip" href="#content">Skip to content</a>
      {navDrawer ? (
        <Drawer open={navOpen && navDrawer} onClose={() => setNavOpen(false)} labelledBy={drawerTitleId} id="nav-drawer" className="nav-drawer">
          <Sidebar {...sidebarProps} onClose={() => setNavOpen(false)} titleId={drawerTitleId} />
        </Drawer>
      ) : (
        <aside className="app__side" aria-label="Sidebar" inert={sideHidden || undefined}><Sidebar {...sidebarProps} onCollapse={() => toggleSide(true)} /></aside>
      )}

      <div className="app__main">
        <header className={`top${activeProject ? ' top--project' : ''}`}>
          {phone && backTo ? (
            // Inside a place on the phone, the top-left control leads back to its list, as in a messenger
            // (#272 FF-3, visual review of #267); the lists keep the menu and the bar of main places.
            <IconButton icon="chevron-left" label={backTo.label} size={20} className="top__back" data-tip-align="start"
              onClick={() => navigate(backTo.to)} />
          ) : phone && settingsPage ? (
            <IconButton icon="chevron-left" label="Back" size={20} className="top__back" data-tip-align="start"
              onClick={() => { if (location.key !== 'default') navigate(-1); else navigate('/settings'); }} />
          ) : !navDrawer && sideHidden ? (
            <IconButton icon="panel" label="Show sidebar" size={18} className="top__menu top__show-side" aria-keyshortcuts="[" data-tip={'Show sidebar   ['}
              data-tip-align="start" onClick={() => toggleSide(false)} />
          ) : navDrawer ? (
            <IconButton icon="menu" label="Open navigation" size={18} aria-expanded={navOpen} aria-controls={navOpen ? 'nav-drawer' : undefined}
              aria-haspopup="dialog" data-tip-align="start" onClick={() => { setDetailsOpen(false); setNavOpen(true); }} className="top__menu" />
          ) : null}
          {activeProject ? (
            <div className="top__head">
              <div className="top__title top__title--project">
                {place.crumb ? <><span className="top__crumb">{place.crumb}</span><span className="top__slash" aria-hidden="true">/</span></> : null}
                <h1 title={place.title}>{place.title}</h1>
              </div>
              <div className="top__meta">
                {/* Who can read the project, then its current state; Details retains the full names. */}
                <button type="button" className="top__audience" onClick={openAudience} aria-haspopup="dialog" title={audience}>
                  <Icon name={audienceOpen ? 'people' : 'lock'} size={12} /><span>{audience}</span><span className="ui-vh">, who can see this project</span>
                </button>
                {/* What the project is for (#272 FF-6), then its current state. */}
                {project ? <ProjectGoal project={project.project} accountId={me.user.id} /> : null}
                {project && !phone ? <ProjectStateLine summary={workSummary.summary} phase={workSummary.phase} /> : null}
              </div>
            </div>
          ) : (
          <div className="top__title">
            {place.crumb ? <><span className="top__crumb">{place.crumb}</span><span className="top__slash" aria-hidden="true">/</span></> : null}
            <h1>{place.title}</h1>
            {place.topic ? <span className="top__topic">{place.topic}</span> : null}
          </div>
          )}
          <div className="top__right" data-shift>
            {/* A view can put one quiet action here (a DM's Select, #96). */}
            <span className="top__actions" ref={setActionSlot} />
            {activeProject ? <LiveEntry /> : null}
            {/* The inbox and its settings have nothing to show in Details. */}
            {/* Labelled on every size (#264: icons alone left people unsure what to tap). */}
            {'noDetails' in place ? null : <Button ref={detailsButtonRef} variant="quiet" icon="panel" className="top__details" aria-expanded={detailsOpen && !recapOpen}
              aria-controls={detailsOpen ? 'details' : undefined} aria-keyshortcuts="]" data-tip={'Toggle details   ]'}
              onClick={() => { setDetailsView('place'); if (!recapOpen) toggleDetails(); }}>
              Details
            </Button>}
          </div>
        </header>
        {/* The project's state line (needs you, rule, blocked) with "What matters" stays on the phone's
            Conversation, where people orient themselves (#266 PF-2). */}
        {project && phone && !onOtherView ? <div className="state-row"><ProjectStateRow summary={workSummary.summary} phase={workSummary.phase} />{recapEntry}</div> : null}
        {/* A place's views: tabs on wider screens, a row of chips with the current one filled on the phone
            (#266 PF-1), so where you are is never a guess. */}
        {place.views
          ? <Tabs className={`views${phone ? ' views--chips' : ''}`} label="Views" items={homeViews} />
          : activeProject && projectViews
            ? <div className={`views views--project${phone ? ' views--chips' : ''}`}><Tabs className="views__tabs" label="Project views" items={projectViews} />{phone ? null : recapEntry}</div>
            : dmViews
              ? <Tabs className={`views${phone ? ' views--chips' : ''}`} label="Direct message views" items={dmViews} />
              : <div className="views views--none" aria-hidden="true" />}
        <LiveBar />
        <div className="app__pane" id="content" ref={paneRef} tabIndex={-1}>
          <Outlet />
          <LiveStage />
        </div>
        {phone ? <BottomNav className="app__viewbar" label="Main places" items={places} /> : null}
      </div>

      <JumpTo open={jumpOpen} onClose={() => setJumpOpen(false)} userId={me.user.id} />
      <SidePanel open={detailsOpen} onClose={() => toggleDetails(false)} title={recapOpen ? 'What matters' : 'Details'} id="details"
        context={phone && (detailsView === 'place' || typeof detailsView === 'object' && detailsView.kind === 'overview') ? <OverviewContext /> : undefined}>
        <Details view={detailsView} workspace={workspace} placeTitle={place.title} dm={activeDm ? { id: activeDm.id, kind: activeDm.kind, title: activeDm.title, me: me.user.name, people: activeDm.people, audience: activeDm.audience } : null} onBack={() => setDetailsView('place')} onClose={() => toggleDetails(false)} />
      </SidePanel>
    </div>
    </LiveProvider>
    </ShellContext.Provider>
  );
}
