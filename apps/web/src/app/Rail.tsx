import { Link, NavLink } from 'react-router';
import { FluxMark, Icon } from '../ui';
import type { ProjectSummary } from './data';

export type Place = 'home' | 'dm' | 'project';

export function placeOf(pathname: string): Place {
  if (pathname === '/dm' || pathname.startsWith('/dm/')) return 'dm';
  if (pathname.startsWith('/projects/')) return 'project';
  return 'home';
}

/**
 * Flux's identity element (founder decision on #40: variant C's "rail" option). A 60px dark
 * rail holds the Flux mark, Home, Direct messages and one monogram per project the person
 * belongs to, with a lime marker beside the current place. On narrow screens it travels
 * inside the navigation drawer. There is no "New project" button until projects can be made.
 */
export function Rail({ place, projects, onNavigate, titleId }: {
  place: Place;
  projects: ProjectSummary[];
  onNavigate?: () => void;
  /** Names the drawer after the mark ("Flux"). */
  titleId?: string;
}) {
  return (
    <nav className="rail" aria-label="Places">
      <span className="rail__mark" role="img" aria-label="Flux" id={titleId}><FluxMark size={22} /></span>
      <Link to="/" className="rail__btn" aria-label="Home" data-tip="Home" aria-current={place === 'home' ? 'page' : undefined} onClick={onNavigate}>
        <Icon name="home" size={18} />
      </Link>
      <Link to="/dm" className="rail__btn" aria-label="Direct messages" data-tip="Direct messages" aria-current={place === 'dm' ? 'page' : undefined} onClick={onNavigate}>
        <Icon name="chat" size={18} />
      </Link>
      {projects.length ? (
        <>
          <span className="rail__sep" aria-hidden="true" />
          {projects.map((project, index) => (
            <NavLink key={project.id} to={`/projects/${project.id}`} className="rail__btn" aria-label={project.hasNew ? `${project.name}, new activity` : project.name}
              data-tip={project.name} onClick={onNavigate}>
              <span className={`rail__pm rail__pm--${(index % 4) + 1}`} aria-hidden="true">{project.name.trim().charAt(0).toUpperCase() || '#'}</span>
              {project.hasNew ? <span className="rail__dot" aria-hidden="true" /> : null}
            </NavLink>
          ))}
        </>
      ) : null}
    </nav>
  );
}
