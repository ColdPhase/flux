import { useLocation, useNavigate, useNavigation } from 'react-router';
import { Button, Spinner } from '../ui';
import { routeLabel } from './routeLabel';
import './route-progress.css';

/** Navigation waits for route code/data while the current Outlet and its draft stay mounted. */
export function RouteProgress() {
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  if (navigation.state !== 'loading' || !navigation.location || navigation.location.pathname === location.pathname) return null;
  return <div className="route-progress" data-route-pending={navigation.location.pathname}>
    <span role="status" aria-live="polite"><Spinner />Opening {routeLabel(navigation.location.pathname)}…</span>
    <Button variant="quiet" onClick={() => void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, defaultShouldRevalidate: false })}>Cancel</Button>
  </div>;
}
