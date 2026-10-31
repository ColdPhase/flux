import { useMemo } from 'react';
import { Link } from 'react-router';
import { useProjectNews } from './projectNews';
import { Avatar, Icon, MEDIA, useMediaQuery } from '../ui';
import { useShellData } from './data';
import './settings.css';

/**
 * Projects (#266 PF-1): the list the phone's Projects place opens, like a messenger's list of chats.
 * On the phone it also holds the direct messages (#341).
 * Each row opens the project on its conversation; a dot says something is new there.
 */
export function ProjectsIndex() {
  const { projects, directMessages, lockedWorkspaces } = useShellData();
  const news = useProjectNews(useMemo(() => projects.map((project) => project.id), [projects]));
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <div className="pane-scroll">
      <div className="pane-in set" data-shift>
        <div className="proj-index__head">
          <p className="proj-index__lead">Each project has one conversation, a map, tasks, a wiki and its agents.</p>
          <Link to="/projects/new" className="ui-btn ui-btn--secondary"><Icon name="plus" />New project</Link>
        </div>
        {projects.length || lockedWorkspaces.length ? (
          <ul className="set-card" aria-label="Projects">
            {projects.map((project) => (
              <li key={project.id}>
                <Link to={`/projects/${project.id}`} className="set-row" aria-label={news.has(project.id) ? `${project.name}, new activity` : undefined}>
                  {/* The same letter tile as the sidebar and Home (#763 NV-6); a sparkle would read as AI. */}
                  <span className="set-row__ic proj-index__tile" aria-hidden="true">{(project.name.trim()[0] ?? '?').toUpperCase()}</span>
                  <span className="set-row__b">
                    <span className="set-row__t">{project.name}</span>
                    {project.workspaceName ? <span className="set-row__s">{project.workspaceName}</span> : null}
                  </span>
                  {news.has(project.id) ? <span className="proj-index__dot" aria-hidden="true" /> : null}
                  <Icon name="chevron-right" size={14} className="set-row__go" />
                </Link>
              </li>
            ))}
            {/* An encrypted space that waits to be unlocked is one row in place of its projects (F-030, #655). */}
            {lockedWorkspaces.map((space) => (
              <li key={space.id}>
                <Link to={`/spaces/${space.id}`} className="set-row" data-locked-space={space.id}>
                  <span className="set-row__ic" aria-hidden="true"><Icon name="lock" size={16} /></span>
                  <span className="set-row__b">
                    <span className="set-row__t">{space.name}</span>
                    <span className="set-row__s">Waiting to be unlocked</span>
                  </span>
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
        {/* Direct messages live in Projects on the phone, below the projects (F-026 S2). */}
        {phone ? (
          <section className="proj-index__dms" aria-labelledby="proj-index-dms">
            <h2 id="proj-index-dms">Direct messages</h2>
            {/* The same card and grid as the projects, with a fixed time column, so a long preview never pushes the date out (#763 NV-5). */}
            {directMessages.length ? (
              <ul className="set-card proj-index__dmlist" aria-label="Conversations">
                {directMessages.map((dm) => (
                  <li key={dm.id}>
                    <Link to={`/dm/${dm.id}`} className="set-row">
                      <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} size="lg" />
                      <span className="set-row__b">
                        <span className="set-row__t proj-index__one">{dm.title}</span>
                        <span className="set-row__s proj-index__one">{dm.preview ?? 'No messages yet'}</span>
                      </span>
                      {dm.lastAt ? <time className="proj-index__time" dateTime={dm.lastAt}>{new Date(dm.lastAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="proj-index__lead">No conversations yet. Only the people in each one can read it.</p>}
            <Link to="/dm/new" className="ui-btn ui-btn--secondary"><Icon name="plus" />New message</Link>
          </section>
        ) : null}
      </div>
    </div>
  );
}
