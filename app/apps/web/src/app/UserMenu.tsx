import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Form, Link, useNavigation } from 'react-router';
import { Avatar, Icon, Spinner, duration, play, trapTab } from '../ui';
import { NotificationsButton } from '../pwa';
import { setAccent, setTheme, useAccent, useResolvedTheme, useTheme, type AccentChoice, type ThemeChoice } from './theme';

const THEMES: { id: ThemeChoice; label: string; icon: 'monitor' | 'sun' | 'moon' }[] = [
  { id: 'system', label: 'System', icon: 'monitor' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

const ACCENTS: { id: AccentChoice; label: string }[] = [
  { id: 'mint', label: 'Mint' },
  { id: 'sky', label: 'Sky' },
  { id: 'copper', label: 'Copper' },
];

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function until(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

/**
 * Account button at the foot of the sidebar; opens a small popover with this device's session,
 * its notifications (#41), the theme and sign out.
 */
export function UserMenu({ name, email, sessionExpiresAt }: { name: string; email: string; sessionExpiresAt: string }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const theme = useTheme();
  const accent = useAccent();
  const resolvedTheme = useResolvedTheme();
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

  const onRadioKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = THEMES.findIndex((item) => item.id === theme);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = THEMES[(index + delta + THEMES.length) % THEMES.length]!;
    setTheme(next.id);
    requestAnimationFrame(() => popRef.current?.querySelector<HTMLElement>(`[data-theme-option="${next.id}"]`)?.focus());
  };

  const onAccentKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = ACCENTS.findIndex((item) => item.id === accent);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = ACCENTS[event.key === 'Home' ? 0 : event.key === 'End' ? ACCENTS.length - 1 : (index + delta + ACCENTS.length) % ACCENTS.length]!;
    setAccent(next.id);
    requestAnimationFrame(() => popRef.current?.querySelector<HTMLElement>(`[data-accent-option="${next.id}"]`)?.focus());
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
          <div className="me__sec">
            <span className="me__label" id={`${popId}-theme`}>Appearance</span>
            <div className="seg" role="radiogroup" aria-labelledby={`${popId}-theme`} onKeyDown={onRadioKey}>
              {THEMES.map((item) => (
                <button key={item.id} type="button" role="radio" className="seg__b" data-theme-option={item.id}
                  aria-checked={theme === item.id} tabIndex={theme === item.id ? 0 : -1} onClick={() => setTheme(item.id)}>
                  <Icon name={item.icon} size={14} />{item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="me__sec">
            <span className="me__label" id={`${popId}-accent`}>Accent</span>
            <span className="me__hint">For {resolvedTheme} appearance · remembered separately on this device</span>
            <div className="me-accent" role="radiogroup" aria-labelledby={`${popId}-accent`} onKeyDown={onAccentKey}>
              {ACCENTS.map((item) => (
                <button key={item.id} type="button" role="radio" className="me-accent__option" data-accent-option={item.id}
                  aria-checked={accent === item.id} tabIndex={accent === item.id ? 0 : -1} onClick={() => setAccent(item.id)}>
                  <span className="me-accent__sample" aria-hidden="true" />{item.label}
                  <Icon name="check" size={12} className="me-accent__check" />
                </button>
              ))}
            </div>
          </div>
          <div className="me__sec">
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
