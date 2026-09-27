import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, useLocation, useRevalidator } from 'react-router';
import { useStreamEvents } from '../api/stream';
import { Button, Drawer, IconButton, MEDIA, SidePanel, Tabs, duration, flip, play, useMediaQuery, useSidePanelMode } from '../ui';
import { useShellData } from './data';
import { registerServiceWorker, syncPushSubscription } from '../pwa';
import { Details } from './Details';
import { placeOf } from './Rail';
import { ShellContext, type DetailsView } from './shellContext';
import { Sidebar } from './Sidebar';
import { VIEWS, viewIndex } from './views';

function lastConversationPath(projectId: string) {
  try { return sessionStorage.getItem(`flux.project-conversation.${projectId}`) ?? `/projects/${projectId}`; }
  catch { return `/projects/${projectId}`; }
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
  const navDrawer = useMediaQuery(MEDIA.navDrawer);
  const panelMode = useSidePanelMode();
  const [navOpen, setNavOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsView, setDetailsView] = useState<DetailsView>('place');
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(viewIndex(location.pathname));
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

  const shell = useMemo(() => ({
    openDetails(view: DetailsView = 'place') {
      setDetailsView(view);
      toggleDetails(true);
    },
  }), [toggleDetails]);

  // "]" toggles Details, as in the header tooltip.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ']' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.getElementById('root')?.inert && !detailsOpen) return;
      event.preventDefault();
      setDetailsView('place');
      toggleDetails();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleDetails, detailsOpen]);


  // A new view slides in from the side its tab sits on.
  useLayoutEffect(() => {
    const index = viewIndex(location.pathname);
    const direction = Math.sign(index - previousView.current);
    previousView.current = index;
    if (!direction) return;
    void play(paneRef.current, [{ opacity: 0, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }], duration('--dur-2'), '--ease-out', { fill: 'backwards' });
  }, [location.pathname]);

  const sidebarProps = { workspace, projects, directMessages, user: me.user, session: me.session };
  const where = placeOf(location.pathname);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const activeProject = projects.find((project) => project.id === projectId);
  // The Conversation tab returns to the conversation that was open before Tasks.
  const onTasks = location.pathname.endsWith('/tasks');
  useEffect(() => {
    if (!projectId || onTasks) return;
    try { sessionStorage.setItem(`flux.project-conversation.${projectId}`, location.pathname); } catch { /* private mode */ }
  }, [projectId, onTasks, location.pathname]);
  const projectViews = projectId ? [
    { id: 'conversation', label: 'Conversation', to: onTasks ? lastConversationPath(projectId) : location.pathname },
    { id: 'tasks', label: 'Tasks', to: `/projects/${projectId}/tasks` },
  ] : null;
  const dmId = location.pathname.match(/^\/dm\/([^/]+)/)?.[1];
  const activeDm = directMessages.find((dm) => dm.id === dmId);
  const place = activeProject
    ? { crumb: activeProject.workspaceName ?? null, title: activeProject.name, topic: 'Conversation, work and decisions', views: false }
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
        <header className="top">
          {navDrawer ? (
            <IconButton icon="menu" label="Open navigation" size={18} aria-expanded={navOpen} aria-controls={navOpen ? 'nav-drawer' : undefined}
              aria-haspopup="dialog" data-tip-align="start" onClick={() => { setDetailsOpen(false); setNavOpen(true); }} className="top__menu" />
          ) : null}
          <div className="top__title">
            {place.crumb ? <><span className="top__crumb">{place.crumb}</span><span className="top__slash" aria-hidden="true">/</span></> : null}
            <h1>{place.title}</h1>
            <span className="top__topic">{place.topic}</span>
          </div>
          <div className="top__right" data-shift>
            <Button ref={detailsButtonRef} variant="quiet" icon="panel" className="top__details" aria-expanded={detailsOpen}
              aria-controls={detailsOpen ? 'details' : undefined} aria-keyshortcuts="]" data-tip={'Toggle details   ]'}
              onClick={() => { setDetailsView('place'); toggleDetails(); }}>
              Details
            </Button>
          </div>
        </header>
        {place.views
          ? <Tabs className="views" label="Views" items={VIEWS.map((view) => ({ id: view.id, label: view.label, to: view.path }))} />
          : activeProject && projectViews
            ? <Tabs className="views" label="Project views" items={projectViews} />
            : <div className="views views--none" aria-hidden="true" />}
        <div className="app__pane" id="content" ref={paneRef} tabIndex={-1}>
          <Outlet />
        </div>
      </div>

      <SidePanel open={detailsOpen} onClose={() => toggleDetails(false)} title="Details" id="details">
        <Details view={detailsView} workspace={workspace} placeTitle={place.title} dm={activeDm ? { id: activeDm.id, kind: activeDm.kind, title: activeDm.title, me: me.user.name, people: activeDm.people, audience: activeDm.audience } : null} onBack={() => setDetailsView('place')} />
      </SidePanel>
    </div>
    </ShellContext.Provider>
  );
}
