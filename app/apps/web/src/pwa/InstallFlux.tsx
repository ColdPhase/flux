import { useEffect, useRef, useState } from 'react';
import { installState, onInstallState, type InstallOutcome, type InstallState } from './install.js';

/**
 * Settings row for installing Flux on this device (#20, MOB-1): the browser's install dialog where it offers one, the
 * Home Screen steps on iPhone and iPad, the browser menu on Android, and nothing once Flux runs installed.
 *
 * A settings row like the others: title and text on the left, the one control on the right. It is placed last in its
 * card, so an offer that arrives late never moves another row. Once an offer has been shown the row stays for this
 * visit and says what happened in its status line, which exists (empty) before it is filled so the result is announced.
 */
export function InstallFlux({ title, phone }: { title: string; phone: boolean }) {
  const [view, setView] = useState<InstallState>(() => installState());
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);
  const [offered, setOffered] = useState(view.state === 'available');
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => onInstallState((next) => {
    setView(next);
    if (next.state === 'available') setOffered(true);
  }), []);

  const installed = view.state === 'just-installed';
  if (view.state === 'apple-steps' || view.state === 'menu-steps') {
    const steps = view.state === 'apple-steps'
      ? 'Tap Share, then Add to Home Screen, and open Flux from there. Notifications on iPhone and iPad work only from that Home Screen app.'
      : 'Choose Install app or Add to Home screen in your browser menu.';
    return (
      <div className="sset-row" data-testid="install-flux">
        <span className="sset-row__b"><span className="sset-row__t">{title}</span><span className="pwa-steps" role="note">{steps}</span></span>
      </div>
    );
  }
  if (!offered && !installed) return null;

  const message = installed ? (phone ? 'Open it from your home screen.' : 'Open it from its own window or your app list.')
    : outcome === 'dismissed' ? 'Not installed. Your browser menu can install Flux later.'
      : outcome === 'failed' ? 'The install dialog did not open. Try again, or use your browser menu.'
        : '';
  const lead = phone ? 'Open Flux from your home screen like an app.' : 'Open Flux in its own window.';
  const install = view.state === 'available' ? view.install : null;
  return (
    <div className="sset-row" data-testid="install-flux">
      <span className="sset-row__b">
        <span className="sset-row__t">{installed ? 'Flux is installed' : title}</span>
        {installed || outcome === 'dismissed' ? null : <span className="sset-row__s">{lead}</span>}
        {/* Present and empty first, then filled: a live region that appears with its text is often not announced. */}
        <span className="sset-row__s" role="status" ref={status} tabIndex={-1}>{message}</span>
      </span>
      {install && !installed ? (
        <button
          type="button"
          className="ui-btn ui-btn--secondary ui-btn--sm"
          // aria-disabled, not disabled: a disabled button drops the keyboard focus while the browser's dialog is open.
          aria-disabled={asking || undefined}
          onClick={() => {
            if (asking) return;
            // Called directly in the click handler: the browser shows its install dialog only after a gesture.
            setAsking(true);
            void install().then((result) => {
              setAsking(false);
              setOutcome(result);
              // The button goes away unless the person can try again: keep the focus in the row, on its status line.
              if (result !== 'failed') requestAnimationFrame(() => status.current?.focus());
            });
          }}
        >
          Install Flux
        </button>
      ) : null}
    </div>
  );
}
