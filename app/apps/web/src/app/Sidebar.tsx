import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useNavigation } from 'react-router';
import { Avatar, FluxLogo, Icon, IconButton, choosesInPlace, useTravelingHighlight } from '../ui';
import { type DirectMessageSummary, type ProjectSummary, type WorkspaceSummary } from './data';
import { placeOf } from './place';
import { startCapture } from './views';
import { UserMenu } from './UserMenu';
import { useShellActions } from './shellContext';
import { WorkingAgent } from './WorkingAgent';
import { NewMenu } from './NewMenu';

export interface SidebarProps {
  workspace: WorkspaceSummary | null;
  projects: ProjectSummary[];
  directMessages: DirectMessageSummary[];
  user: { name: string; email: string };
  session: { expiresAt: string };
  /** In the drawer: a close button and closing after navigation. */
  onClose?: () => void;
  /** How many Inbox items are unread; 0 shows no count. */
  inboxUnread?: number;
  titleId?: string;
  /** The computer's 64px rail (`[`, F-026 S19): icons only. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/** A project's letter tile, as the final design draws projects (F-026 §4). */
function ProjectTile({ name, size = 20 }: { name: string; size?: number }) {
  return <span className="side__pj" style={{ width: size, height: size }} aria-hidden="true">{(name.trim()[0] ?? '?').toUpperCase()}</span>;
}

/**
 * The sidebar (F-026 §4): the logo and the collapse control; New (C) and Search (⌘K); Home, Inbox
 * and Sketchbook; Projects, then Messages; the working agent with Stop; the account and Settings.
 * Collapsed, it is the 64px rail of icons. A project has one conversation (UI116-1): its roots and
 * threads live in its Conversation view, not in this list. A project never reveals another's contents.
 */
export function Sidebar({ projects, directMessages, user, session, onClose, titleId, inboxUnread = 0, collapsed = false, onToggleCollapsed }: SidebarProps) {
  const go = useNavigate();
  const { openSearch } = useShellActions();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const location = useLocation();
  const place = placeOf(location.pathname);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const navigate = onClose ? () => onClose() : undefined;
  const sketchbook = place === 'home' && /^\/map(\/|$)/.test(location.pathname);
  // Home is current where the header says Home: not in the Sketchbook, Search or personal settings.
  const home = place === 'home' && !sketchbook && !/^\/(search|settings|projects)(\/|$)/.test(location.pathname);
  const inbox = /^\/inbox(\/|$)/.test(location.pathname);
  // Subtle navigation feedback (#155, UI116-5): the highlight travels to a chosen project at once, while
  // the project loads; the row becomes current (aria-current) when its content shows. A newer choice
  // retargets it, and a navigation that ends elsewhere (refused, cancelled) returns it.
  const navigation = useNavigation();
  const pendingProject = navigation.state !== 'idle' ? navigation.location?.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null : null;
  const projectList = useRef<HTMLUListElement>(null);
  const glide = useRef<HTMLLIElement>(null);
  const glideTo = useTravelingHighlight(projectList, glide, ['.side__project[data-pending]', '.side__project.is-open']);
  const searchKeys = mac ? 'Meta+K' : 'Control+K';
  const [newOpen, setNewOpen] = useState(false);
  useEffect(() => {
    // "C" opens New from anywhere outside a field or dialog (F-026 §4 keyboard); the drawer has its own.
    if (onClose) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'c' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      setNewOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const newProject = () => { onClose?.(); void go('/projects/new'); };
  const newNote = () => { onClose?.(); startCapture(go); };
  const newTask = projectId ? () => { onClose?.(); void go(`/projects/${projectId}/tasks?new=task`); } : null;
  const newMessage = () => { onClose?.(); void go('/dm/new'); };

  if (collapsed && !onClose) {
    return (
      <div className="side side--rail">
        <span className="side__glyph" role="img" aria-label="Flux" id={titleId}><FluxLogo size={28} /></span>
        <NewMenu compact open={newOpen} onOpenChange={setNewOpen} onTask={newTask} onProject={newProject} onNote={newNote} onMessage={newMessage} />
        <nav className="side__rail-places" aria-label="Places">
          <Link to="/" className="side__ib" aria-label="Home" aria-current={home ? 'page' : undefined}><Icon name="home" size={18} /></Link>
          <Link to="/inbox" className="side__ib" aria-label={inboxUnread ? `Inbox, ${inboxUnread} new` : 'Inbox'} aria-current={inbox ? 'page' : undefined}>
            <Icon name="inbox" size={18} />{inboxUnread ? <span className="side__count side__count--rail" aria-hidden="true">{inboxUnread}</span> : null}
          </Link>
          <button type="button" className="side__ib" aria-label="Search" aria-keyshortcuts={searchKeys} onClick={openSearch}><Icon name="search" size={18} /></button>
        </nav>
        <nav className="side__rail-projects" aria-label="Projects">
          {projects.map((project) => (
            <NavLink key={project.id} to={`/projects/${project.id}`} end={false} className={`side__rail-project${project.id === projectId ? ' is-open' : ''}`} aria-label={project.name} title={project.name}>
              <ProjectTile name={project.name} size={28} />
            </NavLink>
          ))}
        </nav>
        <span className="side__spacer" />
        <WorkingAgent compact />
        <IconButton icon="sidebar" label="Expand sidebar" aria-keyshortcuts="[" className="side__toggle" onClick={onToggleCollapsed} />
      </div>
    );
  }

  return (
    <div className="side">
      <div className="side__brand">
        {/* The wordmark names the drawer; Home is the first place below, so the mark is not a second link. */}
        <span className="side__logo">
          <span className="side__glyph" role="img" aria-label="Flux" id={titleId}><FluxLogo size={24} /></span>
          <span className="side__word" aria-hidden="true">flux</span>
        </span>
        {onClose ? <IconButton icon="x" label="Close navigation" onClick={onClose} />
          : <IconButton icon="sidebar" label="Collapse sidebar" aria-keyshortcuts="[" className="side__toggle" onClick={onToggleCollapsed} />}
      </div>
      <div className="side__actions">
        <NewMenu open={newOpen} onOpenChange={setNewOpen} onTask={newTask} onProject={newProject} onNote={newNote} onMessage={newMessage} />
        <button type="button" className="side__search" aria-label="Search" aria-keyshortcuts={searchKeys} title={mac ? 'Search (⌘K)' : 'Search (Ctrl K)'} onClick={() => { onClose?.(); openSearch(); }}>
          <Icon name="search" size={16} />
        </button>
      </div>
      <div className="side__scroll">
        <nav className="side__places" aria-label="Places">
          {/* Plain links with an explicit current place: NavLink would also mark a parent path current. */}
          <Link to="/" className="side__item" aria-current={home ? 'page' : undefined} onClick={navigate}>
            <Icon name="home" className="side__ic" /><span className="side__label">Home</span>
          </Link>
          <Link to="/inbox" className="side__item" aria-label={inboxUnread ? `Inbox, ${inboxUnread} new` : 'Inbox'} aria-current={inbox ? 'page' : undefined} onClick={navigate}>
            <Icon name="inbox" className="side__ic" /><span className="side__label">Inbox</span>
            {inboxUnread ? <span className="side__count" aria-hidden="true">{inboxUnread}</span> : null}
          </Link>
          {place === 'inbox' ? (
            <div className="side__threads">
              <NavLink to="/settings/notifications" className="side__item" onClick={navigate}>
                <Icon name="bell" className="side__ic" /><span className="side__label">Notification settings</span>
              </NavLink>
            </div>
          ) : null}
          <Link to="/map" className="side__item" aria-current={sketchbook ? 'page' : undefined} onClick={navigate} title="Only you can see your sketchbook">
            <Icon name="edit" className="side__ic" /><span className="side__label">Sketchbook</span>
          </Link>
        </nav>

        <nav className="side__sec" aria-labelledby="side-projects">
          <div className="side__head">
            <h2 className="side__h" id="side-projects">Projects</h2>
            {/* On the computer New (C) creates; the phone's drawer keeps its own "+" until #341. */}
            {onClose ? <Link to="/projects/new" className="side__add" aria-label="New project" onClick={navigate}><Icon name="plus" size={14} /></Link> : null}
          </div>
          {projects.length ? (
            <ul className="side__list" ref={projectList}>
              <li className="side__glide" ref={glide} aria-hidden="true" role="none" />
              {projects.map((project) => {
                const open = project.id === projectId;
                return (
                  <li key={project.id}>
                    <NavLink to={`/projects/${project.id}`} end={false} className={`side__item side__project${open ? ' is-open' : ''}`} onClick={(event) => { if (choosesInPlace(event)) glideTo(event.currentTarget); navigate?.(); }}
                      data-glide-id={project.id} data-pending={pendingProject === project.id && !open ? '' : undefined}
                      title={project.workspaceName ? `${project.name} · ${project.workspaceName}` : project.name}
                      aria-label={project.hasNew ? `${project.name}, new activity` : undefined}>
                      <ProjectTile name={project.name} />
                      {project.workspaceName ? (
                        <span className="side__names">
                          <span className="side__label">{project.name}</span>
                          <span className="side__sub">{project.workspaceName}</span>
                        </span>
                      ) : <span className="side__label">{project.name}</span>}
                      {project.hasNew ? <span className="side__dot" aria-hidden="true" /> : null}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="side__empty">No projects yet. <Link to="/projects/new" onClick={navigate}>Create a project</Link>, or it appears here when someone adds you to one.</p>
          )}
        </nav>

        <nav className="side__sec" aria-labelledby="side-dms">
          <div className="side__head">
            <h2 className="side__h" id="side-dms"><Link to="/dm" className="side__h-link" aria-current={location.pathname === '/dm' ? 'page' : undefined} onClick={navigate}>Messages</Link></h2>
            {onClose ? <Link to="/dm/new" className="side__add" aria-label="New message" onClick={navigate}><Icon name="plus" size={14} /></Link> : null}
          </div>
          {directMessages.length ? (
            <ul className="side__list">
              {directMessages.map((dm) => (
                <li key={dm.id}>
                  <NavLink to={`/dm/${dm.id}`} end={false} className="side__item side__dm" onClick={navigate} title={`${dm.title} · ${dm.audience}`}>
                    <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} size="sm" /><span className="side__label">{dm.title}</span>
                    {dm.hasNew ? <span className="side__dot"><span className="ui-vh">, new messages</span></span> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="side__empty">No conversations yet. Only the people in each one can read it.</p>
          )}
        </nav>
      </div>
      <WorkingAgent />
      <UserMenu name={user.name} email={user.email} sessionExpiresAt={session.expiresAt} asLink={!!onClose} onNavigate={onClose} />
    </div>
  );
}
