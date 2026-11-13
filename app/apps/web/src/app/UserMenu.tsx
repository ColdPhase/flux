import { Link, useLocation } from 'react-router';
import { Avatar } from '../ui';

/**
 * Your face and name at the foot of the sidebar, and the one way into Settings (F-026 §4, founder decision #1419): the whole row is the link, as
 * your face is on the phone. There is no gear beside it and no menu behind it; Sign out is in Settings › Account. On the 64 px rail it is the face alone.
 */
export function UserMenu({ id, name, compact = false, onNavigate }: { id: string; name: string; compact?: boolean; onNavigate?: () => void }) {
  const path = useLocation().pathname;
  const current = path === '/settings' || path.startsWith('/settings/');
  return (
    <div className={`me${compact ? ' me--compact' : ''}`}>
      <Link to="/settings" className="me__btn" aria-label={`${name}, Settings`} aria-current={current ? 'page' : undefined} title={compact ? `${name}, Settings` : undefined} onClick={onNavigate}>
        <Avatar name={name} id={id} tone="me" size={compact ? 'lg' : 'sm'} />
        {compact ? null : <span className="me__text"><b>{name}</b></span>}
      </Link>
    </div>
  );
}
