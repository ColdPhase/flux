import { useRef, type ReactNode } from 'react';
import { Link, useLocation, type NavigateFunction } from 'react-router';
import { EmptyState } from '../ui';
import { useShellData } from './data';
import { useReadingPosition } from './drafts';

/** Home's views: the overview first, then the Map, Tasks and the Wiki. */
export const VIEWS = [
  { id: 'conversation', label: 'Overview', path: '/' },
  { id: 'map', label: 'Map', path: '/map' },
  { id: 'tasks', label: 'Tasks', path: '/tasks' },
  { id: 'docs', label: 'Wiki', path: '/docs' },
] as const;

export function viewIndex(pathname: string): number {
  const index = VIEWS.findIndex((view) => view.path !== '/' && pathname.startsWith(view.path));
  return index < 0 ? 0 : index;
}

/** A view's scroll area. Its reading position is kept per account and view across switches and reloads. */
function Pane({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { me } = useShellData();
  useReadingPosition(ref, me.user.id, useLocation().pathname);
  return (
    <div className="pane-scroll" ref={ref}>
      <div className="pane-in" data-shift>{children}</div>
    </div>
  );
}

/** Focus the notes composer in the Sketchbook, e.g. from "New > Private note". */
export function startCapture(navigate: NavigateFunction) {
  const composer = document.getElementById('composer');
  if (composer && window.location.pathname === '/map') { composer.focus(); return; }
  navigate('/map', { state: { capture: Date.now() } });
}

export function NotFoundView() {
  return (
    <Pane>
      <div className="view-empty">
        <EmptyState icon="search" title="This page doesn’t exist" action={<Link className="ui-btn ui-btn--secondary" to="/">Go to Home</Link>}>
          <p>The address may be mistyped, or what it pointed to was moved.</p>
        </EmptyState>
      </div>
    </Pane>
  );
}
