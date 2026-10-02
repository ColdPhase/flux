import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { Avatar, FluxMark, Icon, IconButton } from '../ui';
import { type DirectMessageSummary, type ProjectSummary, type WorkspaceSummary } from './data';
import { placeOf } from './place';
import { startCapture } from './views';
import { UserMenu } from './UserMenu';
import { ProjectThreads } from '../project/ProjectThreads';
import { useProjectShell } from '../project/data';
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
 * Studio 11.6 sidebar (#136): one list on the chrome beside the sheet. Places (Home, Inbox,
 * Direct messages and the private sketchbook), then Projects and Messages. The open project
 * lists its conversations under its own row, so no thread is lost when the rail is gone.
 * A project never reveals another project's contents.
 */
export function Sidebar({ projects, directMessages, user, session, onClose, titleId, inboxUnread = false }: SidebarProps) {
  const go = useNavigate();
  const { openSearch } = useShellActions();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const location = useLocation();
  const place = placeOf(location.pathname);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const navigate = onClose ? () => onClose() : undefined;
  const shell = useProjectShell();
  const sketchbook = place === 'home' && /^\/map(\/|$)/.test(location.pathname);
  return (
    <div className="side">
      <div className="side__brand">
        <Link to="/" className="side__logo" onClick={navigate} aria-label="Flux, Home">
          <span className="side__mark" role="img" aria-label="Flux" id={titleId}><FluxMark size={21} /></span>
          <span className="side__word" aria-hidden="true">flux<span>.</span></span>
        </Link>
        {onClose ? <IconButton icon="x" label="Close navigation" onClick={onClose} /> : null}
      </div>
      <button type="button" className="side__jump" aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'} onClick={() => { onClose?.(); openSearch(); }}>
        <Icon name="search" size={15} />Jump to…<kbd aria-hidden="true">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <div className="side__scroll">
        <nav className="side__places" aria-label="Places">
          <NavLink to="/" className="side__item" aria-current={place === 'home' && !sketchbook ? 'page' : undefined} onClick={navigate}>
            <Icon name="home" className="side__ic" /><span className="side__label">Home</span>
          </NavLink>
          <NavLink to="/inbox" className="side__item" aria-label={inboxUnread ? 'Inbox, something new' : 'Inbox'} aria-current={place === 'inbox' ? 'page' : undefined} onClick={navigate}>
            <Icon name="inbox" className="side__ic" /><span className="side__label">Inbox</span>
            {inboxUnread ? <span className="side__dot" aria-hidden="true" /> : null}
          </NavLink>
          <NavLink to="/dm" className="side__item" aria-current={location.pathname === '/dm' ? 'page' : undefined} onClick={navigate}>
            <Icon name="chat" className="side__ic" /><span className="side__label">Direct messages</span>
          </NavLink>
          <NavLink to="/map" className="side__item" aria-current={sketchbook ? 'page' : undefined} onClick={navigate}>
            <Icon name="map" className="side__ic" /><span className="side__label">My sketchbook</span>
            <Icon name="lock" size={12} className="side__trail" />
          </NavLink>
        </nav>
        <button type="button" className="side__item side__capture" onClick={() => { onClose?.(); startCapture(go); }}>
          <Icon name="plus" className="side__ic" />New thought<span className="side__hint"><Icon name="lock" size={12} />Private</span>
        </button>

        <section className="side__sec" aria-labelledby="side-projects">
          <div className="side__head">
            <h2 className="side__h" id="side-projects">Projects</h2>
            <Link to="/projects/new" className="side__add" aria-label="New project" onClick={navigate}><Icon name="plus" size={14} /></Link>
          </div>
          {projects.length ? (
            <ul className="side__list">
              {projects.map((project) => {
                const open = project.id === projectId;
                return (
                  <li key={project.id}>
                    <NavLink to={`/projects/${project.id}`} end={false} className={`side__item side__project${open ? ' is-open' : ''}`} onClick={navigate}
                      aria-label={project.hasNew ? `${project.name}, new activity` : undefined}>
                      <span className="side__pi" aria-hidden="true"><Icon name="spark" size={15} /></span>
                      <span className="side__label">{project.name}</span>
                      {project.workspaceName ? <span className="side__sub">{project.workspaceName}</span> : null}
                      {project.hasNew ? <span className="side__dot" aria-hidden="true" /> : null}
                    </NavLink>
                    {open ? <ProjectThreads key={project.id} projectId={project.id} canStart={shell?.project.id === project.id && shell?.project.access !== 'viewer'} onNavigate={navigate} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="side__empty">No projects yet. When someone adds you to one, it appears here.</p>
          )}
        </section>

        <section className="side__sec" aria-labelledby="side-dms">
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
        </section>
      </div>
      <UserMenu name={user.name} email={user.email} sessionExpiresAt={session.expiresAt} />
    </div>
  );
}
