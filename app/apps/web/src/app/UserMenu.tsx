import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Form, Link, useLocation, useNavigation } from 'react-router';
import { Avatar, Icon, Spinner, trapTab, usePop } from '../ui';
import { NotificationsButton } from '../pwa';
import { AppearanceControls } from './AppearanceControls';

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function until(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

/**
 * Account button at the foot of the sidebar; opens a small popover with this device's session,
 * its notifications (#41), the theme and sign out.
 */
export function UserMenu({ name, email, sessionExpiresAt, asLink = false, compact = false, onNavigate }: { name: string; email: string; sessionExpiresAt: string; asLink?: boolean; compact?: boolean; onNavigate?: () => void }) {
  // In the phone drawer the account row is a plain way into Settings (#266 PF-5), not a popover
  // squeezed over the drawer's own list.
  if (asLink) return <AccountLink name={name} email={email} onNavigate={onNavigate} />;
  return <AccountMenu name={name} email={email} sessionExpiresAt={sessionExpiresAt} compact={compact} />;
}

function AccountLink({ name, email, onNavigate }: { name: string; email: string; onNavigate?: () => void }) {
  const current = useLocation().pathname === '/settings';
  return (
    <div className="me">
      <Link to="/settings" className="me__btn" aria-current={current ? 'page' : undefined} onClick={onNavigate}>
        <Avatar name={name} tone="me" />
        <span className="me__text"><b>{name}</b><span>{email}</span></span>
        <Icon name="gear" className="me__chev" />
        <span className="ui-vh">, settings and sign out</span>
      </Link>
    </div>
  );
}

function AccountMenu({ name, email, sessionExpiresAt, compact }: { name: string; email: string; sessionExpiresAt: string; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const pop = usePop(open, { from: 'above' });
  // Following one of its links leaves the menu at once: it does not fade over the page it led to (#752). Esc, a click
  // outside and the account button still close it with its exit motion (#593).
  const [left, setLeft] = useState(false);
  const follow = () => { setLeft(true); close(false); };
  // Signing out is a navigation of its own, not a fetcher: it replaces whatever this tab is still
  // loading. A fetcher's redirect would leave that load running, and when it finished it took the
  // tab back to the previous account's page after the sign-in page. A failure is
  // shown on the sign-out page, which offers to try again.
  const navigation = useNavigation();
  const signingOut = navigation.state !== 'idle' && navigation.formAction === '/sign-out';

  useEffect(() => {
    if (!open) return;
    const surface = popRef.current;
    surface?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!surface?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const close = (restore = true) => {
    setOpen(false);
    if (restore) buttonRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    trapTab(event, popRef.current);
  };

  return (
    <div className={`me${compact ? ' me--compact' : ''}`}>
      {pop.mounted && !(left && !open) ? (
        <div {...pop.props} ref={popRef} id={popId} className="me__pop" role="dialog" aria-label="Account" onKeyDown={onKeyDown}>
          <div className="me__who">
            <b>{name}</b>
            <span>{email}</span>
            <span className="me__session">Signed in on this device until <time dateTime={sessionExpiresAt}>{until(sessionExpiresAt)}</time></span>
          </div>
          <div className="me__sec">
            <span className="me__label"><Icon name="bell" size={12} />Notifications on this device</span>
            <div className="me__notify"><NotificationsButton /></div>
          </div>
          <AppearanceControls idPrefix={popId} />
          {/* Settings and People, one way into each (#763 SG-7, PE-1): the assistant and background suggestions are in
              Settings → Agents and AI, so the menu never lists a feature this server or workspace has turned off. */}
          <div className="me__sec">
            <Link to="/settings" className="me__item" onClick={follow}><Icon name="gear" />All settings</Link>
            <Link to="/settings/people" className="me__item" onClick={follow}><Icon name="people" />People</Link>
          </div>
          <Form method="post" action="/sign-out" className="me__sec me__sec--end">
            <button type="submit" className="me__item" aria-disabled={signingOut || undefined}>
              {signingOut ? <Spinner /> : <Icon name="sign-out" />}{signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </Form>
        </div>
      ) : null}
      {/* The account and Settings (F-026 §4): the name opens the account; the gear is Settings. */}
      <div className="me__row">
        <button ref={buttonRef} type="button" className="me__btn" aria-expanded={open} aria-controls={open ? popId : undefined}
          aria-haspopup="dialog" title={compact ? `${name}, account and sign out` : undefined} onClick={() => { if (open) close(false); else { setLeft(false); setOpen(true); } }}>
          <Avatar name={name} tone="me" size={compact ? 'lg' : 'sm'} />
          {compact ? <span className="ui-vh">{name}, {email}</span>
            : <span className="me__text"><b>{name}</b><span className="ui-vh">{email}</span></span>}
          <span className="ui-vh">, account and sign out</span>
        </button>
        <Link to="/settings" className="me__settings" aria-label="Settings" title="Settings"><Icon name="gear" size={17} /></Link>
      </div>
    </div>
  );
}
