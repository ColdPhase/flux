import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Form, Link, useLocation, useNavigation } from 'react-router';
import { Avatar, Icon, Spinner, trapTab, usePop } from '../ui';

/**
 * Account button at the foot of the sidebar; opens a small popover with the name, Settings and Sign out (C-34).
 * This device's notifications and the theme are in Settings.
 */
export function UserMenu({ id, name, email, asLink = false, compact = false, onNavigate }: { id: string; name: string; email: string; asLink?: boolean; compact?: boolean; onNavigate?: () => void }) {
  // In the phone drawer the account row is a plain way into Settings (#266 PF-5), not a popover
  // squeezed over the drawer's own list.
  if (asLink) return <AccountLink id={id} name={name} email={email} onNavigate={onNavigate} />;
  return <AccountMenu id={id} name={name} email={email} compact={compact} />;
}

function AccountLink({ id, name, email, onNavigate }: { id: string; name: string; email: string; onNavigate?: () => void }) {
  const current = useLocation().pathname === '/settings';
  return (
    <div className="me">
      <Link to="/settings" className="me__btn" aria-current={current ? 'page' : undefined} onClick={onNavigate}>
        <Avatar name={name} id={id} tone="me" />
        <span className="me__text"><b>{name}</b><span>{email}</span></span>
        <Icon name="gear" className="me__chev" />
        <span className="ui-vh">, settings and sign out</span>
      </Link>
    </div>
  );
}

function AccountMenu({ id, name, email, compact }: { id: string; name: string; email: string; compact: boolean }) {
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
    surface?.querySelector<HTMLElement>('a[href], button')?.focus();
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
          </div>
          {/* Settings, one way in (#763 SG-7): the company's people are in Settings › Company (F-037), and the agents in
              Settings → AI, so the menu never lists a feature this server has turned off. */}
          <div className="me__sec">
            <Link to="/settings" className="me__item" onClick={follow}><Icon name="gear" />Settings</Link>
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
          <Avatar name={name} id={id} tone="me" size={compact ? 'lg' : 'sm'} />
          {compact ? <span className="ui-vh">{name}, {email}</span>
            : <span className="me__text"><b>{name}</b><span className="ui-vh">{email}</span></span>}
          <span className="ui-vh">, account and sign out</span>
        </button>
        <Link to="/settings" className="me__settings" aria-label="Settings" title="Settings"><Icon name="gear" size={16} /></Link>
      </div>
    </div>
  );
}
