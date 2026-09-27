import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { Avatar, Icon, IconButton } from '../ui';
import type { DirectMessageSummary, ProjectSummary, WorkspaceSummary } from './data';
import { startCapture } from './views';
import { UserMenu } from './UserMenu';

export interface SidebarProps {
  workspace: WorkspaceSummary | null;
  projects: ProjectSummary[];
  directMessages: DirectMessageSummary[];
  user: { name: string; email: string };
  /** In the drawer: a close button and closing after navigation. */
  onClose?: () => void;
  titleId?: string;
}

export function Sidebar({ workspace, projects, directMessages, user, onClose, titleId }: SidebarProps) {
  const name = workspace?.name ?? 'Flux';
  const navigate = onClose ? () => onClose() : undefined;
  const go = useNavigate();
  // Every view outside a project or direct message belongs to Home.
  const pathname = useLocation().pathname;
  const home = !pathname.startsWith('/projects/') && !pathname.startsWith('/dm/');
  return (
    <div className="side">
      <div className="side__ws">
        <span className="side__mark" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
        <span className="side__name" id={titleId}>{name}</span>
        {onClose ? <IconButton icon="x" label="Close navigation" onClick={onClose} /> : null}
      </div>
      <nav className="side__nav" aria-label="Workspace">
        <div className="side__sec">
          <Link to="/" className="side__item" aria-current={home ? 'page' : undefined} onClick={navigate}>
            <Icon name="inbox" className="side__ic" />Home
          </Link>
          <button type="button" className="side__item side__capture" onClick={() => { onClose?.(); startCapture(go); }}>
            <Icon name="plus" className="side__ic" />New thought<span className="side__hint">only you</span>
          </button>
        </div>
        <section className="side__sec" aria-labelledby="side-projects">
          <h2 className="side__h" id="side-projects">Projects</h2>
          {projects.length ? (
            <ul className="side__list">
              {projects.map((project) => (
                <li key={project.id}>
                  <NavLink to={`/projects/${project.id}`} className="side__item" onClick={navigate}>
                    <span className="side__hash" aria-hidden="true">#</span>{project.name}
                    {project.hasNew ? <span className="ui-dot ui-dot--accent side__new"><span className="ui-vh">, new activity</span></span> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="side__empty">No projects yet</p>
          )}
        </section>
        <section className="side__sec" aria-labelledby="side-dms">
          <h2 className="side__h" id="side-dms">Direct messages</h2>
          {directMessages.length ? (
            <ul className="side__list">
              {directMessages.map((dm) => (
                <li key={dm.id}>
                  <NavLink to={`/dm/${dm.id}`} className="side__item" onClick={navigate}>
                    <Avatar name={dm.people[0] ?? dm.title} size="sm" />{dm.title}
                    {dm.hasNew ? <span className="ui-dot ui-dot--accent side__new"><span className="ui-vh">, new messages</span></span> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="side__empty">No messages yet</p>
          )}
        </section>
      </nav>
      <UserMenu name={user.name} email={user.email} />
    </div>
  );
}
