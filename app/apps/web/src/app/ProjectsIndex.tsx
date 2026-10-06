import { Link } from 'react-router';
import { Icon } from '../ui';
import { useShellData } from './data';
import './settings.css';

/**
 * Projects (#266 PF-1): the list the phone's Projects place opens, like a messenger's list of chats.
 * Each row opens the project on its conversation; a dot says something is new there.
 */
export function ProjectsIndex() {
  const { projects } = useShellData();
  return (
    <div className="pane-scroll">
      <div className="pane-in set" data-shift>
        <div className="proj-index__head">
          <p className="proj-index__lead">Each project has one conversation, a map, tasks, a wiki and its agents.</p>
          <Link to="/projects/new" className="ui-btn ui-btn--secondary"><Icon name="plus" />New project</Link>
        </div>
        {projects.length ? (
          <ul className="set-card" aria-label="Projects">
            {projects.map((project) => (
              <li key={project.id}>
                <Link to={`/projects/${project.id}`} className="set-row" aria-label={project.hasNew ? `${project.name}, new activity` : undefined}>
                  <span className="set-row__ic" aria-hidden="true"><Icon name="spark" size={16} /></span>
                  <span className="set-row__b">
                    <span className="set-row__t">{project.name}</span>
                    {project.workspaceName ? <span className="set-row__s">{project.workspaceName}</span> : null}
                  </span>
                  {project.hasNew ? <span className="proj-index__dot" aria-hidden="true" /> : null}
                  <Icon name="chevron-right" size={14} className="set-row__go" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="proj-index__empty">
            <p>No projects yet. Create one, or it appears here when someone adds you to theirs.</p>
            <Link to="/projects/new" className="ui-btn ui-btn--primary"><Icon name="plus" />Create a project</Link>
          </div>
        )}
      </div>
    </div>
  );
}
