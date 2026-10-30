import { useEffect, useState } from 'react';
import { onInstallState, type InstallState } from './install.js';

// Styled by the shell's tokens (apps/web/src/app/app.css: .pwa-note, .pwa-action).
const note = 'pwa-note';
const action = 'ui-btn ui-btn--secondary pwa-action';

/**
 * Settings row for installing Flux on this device (#20, MOB-1): the browser's install dialog where
 * it offers one, the Home Screen steps on iPhone and iPad, and nothing once Flux runs installed.
 */
export function InstallFlux({ title }: { title: string }) {
  const [view, setView] = useState<InstallState>({ state: 'none' });
  const [asking, setAsking] = useState(false);
  useEffect(() => onInstallState(setView), []);
  const body = installBody(view, asking, setAsking);
  if (!body) return null;
  return <div className="sset-row sset-row--stack" data-testid="install-flux"><span className="sset-row__t">{title}</span>{body}</div>;
}

function installBody(view: InstallState, asking: boolean, setAsking: (value: boolean) => void) {
  if (view.state === 'just-installed') return <p className={note} role="status">Flux is installed. Open it from your home screen or app list.</p>;
  if (view.state === 'apple-steps') {
    return <p className={note} role="note">To open Flux like an app, tap Share, then Add to Home Screen, and open Flux from there. Notifications on iPhone and iPad work only from the Home Screen app.</p>;
  }
  if (view.state === 'menu-steps') return <p className={note} role="note">To open Flux like an app, choose Install app or Add to Home screen in your browser menu.</p>;
  if (view.state !== 'available') return null;
  const { install } = view;
  return (
    <div>
      <p className={note}>Open Flux in its own window from your home screen or app list.</p>
      <button
        type="button"
        className={action}
        disabled={asking}
        onClick={() => {
          // Called directly in the click handler: the browser shows its install dialog only after a gesture.
          setAsking(true);
          void install().finally(() => setAsking(false));
        }}
      >
        Install Flux
      </button>
    </div>
  );
}
