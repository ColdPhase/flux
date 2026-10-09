import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ProjectPerson } from '@flux/contracts';
import { Outlet, useLocation, useNavigate, useParams, useRevalidator } from 'react-router';
import { useStreamEvents } from '../api/stream';
import { Drawer, IconButton, MEDIA, SidePanel, Tabs, duration, flip, play, useMediaQuery, useSidePanelMode, type TabItem } from '../ui';
import { useShellData } from './data';
import { registerServiceWorker, syncPushSubscription } from '../pwa';
import { Details } from './Details';
import { useInboxDot } from '../notifications/dot';
import { placeOf } from './place';
import { ShellContext, type DetailsView } from './shellContext';
import { Sidebar } from './Sidebar';
import { VIEWS, startCapture, viewIndex } from './views';
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
import { remember, remembered } from './remembered';
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
  // A page inside Settings (#266 PF-5): on the phone its header leads back instead of opening the drawer.
  const settingsPage = /^\/settings\/./.test(location.pathname);
  const navDrawer = useMediaQuery(MEDIA.navDrawer);
  const phone = useMediaQuery(MEDIA.phone);
  const panelMode = useSidePanelMode();
  const [navOpen, setNavOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsView, setDetailsView] = useState<DetailsView>('place');
  const [detailsAccount, setDetailsAccount] = useState(me.user.id);
  if (detailsAccount !== me.user.id) { setDetailsAccount(me.user.id); setDetailsView('place'); setDetailsOpen(false); }
  const [jumpOpen, setJumpOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
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
    const people = open === 'people' && /^\/projects\/[^/]+/.test(location.pathname);
    if (!match && !people) return;
    openedAt.current = location.key;
    params.delete('open');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, defaultShouldRevalidate: false });
    shell.openDetails(match ? { kind: match[1]!.toLowerCase() as 'work' | 'decision' | 'result', id: match[2]!.toLowerCase() } : { kind: 'overview', focus: 'people' });
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

  // "[" collapses or expands the sidebar, "F" turns focus on and off, and "G" then "I" goes to the
  // Inbox (F-026 §4 keyboard).
  const toggleFocus = focus.toggle;
  useEffect(() => {
    let leader = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
      if (document.getElementById('root')?.inert) return;
      if (event.key === '[') { event.preventDefault(); toggleRail(); return; }
      const key = event.key.toLowerCase();
      if (key === 'f' && !phone) { event.preventDefault(); void toggleFocus(); return; }
      if (key === 'g') { leader = Date.now(); return; }
      if (key === 'i' && Date.now() - leader < 1200) { event.preventDefault(); leader = 0; navigate('/inbox'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleRail, toggleFocus, navigate, phone]);


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
  // Home itself is drawn without a header row; the name stays for assistive technology.
  const homeRoot = where === 'home' && location.pathname === '/';
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
  // Conversation · Map · Tasks · Wiki · Agents in the final design's order (#117); quiet tabs without
  // counts. The unfinished work count stays readable to assistive technology on the Tasks tab.
  const projectViews = projectId ? [
    { id: 'conversation', label: 'Conversation', to: onOtherView ? lastConversationPath(me.user.id, projectId) : `${location.pathname}${location.search}` },
    { id: 'map', label: 'Map', to: onMap ? location.pathname : lastMapPath(me.user.id, projectId, project?.sketches), end: false },
    { id: 'tasks', label: 'Tasks', to: `/projects/${projectId}/tasks${lastTasksSearch(me.user.id, projectId)}`, ...(openWork ? { countLabel: `, ${openWork} open` } : {}) },
    { id: 'docs', label: 'Wiki', to: `/projects/${projectId}/docs`, end: false },
    { id: 'agents', label: 'Agents', to: `/projects/${projectId}/agents` },
  ] : null;
  const homeViews: TabItem[] = VIEWS.map((view) => ({ id: view.id, label: view.label, to: view.path, end: view.path === '/' }));
  const places = phonePlaces(location.pathname, inboxUnread);
  const audienceOpen = project?.project.visibility === 'workspace';
  const audience = project ? audienceLine(project.people, me.user.id, audienceOpen) : 'People with project access';
  // The audience line leads to "Who can see this", where managers change it (#188).
  const openAudience = () => { setDetailsView({ kind: 'overview', focus: 'people' }); toggleDetails(true); };
  const recapOpen = detailsOpen && typeof detailsView === 'object' && detailsView.kind === 'recap';
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
        : { crumb: null, title: 'Inbox', topic: '', views: false, noDetails: true }
    : where === 'dm'
      ? activeDm
        // A DM's header names its exact audience (design principle 5).
        ? { crumb: null, title: activeDm.title, topic: activeDm.audience, views: false }
        : dmId === 'new'
          ? { crumb: null, title: 'New message', topic: 'Only the people you choose can read it', views: false, noDetails: true }
          : { crumb: null, title: 'Direct messages', topic: 'Conversations with people, outside any project', views: false, noDetails: true }
      // Home has no views (#342): the page starts with the date and a greeting. Its other pages are places of their own.
      : location.pathname.startsWith('/map') ? { crumb: null, title: 'Sketchbook', topic: 'Only you can see it', views: false }
      : location.pathname.startsWith('/tasks') ? { crumb: null, title: 'Your tasks', topic: 'The work you own, in every project', views: false }
      : location.pathname.startsWith('/docs') ? { crumb: null, title: 'Wiki', topic: 'Docs in your projects', views: false }
      : { crumb: null, title: 'Home', topic: '', views: false };
  // A place without its own Details (Search, Inbox, the DM list) never keeps the generic panel open.
  if ('noDetails' in place && detailsOpen && detailsView === 'place') setDetailsOpen(false);

  // The computer's header is one row (F-026 §4): the name, the place's views as a segmented control,
  // then what needs you, the people and agents, and More. Focus keeps only the name, the view and
  // the way out.
  const rowViews = phone ? null
    : activeProject && projectViews ? { items: projectViews, label: 'Project views' }
      : dmViews ? { items: dmViews, label: 'Direct message views' }
        : place.views ? { items: homeViews, label: 'Views' } : null;
  const viewName = activeProject ? PROJECT_VIEW_NAMES[Math.max(0, viewOrder(location.pathname))] : null;
  const moreItems: MoreItem[] = [
    ...('noDetails' in place ? [] : [{ label: 'Details', run: () => { setDetailsView('place'); toggleDetails(true); } }]),
    ...(activeProject && projectId ? [{ label: 'What matters', run: () => { setDetailsView({ kind: 'recap', projectId }); toggleDetails(true); } }] : []),
    { label: 'Focus', keys: 'F', checked: focusing, run: () => void focus.toggle() },
    { label: railed ? 'Show the sidebar' : 'Hide the sidebar', keys: '[', run: toggleRail },
  ];

  // The phone's header (F-026 §4 Phone): inside a project or a conversation the round Back, the title as
  // the view menu with the view and who is here beneath it, and Search; on Home the logo, the same menu
  // and the avatar; on the other main places a large title and the avatar.
  const goBack = (fallback: string) => { if (location.key !== 'default') void navigate(-1); else void navigate(fallback); };
  const searchButton = <IconButton icon="search" label="Search" size={20} className="phead__round" onClick={shell.openSearch} />;
  const detailsEntry = () => { setDetailsView('place'); toggleDetails(true); };
  const peopleLine = (people: ProjectPerson[] | null) => {
    if (!people) return '';
    const humans = people.filter((person) => person.kind === 'human').length;
    const agents = people.length - humans;
    return `${humans} ${humans === 1 ? 'person' : 'people'}${agents ? ` · ${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}`;
  };
  const currentProjectView = ['conversation', 'map', 'tasks', 'docs', 'agents'][Math.max(0, viewOrder(location.pathname))];
  const projectMenu: PhoneMenuItem[] = projectViews ? ([
    ['conversation', 'chat', undefined], ['tasks', 'tasks', openWork ? `${openWork} open` : undefined], ['map', 'edit', undefined], ['docs', 'doc', undefined],
    ['agents', 'spark', project?.people?.some((person) => person.kind === 'agent') ? `${project.people.filter((person) => person.kind === 'agent').length} agents` : undefined],
  ] as const).map(([id, icon, note]) => {
    const view = projectViews.find((item) => item.id === id)!;
    return { id, label: view.label, to: view.to, icon, note, current: currentProjectView === id };
  }) : [];
  const mainPlace = ['/projects', '/inbox', '/search', '/dm', '/settings'].includes(location.pathname) || /^\/inbox\//.test(location.pathname);
  const homePage = /^\/(tasks|map|docs)(\/|$)/.test(location.pathname);
  const backOnly = settingsPage || location.pathname === '/projects/new' || dmId === 'new' || homePage;
  const phoneHeader = (
    <header className={`phead${mainPlace ? ' phead--large' : ''}`}>
      {backOnly ? (
        <><PhoneBack onBack={() => goBack(settingsPage ? '/settings' : homePage ? '/' : '/projects')} />
          <div className="phead__id"><div className="phead__title"><h1>{location.pathname === '/projects/new' ? 'New project' : place.title}</h1></div></div></>
      ) : activeProject && projectViews ? (
        <><PhoneBack onBack={() => goBack('/projects')} />
          <PhoneTitleMenu title={place.title} items={projectMenu} onDetails={detailsEntry} matters={projectId ? { count: needsYou, run: toggleRecap } : undefined}
            subtitle={[PROJECT_VIEW_NAMES[Math.max(0, viewOrder(location.pathname))], peopleLine(project?.people ?? null)].filter(Boolean).join(' · ')} /></>
      ) : activeDm && dmViews ? (
        <><PhoneBack onBack={() => goBack('/projects')} />
          <PhoneTitleMenu title={activeDm.title} items={dmViews.map((view) => ({ id: view.id, label: view.label, to: view.to, icon: view.id === 'messages' ? 'chat' as const : 'edit' as const, current: view.id === (/\/sketches/.test(location.pathname) ? 'sketches' : 'messages') }))}
            onDetails={detailsEntry} detailsLabel="Details and people"
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
        {activeProject ? <LiveEntry /> : null}
        {activeProject || activeDm ? searchButton : null}
        {!backOnly && !activeProject && !activeDm && location.pathname !== '/settings' ? <PhoneAvatar name={me.user.name} /> : null}
      </div>
    </header>
  );

  return (
    <ShellContext.Provider value={shell}>
    {/* One live session per tab, above the routes, so navigation keeps it (#62). */}
    <LiveProvider meId={me.user.id}>
    <div className={`app${phone && !phoneHidesDock(location.pathname) && phoneOffersCreate(location.pathname) ? ' app--fab' : ''}`} ref={appRef}>
      <a className="ui-skip" href="#content">Skip to content</a>
      {phone ? null : navDrawer ? (
        <Drawer open={navOpen && navDrawer} onClose={() => setNavOpen(false)} labelledBy={drawerTitleId} id="nav-drawer" className="nav-drawer">
          <Sidebar {...sidebarProps} onClose={() => setNavOpen(false)} titleId={drawerTitleId} />
        </Drawer>
      ) : (
        <aside className={`app__side${railed || focusing ? ' app__side--rail' : ''}`} aria-label="Sidebar"><Sidebar {...sidebarProps} collapsed={railed || focusing} onToggleCollapsed={focusing ? () => void focus.toggle() : toggleRail} /></aside>
      )}

      <div className="app__main">
        {phone ? phoneHeader : (
        <header className={`top${activeProject ? ' top--project' : ''} top--row${focusing ? ' top--focus' : ''}${homeRoot ? ' top--bare' : ''}`}>
          {navDrawer ? (
            <IconButton icon="menu" label="Open navigation" size={18} aria-expanded={navOpen} aria-controls={navOpen ? 'nav-drawer' : undefined}
              aria-haspopup="dialog" data-tip-align="start" onClick={() => { setDetailsOpen(false); setNavOpen(true); }} className="top__menu" />
          ) : null}
          <div className="top__title">
            {place.crumb && !activeProject ? <><span className="top__crumb">{place.crumb}</span><span className="top__slash" aria-hidden="true">/</span></> : null}
            <h1 title={place.title}>{place.title}</h1>
            {focusing && viewName ? <span className="top__topic">{viewName}</span>
              : !rowViews || where === 'dm' ? <span className="top__topic">{activeProject ? null : place.topic}</span> : null}
          </div>
          {rowViews && !focusing ? <Tabs variant="segmented" className="top__views" label={rowViews.label} items={rowViews.items} /> : null}
          <div className="top__right" data-shift>
            {/* A view can put one quiet action here (a DM's Select, #96). */}
            <span className="top__actions" ref={setActionSlot} />
            {focusing && focus.until ? <FocusPill until={focus.until} onEnd={() => void focus.toggle()} /> : (
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
        <LiveBar />
        <div className="app__pane" id="content" ref={paneRef} tabIndex={-1}>
          <Outlet />
          <LiveStage />
        </div>
        {phone && !detailsOpen && !phoneHidesDock(location.pathname) ? (
          <PhoneDock places={places} onSearch={shell.openSearch} onCreate={() => setCreateOpen(true)} create={phoneOffersCreate(location.pathname)} />
        ) : null}
      </div>

      {phone ? <PhoneCreate open={createOpen} onClose={() => setCreateOpen(false)} projects={projects} projectId={projectId} go={(to) => void navigate(to)} onThought={() => startCapture(navigate)} /> : null}
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
