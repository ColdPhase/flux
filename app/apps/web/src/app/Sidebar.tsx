import { useRef } from 'react';
import { Link, NavLink, useLocation, useNavigate, useNavigation } from 'react-router';
import { Avatar, FluxMark, Icon, IconButton, choosesInPlace, useTravelingHighlight } from '../ui';
import { type DirectMessageSummary, type ProjectSummary, type WorkspaceSummary } from './data';
import { placeOf } from './place';
import { startCapture } from './views';
import { UserMenu } from './UserMenu';
import { useShellActions } from './shellContext';

export interface SidebarProps {
  workspace: WorkspaceSummary | null;
  projects: ProjectSummary[];
  directMessages: DirectMessageSummary[];
  user: { name: string; email: string };
  session: { expiresAt: string };
  /** In the drawer: a close button and closing after navigation. */
  onClose?: () => void;
  inboxUnread?: boolean;
  titleId?: string;
}

/**
 * The sidebar: one list on the outer background beside the panel. Places (Home, Inbox,
 * Direct messages and the private sketchbook), then Projects and Messages. A project has one
 * conversation (UI116-1): its roots and their threads live in the project's Conversation tab, not
 * in this list. A project never reveals another project's contents.
 */
export function Sidebar({ projects, directMessages, user, session, onClose, titleId, inboxUnread = false }: SidebarProps) {
  const go = useNavigate();
  const { openSearch } = useShellActions();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const location = useLocation();
  const place = placeOf(location.pathname);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const navigate = onClose ? () => onClose() : undefined;
  const sketchbook = place === 'home' && /^\/map(\/|$)/.test(location.pathname);
  // Home is current where the header says Home: not in My sketchbook, Search or personal settings.
  const home = place === 'home' && !sketchbook && !/^\/(search|settings|projects)(\/|$)/.test(location.pathname);
  // Subtle navigation feedback (#155, UI116-5): the highlight travels to a chosen project at once, while
  // the project loads; the row becomes current (its bar, aria-current) when its content shows. A newer
  // choice retargets it, and a navigation that ends elsewhere (refused, cancelled) returns it.
  const navigation = useNavigation();
  const pendingProject = navigation.state !== 'idle' ? navigation.location?.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null : null;
  const projectList = useRef<HTMLUListElement>(null);
  const glide = useRef<HTMLLIElement>(null);
  const glideTo = useTravelingHighlight(projectList, glide, ['.side__project[data-pending]', '.side__project.is-open']);
  return (
    <div className="side">
      <div className="side__brand">
        {/* The wordmark names the drawer; Home is the first place below, so the mark is not a second link. */}
        <span className="side__logo">
          <span className="side__glyph" role="img" aria-label="Flux" id={titleId}><FluxMark size={21} /></span>
          <span className="side__word" aria-hidden="true">flux<span>.</span></span>
        </span>
        {onClose ? <IconButton icon="x" label="Close navigation" onClick={onClose} /> : null}
      </div>
      <button type="button" className="side__jump" aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'} onClick={() => { onClose?.(); openSearch(); }}>
        <Icon name="search" size={15} />Jump to…<kbd aria-hidden="true">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <div className="side__scroll">
        <nav className="side__places" aria-label="Places">
          {/* Plain links with an explicit current place: NavLink would also mark a parent path current. */}
          <Link to="/" className="side__item" aria-current={home ? 'page' : undefined} onClick={navigate}>
            <Icon name="home" className="side__ic" /><span className="side__label">Home</span>
          </Link>
          <Link to="/inbox" className="side__item" aria-label={inboxUnread ? 'Inbox, something new' : 'Inbox'} aria-current={/^\/inbox(\/|$)/.test(location.pathname) ? 'page' : undefined} onClick={navigate}>
            <Icon name="inbox" className="side__ic" /><span className="side__label">Inbox</span>
            {inboxUnread ? <span className="side__dot" aria-hidden="true" /> : null}
          </Link>
          {place === 'inbox' ? (
            <div className="side__threads">
              <NavLink to="/settings/notifications" className="side__item" onClick={navigate}>
                <Icon name="bell" className="side__ic" /><span className="side__label">Notification settings</span>
              </NavLink>
            </div>
          ) : null}
          <Link to="/dm" className="side__item" aria-current={location.pathname === '/dm' ? 'page' : undefined} onClick={navigate}>
            <Icon name="chat" className="side__ic" /><span className="side__label">Direct messages</span>
          </Link>
          <Link to="/map" className="side__item" aria-current={sketchbook ? 'page' : undefined} onClick={navigate}>
            <Icon name="map" className="side__ic" /><span className="side__label">My sketchbook</span>
            <Icon name="lock" size={12} className="side__trail" />
          </Link>
        </nav>
        <button type="button" className="side__item side__capture" onClick={() => { onClose?.(); startCapture(go); }}>
          <Icon name="plus" className="side__ic" />New note<span className="side__hint"><Icon name="lock" size={12} />Private</span>
        </button>

        <nav className="side__sec" aria-labelledby="side-projects">
          <div className="side__head">
            <h2 className="side__h" id="side-projects">Projects</h2>
            <Link to="/projects/new" className="side__add" aria-label="New project" onClick={navigate}><Icon name="plus" size={14} /></Link>
          </div>
          {projects.length ? (
            <ul className="side__list" ref={projectList}>
              <li className="side__glide" ref={glide} aria-hidden="true" role="none" />
              {projects.map((project) => {
                const open = project.id === projectId;
                return (
                  <li key={project.id}>
                    <NavLink to={`/projects/${project.id}`} end={false} className={`side__item side__project${open ? ' is-open' : ''}`} onClick={(event) => { if (choosesInPlace(event)) glideTo(event.currentTarget); navigate?.(); }} data-glide-id={project.id} data-pending={pendingProject === project.id && !open ? '' : undefined}
                      title={project.workspaceName ? `${project.name} · ${project.workspaceName}` : project.name}
                      aria-label={project.hasNew ? `${project.name}, new activity` : undefined}>
                      <span className="side__pi" aria-hidden="true"><Icon name="spark" size={15} /></span>
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
            <h2 className="side__h" id="side-dms">Messages</h2>
            <Link to="/dm/new" className="side__add" aria-label="New message" onClick={navigate}><Icon name="plus" size={14} /></Link>
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
      <UserMenu name={user.name} email={user.email} sessionExpiresAt={session.expiresAt} asLink={!!onClose} onNavigate={onClose} />
    </div>
  );
}
