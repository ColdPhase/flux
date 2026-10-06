import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Form, Link, useLocation, useNavigation } from 'react-router';
import { Avatar, Icon, Spinner, duration, play, trapTab } from '../ui';
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
export function UserMenu({ name, email, sessionExpiresAt, asLink = false, onNavigate }: { name: string; email: string; sessionExpiresAt: string; asLink?: boolean; onNavigate?: () => void }) {
  // In the phone drawer the account row is a plain way into Settings (#266 PF-5), not a popover
  // squeezed over the drawer's own list.
  if (asLink) return <AccountLink name={name} email={email} onNavigate={onNavigate} />;
  return <AccountMenu name={name} email={email} sessionExpiresAt={sessionExpiresAt} />;
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

function AccountMenu({ name, email, sessionExpiresAt }: { name: string; email: string; sessionExpiresAt: string }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  // Signing out is a navigation of its own, not a fetcher: it replaces whatever this tab is still
  // loading. A fetcher's redirect would leave that load running, and when it finished it took the
  // tab back to the previous account's page after the sign-in page. A failure is
  // shown on the sign-out page, which offers to try again.
  const navigation = useNavigation();
  const signingOut = navigation.state !== 'idle' && navigation.formAction === '/sign-out';

  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    void play(pop, [{ opacity: 0, transform: 'translateY(4px) scale(.98)' }, { opacity: 1, transform: 'none' }], duration('--dur-2'), '--ease-out', { fill: 'backwards' });
    pop?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!pop?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false);
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
    <div className="me">
      {open ? (
        <div ref={popRef} id={popId} className="me__pop" role="dialog" aria-label="Account" onKeyDown={onKeyDown}>
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
          <div className="me__sec">
            <Link to="/settings" className="me__item" onClick={() => close(false)}><Icon name="gear" />All settings</Link>
            <Link to="/settings/assistant" className="me__item" onClick={() => close(false)}><Icon name="spark" />Your assistant</Link>
            <Link className="me__item" style={{ textDecoration: 'none' }} to="/settings/background-compute" onClick={() => close(false)}>
              <Icon name="spark" />Your background suggestions
            </Link>
          </div>
          <Form method="post" action="/sign-out" className="me__sec me__sec--end">
            <button type="submit" className="me__item" aria-disabled={signingOut || undefined}>
              {signingOut ? <Spinner /> : <Icon name="sign-out" />}{signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </Form>
        </div>
      ) : null}
      <button ref={buttonRef} type="button" className="me__btn" aria-expanded={open} aria-controls={open ? popId : undefined}
        aria-haspopup="dialog" onClick={() => (open ? close(false) : setOpen(true))}>
        <Avatar name={name} tone="me" />
        <span className="me__text"><b>{name}</b><span>{email}</span></span>
        <Icon name="chevron-up" className="me__chev" />
        <span className="ui-vh">, account and sign out</span>
      </button>
    </div>
  );
}
