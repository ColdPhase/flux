import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, useLocation, useNavigate, useRevalidator } from 'react-router';
import { useStreamEvents } from '../api/stream';
import { Avatar, Button, Drawer, Icon, IconButton, MEDIA, SidePanel, Tabs, duration, flip, play, useMediaQuery, useSidePanelMode } from '../ui';
import { useShellData } from './data';
import { registerServiceWorker, syncPushSubscription } from '../pwa';
import { Details } from './Details';
import { useInboxDot } from '../notifications/dot';
import { placeOf } from './Rail';
import { ShellContext, type DetailsView } from './shellContext';
import { Sidebar } from './Sidebar';
import { VIEWS, viewIndex } from './views';
import { ProjectStateLine, ProjectStateRow } from '../work/inline';
import { audienceLine, useProjectShell } from '../project/data';
import { useDmSketchCount } from '../dm/DmSketches';
import type { ProjectPerson } from '@flux/contracts';
import { LiveProvider } from '../live/LiveProvider';
import { LiveEntry } from '../live/LiveEntry';
import { LiveBar } from '../live/LiveBar';
import { LiveStage } from '../live/LiveStage';
import '../live/live.css';
import { JumpTo } from '../search/JumpTo';
import { useNeedsYou } from '../returns/useNeedsYou';

function lastConversationPath(projectId: string) {
  try { return sessionStorage.getItem(`flux.project-conversation.${projectId}`) ?? `/projects/${projectId}`; }
  catch { return `/projects/${projectId}`; }
}

/** The Tasks view last chosen in this project (#136), e.g. `?status=blocked&show=mine`. */
function lastTasksSearch(projectId: string) {
  try { return sessionStorage.getItem(`flux.project-tasks.${projectId}`) ?? ''; }
  catch { return ''; }
}

/** Tab order for the slide direction: Home's views, or a project's Conversation · Tasks · Map · Docs. */
function viewOrder(pathname: string) {
  const inProject = pathname.match(/^\/projects\/[^/]+(?:\/(tasks|map|docs))?/);
  if (inProject) return ['conversation', 'tasks', 'map', 'docs'].indexOf(inProject[1] ?? 'conversation');
  // A direct message's Messages · Sketches (#96).
  const inDm = pathname.match(/^\/dm\/(?!new$)[^/]+(\/sketches)?/);
  if (inDm) return inDm[1] ? 1 : 0;
  return viewIndex(pathname);
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/**
 * Authenticated frame from direction C with the rail identity: dark rail · light sidebar ·
 * header with the view switcher · work area, and a Details panel that is closed by default.
 * Below 1180px rail and sidebar travel together in a drawer; the panel overlays below 980px
 * and becomes a full-screen sheet on the phone.
 */
export function AppLayout() {
  const { me, workspace, projects, directMessages } = useShellData();
  const location = useLocation();
  const backgroundSettings = location.pathname === '/settings/background-compute';
  const navDrawer = useMediaQuery(MEDIA.navDrawer);
  const phone = useMediaQuery(MEDIA.phone);
  const panelMode = useSidePanelMode();
  const [navOpen, setNavOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsView, setDetailsView] = useState<DetailsView>('place');
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

  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const shell = useMemo(() => ({
    openDetails(view: DetailsView = 'place') {
      setDetailsView(view);
      toggleDetails(true);
    },
    openSearch() { setNavOpen(false); setJumpOpen(true); },
    actionSlot,
  }), [toggleDetails, actionSlot]);

  // A link inside an overlaid panel or sheet (#117 overview) leads to its destination.
  const [shownPath, setShownPath] = useState(location.pathname);
  if (shownPath !== location.pathname) {
    setShownPath(location.pathname);
    if ((panelMode !== 'docked' || backgroundSettings) && detailsOpen) setDetailsOpen(false);
  }
  // `?open=work:<id>` (a notification's link, #116) opens that object in Details on its project.
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const match = /^(work|decision|result):([0-9a-f-]{36})$/i.exec(params.get('open') ?? '');
    if (!match) return;
    params.delete('open');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
    shell.openDetails({ kind: match[1]!.toLowerCase() as 'work' | 'decision' | 'result', id: match[2]!.toLowerCase() });
  }, [location.search, location.pathname, location.hash, navigate, shell]);
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

  // "]" toggles Details, as in the header tooltip.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (backgroundSettings) return;
      if (event.key !== ']' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.getElementById('root')?.inert && !detailsOpen) return;
      event.preventDefault();
      setDetailsView('place');
      toggleDetails();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleDetails, detailsOpen, backgroundSettings]);


  // A new view slides in from the side its tab sits on.
  useLayoutEffect(() => {
    const index = viewOrder(location.pathname);
    const direction = Math.sign(index - previousView.current);
    previousView.current = index;
    if (!direction) return;
    void play(paneRef.current, [{ opacity: 0, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }], duration('--dur-2'), '--ease-out', { fill: 'backwards' });
  }, [location.pathname]);

  const sidebarProps = { workspace, projects, directMessages, user: me.user, session: me.session, inboxUnread };
  const where = placeOf(location.pathname);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const activeProject = projects.find((project) => project.id === projectId);
  // The Conversation tab returns to the conversation that was open before Tasks, Map or Docs.
  const onOtherView = /^\/projects\/[^/]+\/(tasks|map|docs)(\/|$)/.test(location.pathname);
  useEffect(() => {
    if (!projectId || onOtherView) return;
    try { sessionStorage.setItem(`flux.project-conversation.${projectId}`, `${location.pathname}${location.search}`); } catch { /* private mode */ }
  }, [projectId, onOtherView, location.pathname, location.search]);
  const shellProject = useProjectShell();
  const project = shellProject && shellProject.project.id === projectId ? shellProject : undefined;
  const openWork = project?.work.work.filter((item) => !item.parked && (item.status === 'open' || item.status === 'in_progress' || item.status === 'blocked')).length;
  // Conversation · Tasks · Map · Docs (direction C), each a route of the project (#117).
  const projectViews = projectId ? [
    { id: 'conversation', label: 'Conversation', to: onOtherView ? lastConversationPath(projectId) : `${location.pathname}${location.search}` },
    { id: 'tasks', label: 'Tasks', to: `/projects/${projectId}/tasks${lastTasksSearch(projectId)}`, ...(openWork ? { count: openWork, countLabel: `, ${openWork} open` } : {}) },
    { id: 'map', label: 'Map', to: `/projects/${projectId}/map`, end: false, ...(project?.sketches?.total ? { count: project.sketches.total, countLabel: `, ${project.sketches.total} ${project.sketches.total === 1 ? 'sketch' : 'sketches'}` } : {}) },
    { id: 'docs', label: 'Docs', to: `/projects/${projectId}/docs`, end: false, ...(project?.docs?.length ? { count: project.docs.length, countLabel: `, ${project.docs.length} ${project.docs.length === 1 ? 'doc' : 'docs'}` } : {}) },
  ] : null;
  const projectIndex = projects.findIndex((item) => item.id === projectId);
  const audience = project ? audienceLine(project.people, me.user.id) : 'People with project access';
  const openOverview = () => { setDetailsView('place'); toggleDetails(true); };
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
  const place = backgroundSettings
    ? { crumb: null, title: 'Background suggestions', topic: 'Your connection and allowance', views: false, noDetails: true }
    : location.pathname === '/search'
    ? { crumb: null, title: 'Search', topic: 'Only what you can open is searched', views: false }
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
          ? { crumb: null, title: 'New message', topic: 'Only the people you choose can read it', views: false }
          : { crumb: null, title: 'Direct messages', topic: 'Conversations with people, outside any project', views: false }
      : { crumb: workspace?.name ?? null, title: 'Home', topic: 'Your private notes and where you left off', views: true };

  return (
    <ShellContext.Provider value={shell}>
    {/* One live session per tab, above the routes, so navigation keeps it (#62). */}
    <LiveProvider meId={me.user.id}>
    <div className="app">
      <a className="ui-skip" href="#content">Skip to content</a>
      {navDrawer ? (
        <Drawer open={navOpen && navDrawer} onClose={() => setNavOpen(false)} labelledBy={drawerTitleId} id="nav-drawer" className="nav-drawer">
          <Sidebar {...sidebarProps} onClose={() => setNavOpen(false)} titleId={drawerTitleId} />
        </Drawer>
      ) : (
        <aside className="app__side" aria-label="Sidebar"><Sidebar {...sidebarProps} /></aside>
      )}

      <div className="app__main">
        <header className={`top${activeProject ? ' top--project' : ''}`}>
          {navDrawer ? (
            <IconButton icon="menu" label="Open navigation" size={18} aria-expanded={navOpen} aria-controls={navOpen ? 'nav-drawer' : undefined}
              aria-haspopup="dialog" data-tip-align="start" onClick={() => { setDetailsOpen(false); setNavOpen(true); }} className="top__menu" />
          ) : null}
          {activeProject ? (
            <div className="top__head">
              <div className="top__title top__title--project">
                <span className={`top__pm rail__pm--${(Math.max(projectIndex, 0) % 4) + 1}`} aria-hidden="true">{activeProject.name.trim().charAt(0).toUpperCase() || '#'}</span>
                {place.crumb ? <><span className="top__crumb">{place.crumb}</span><span className="top__slash" aria-hidden="true">/</span></> : null}
                <h1>{place.title}</h1>
                {/* The audience never truncates away with the title; it opens the people in Details. */}
                <button type="button" className="top__audience" onClick={openOverview} aria-haspopup="dialog" title={audience}>
                  <Icon name="lock" size={12} /><span>{audience}</span><span className="ui-vh">, who can see this project</span>
                </button>
              </div>
              {project && !phone ? <ProjectStateLine lists={project.work} canDecide={project.project.access !== 'viewer'} /> : null}
            </div>
          ) : (
          <div className="top__title">
            {place.crumb ? <><span className="top__crumb">{place.crumb}</span><span className="top__slash" aria-hidden="true">/</span></> : null}
            <h1>{place.title}</h1>
            <span className="top__topic">{place.topic}</span>
          </div>
          )}
          <div className="top__right" data-shift>
            {/* A view can put one quiet action here (a DM's Select, #96). */}
            <span className="top__actions" ref={setActionSlot} />
            {activeProject ? <LiveEntry /> : null}
            {project?.people && !phone ? <Faces people={project.people} meId={me.user.id} /> : null}
            {/* The inbox and its settings have nothing to show in Details. */}
            {'noDetails' in place ? null : <Button ref={detailsButtonRef} variant="quiet" icon="panel" className="top__details" aria-expanded={detailsOpen && !recapOpen}
              aria-controls={detailsOpen ? 'details' : undefined} aria-keyshortcuts="]" data-tip={'Toggle details   ]'}
              onClick={() => { setDetailsView('place'); if (!recapOpen) toggleDetails(); }}>
              Details
            </Button>}
          </div>
        </header>
        {/* On a phone the tab row has no room: the entry joins the one-line project state row. */}
        {project && phone ? <div className="state-row"><ProjectStateRow lists={project.work} canDecide={project.project.access !== 'viewer'} />{recapEntry}</div> : null}
        {place.views
          ? <Tabs className="views" label="Views" items={VIEWS.map((view) => ({ id: view.id, label: view.label, to: view.path }))} />
          : activeProject && projectViews
            ? <div className="views views--project"><Tabs className="views__tabs" label="Project views" items={projectViews} />{phone ? null : recapEntry}</div>
            : dmViews
              ? <Tabs className="views" label="Direct message views" items={dmViews} />
              : <div className="views views--none" aria-hidden="true" />}
        <LiveBar />
        <div className="app__pane" id="content" ref={paneRef} tabIndex={-1}>
          <Outlet />
          <LiveStage />
        </div>
      </div>

      <JumpTo open={jumpOpen} onClose={() => setJumpOpen(false)} userId={me.user.id} />
      <SidePanel open={detailsOpen} onClose={() => toggleDetails(false)} title={recapOpen ? 'What matters' : 'Details'} id="details">
        <Details view={detailsView} workspace={workspace} placeTitle={place.title} dm={activeDm ? { id: activeDm.id, kind: activeDm.kind, title: activeDm.title, me: me.user.name, people: activeDm.people, audience: activeDm.audience } : null} onBack={() => setDetailsView('place')} onClose={() => toggleDetails(false)} />
      </SidePanel>
    </div>
    </LiveProvider>
    </ShellContext.Provider>
  );
}

/** The project's people as small faces beside Details (direction C); the list is in Details. */
function Faces({ people, meId }: { people: ProjectPerson[]; meId: string }) {
  const humans = [...people.filter((person) => person.kind === 'human' && person.id !== meId), ...people.filter((person) => person.id === meId)];
  const shown = humans.slice(-4);
  return (
    <span className="top__faces" aria-hidden="true">
      {humans.length > shown.length ? <span className="ui-avatar ui-avatar--md top__more">+{humans.length - shown.length}</span> : null}
      {shown.map((person) => <Avatar key={person.id} name={person.name} size="md" tone={person.id === meId ? 'me' : 'neutral'} />)}
    </span>
  );
}
