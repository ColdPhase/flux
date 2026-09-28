import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { Avatar, Icon, IconButton } from '../ui';
import { useShellData, type DirectMessageSummary, type ProjectSummary, type WorkspaceSummary } from './data';
import { Rail, placeOf } from './Rail';
import { startCapture } from './views';
import { UserMenu } from './UserMenu';
import { ProjectThreads } from '../project/ProjectThreads';
import { audienceLine, useProjectShell } from '../project/data';

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
 * The dark rail (where you are) beside the light sidebar (what is inside that place). Home
 * holds private capture and the projects you belong to; Direct messages lists conversations
 * with people. A project never reveals another project.
 */
export function Sidebar({ workspace, projects, directMessages, user, session, onClose, titleId, inboxUnread = false }: SidebarProps) {
  const go = useNavigate();
  const location = useLocation();
  const place = placeOf(location.pathname);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const activeProject = projects.find((project) => project.id === projectId);
  const navigate = onClose ? () => onClose() : undefined;
  const shell = useProjectShell();
  const me = useShellData().me.user.id;
  const head = place === 'dm'
    ? { title: 'Direct messages', sub: 'Only the people in each conversation' }
    : place === 'inbox'
      ? { title: 'Inbox', sub: 'Only what involves you' }
    : activeProject
      ? { title: activeProject.name, sub: shell?.project.id === activeProject.id ? audienceLine(shell.people, me) : activeProject.workspaceName ?? 'Project conversation' }
      : { title: 'Home', sub: workspace ? `Yours · ${workspace.name}` : 'Only you see Home' };
  return (
    <div className="side-wrap">
      <Rail place={place} projects={projects} inboxUnread={inboxUnread} onNavigate={navigate} titleId={titleId} />
      <div className="side">
        <div className="side__ws">
          <span className="side__place"><b>{head.title}</b><span>{head.sub}</span></span>
          {onClose ? <IconButton icon="x" label="Close navigation" onClick={onClose} /> : null}
        </div>
        <nav className="side__nav" aria-label={head.title}>
          {place === 'inbox' ? (
            <div className="side__sec">
              <NavLink to="/inbox" end className="side__item" onClick={navigate}>
                <Icon name="inbox" className="side__ic" /><span className="side__label">Inbox</span>
                {inboxUnread ? <span className="ui-dot ui-dot--accent side__new"><span className="ui-vh">, something new</span></span> : null}
              </NavLink>
              <NavLink to="/settings/notifications" className="side__item" onClick={navigate}>
                <Icon name="bell" className="side__ic" /><span className="side__label">Notification settings</span>
              </NavLink>
            </div>
          ) : place === 'dm' ? (
            <>
              <div className="side__sec">
                <NavLink to="/dm/new" className="side__item side__capture" onClick={navigate}>
                  <Icon name="plus" className="side__ic" />New message
                </NavLink>
              </div>
              <section className="side__sec" aria-labelledby="side-dms">
                <h2 className="side__h" id="side-dms">Conversations</h2>
                {directMessages.length ? (
                  <ul className="side__list">
                    {directMessages.map((dm) => (
                      <li key={dm.id}>
                        <NavLink to={`/dm/${dm.id}`} className="side__item side__dm" onClick={navigate} title={`${dm.title} · ${dm.audience}`}>
                          <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} size="sm" /><span className="side__label">{dm.title}</span>
                          {dm.hasNew ? <span className="ui-dot ui-dot--accent side__new"><span className="ui-vh">, new messages</span></span> : null}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="side__empty">No conversations yet. Start one with anyone in your space; only the people in it can read it.</p>
                )}
              </section>
            </>
          ) : (
            <>
              <div className="side__sec">
                <button type="button" className="side__item side__capture" onClick={() => { onClose?.(); startCapture(go); }}>
                  <Icon name="plus" className="side__ic" />New thought<span className="side__hint"><Icon name="lock" size={12} />Private</span>
                </button>
              </div>
              {/* Inside a project the sidebar shows its conversations (#117); the rail lists the projects. */}
              {activeProject ? <ProjectThreads key={activeProject.id} projectId={activeProject.id} onNavigate={navigate} /> : (
              <section className="side__sec" aria-labelledby="side-projects">
                <h2 className="side__h" id="side-projects">Projects</h2>
                {projects.length ? (
                  <ul className="side__list">
                    {projects.map((project) => (
                      <li key={project.id}>
                        <NavLink to={`/projects/${project.id}`} className="side__item" onClick={navigate}>
                          <span className="side__hash" aria-hidden="true">#</span>{project.name}{project.workspaceName ? <span className="side__sub">{project.workspaceName}</span> : null}
                          {project.hasNew ? <span className="ui-dot ui-dot--accent side__new"><span className="ui-vh">, new activity</span></span> : null}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="side__empty">No projects yet. When someone adds you to one, it appears here and in the rail.</p>
                )}
                <Link to="/projects/new" className="side__item" onClick={navigate}><Icon name="plus" className="side__ic" />New project</Link>
              </section>
              )}
            </>
          )}
        </nav>
        <UserMenu name={user.name} email={user.email} sessionExpiresAt={session.expiresAt} />
      </div>
    </div>
  );
}
