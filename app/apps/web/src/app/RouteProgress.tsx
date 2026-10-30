import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useNavigation } from 'react-router';
import { Button, Spinner } from '../ui';
import { routeLabel } from './routeLabel';
import './route-progress.css';

/** A navigation that is quick (its code already here, or arriving at once) never shows the row; one that is still waiting after this does. */
export const ROUTE_PROGRESS_AFTER_MS = 200;
/** Once the row is shown it stays this long, so a navigation that ends just after it appeared does not leave a blink. */
export const ROUTE_PROGRESS_AT_LEAST_MS = 300;

/**
 * Navigation waits for route code/data while the current Outlet and its draft stay mounted. The row that says so floats over the
 * work and appears only when the wait is long enough to need saying (#719): a switch of view that finishes within a few frames
 * shows nothing, instead of a row that flashes in and out over the old view just before it dissolves.
 */
export function RouteProgress() {
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const target = navigation.state === 'loading' && navigation.location && navigation.location.pathname !== location.pathname ? navigation.location.pathname : null;
  // What the row is showing: where the navigation goes, and when the row came up.
  const [shown, setShown] = useState<{ path: string; since: number } | null>(null);
  useEffect(() => {
    if (target) {
      // Still waiting: the row comes up once the wait has lasted long enough (a newer destination keeps it up, below).
      if (shown) return undefined;
      const timer = window.setTimeout(() => setShown({ path: target, since: performance.now() }), ROUTE_PROGRESS_AFTER_MS);
      return () => window.clearTimeout(timer);
    }
    if (!shown) return undefined;
    const timer = window.setTimeout(() => setShown(null), Math.max(0, ROUTE_PROGRESS_AT_LEAST_MS - (performance.now() - shown.since)));
    return () => window.clearTimeout(timer);
  }, [target, shown]);
  if (shown && target && shown.path !== target) setShown({ path: target, since: shown.since });
  if (!shown) return null;
  // After the navigation has ended the row only waits out its minimum: there is nothing left to cancel.
  return <div className="route-progress" data-route-pending={shown.path}>
    <span role="status" aria-live="polite"><Spinner />Opening {routeLabel(shown.path)}…</span>
    <Button variant="quiet" disabled={!target} onClick={() => { setShown(null); void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, defaultShouldRevalidate: false, state: location.state }); }}>Cancel</Button>
  </div>;
}
