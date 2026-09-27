import { useEffect, useState } from 'react';
import { disablePushNotifications, enablePushNotifications, getPushState, type PushState } from './push.js';

// Styled by the shell's tokens (apps/web/src/app/app.css: .pwa-note, .pwa-action).
const note = 'pwa-note';
const action = 'ui-btn ui-btn--secondary pwa-action';

type View = PushState | { state: 'loading' } | { state: 'working' } | { state: 'error'; message: string };

const MESSAGES: Partial<Record<View['state'], string>> = {
  unsupported: 'This browser cannot show Flux notifications. New activity always appears in your Inbox.',
  'needs-install': 'On iPhone and iPad, add Flux to your Home Screen first (Share, then Add to Home Screen), open it from there and turn notifications on here.',
  unavailable: 'Notifications are not set up on this Flux server. New activity always appears in your Inbox.',
  denied: 'Notifications are blocked for Flux in your browser or system settings. New activity still appears in your Inbox.',
};

/**
 * Settings control for this device's notifications. It never asks for permission on render;
 * the browser prompt appears only after the person presses "Turn on notifications".
 */
export function NotificationsButton({ deviceLabel }: { deviceLabel?: string }) {
  const [view, setView] = useState<View>({ state: 'loading' });
  const refresh = () => getPushState().then(setView, (error: unknown) => setView({ state: 'error', message: String(error) }));
  useEffect(() => { void refresh(); }, []);

  if (view.state === 'loading') return null;
  const message = MESSAGES[view.state];
  if (message) return <p className={note} role="note">{message}</p>;
  if (view.state === 'error') return <p className={note} role="alert">Notification settings could not be loaded. Your Inbox still works.</p>;
  if (view.state === 'subscribed') {
    return (
      <div>
        <p className={note}>Notifications are on for this device.</p>
        <button type="button" className={action} onClick={() => { setView({ state: 'working' }); void disablePushNotifications().finally(refresh); }}>
          Turn off on this device
        </button>
      </div>
    );
  }
  if (view.state === 'working') return <p className={note} aria-live="polite">Updating notifications…</p>;
  if (view.state !== 'prompt') return null;
  const { publicKey } = view;
  return (
    <div>
      <p className={note}>Get notified about mentions and replies, work assigned to you, decisions and agent results, even when Flux is closed.</p>
      <button
        type="button"
        className={action}
        onClick={() => {
          // Called directly in the click handler: the permission prompt needs this user gesture.
          const pending = enablePushNotifications(publicKey, deviceLabel);
          setView({ state: 'working' });
          void pending.then((result) => (result.status === 'error' ? setView({ state: 'error', message: result.message }) : refresh()));
        }}
      >
        Turn on notifications
      </button>
    </div>
  );
}
