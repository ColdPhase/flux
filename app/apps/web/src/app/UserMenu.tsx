import { Link, useLocation } from 'react-router';
import { Avatar, IconButton } from '../ui';
import { setTheme, useResolvedTheme } from './theme';

/**
 * The person at the foot of the sidebar (#272 FF-4): the row opens the Settings page on every size,
 * where the account, this device, notifications, AI and sign out live. A light/dark switch sits
 * beside it, as in Studio 11.6, so the most common change is one tap away.
 */
export function UserMenu({ name, email, onNavigate }: { name: string; email: string; onNavigate?: () => void }) {
  const current = useLocation().pathname === '/settings';
  const theme = useResolvedTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <div className="me">
      <Link to="/settings" className="me__btn" aria-current={current ? 'page' : undefined} onClick={onNavigate}>
        <Avatar name={name} tone="me" />
        {/* Words, not a lone gear, say where this goes (#272 FF-1); the address shows on the page. */}
        <span className="me__text" title={email}><b>{name}</b><span>Settings and sign out</span></span>
      </Link>
      <IconButton icon={next === 'dark' ? 'moon' : 'sun'} label={next === 'dark' ? 'Switch to dark' : 'Switch to light'} className="me__theme"
        data-tip-align="end" onClick={() => setTheme(next)} />
    </div>
  );
}
