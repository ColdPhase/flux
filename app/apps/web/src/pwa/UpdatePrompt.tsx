import { useEffect, useState, useSyncExternalStore } from 'react';
import { onServiceWorkerUpdate, type ServiceWorkerUpdate } from './register.js';

/**
 * Shows "A new version is available" while an updated service worker waits. Reloading is the
 * person's choice, so unsent input is never discarded by an automatic update.
 */
const subscribeLive = (change: () => void) => {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-live'] });
  return () => observer.disconnect();
};
const liveOn = () => document.documentElement.dataset.live === 'on';

export function UpdatePrompt() {
  const [update, setUpdate] = useState<ServiceWorkerUpdate | null>(null);
  useEffect(() => onServiceWorkerUpdate(setUpdate), []);
  // In a live session (#62) reloading leaves it; say so before the person chooses.
  const inSession = useSyncExternalStore(subscribeLive, liveOn, () => false);
  if (!update) return null;
  return (
    <div role="status" aria-live="polite" className="pwa-update" data-testid="flux-update-prompt">
      <span>{inSession ? 'A new version of Flux is available. Reloading leaves the live session; saved work and drafts stay.' : 'A new version of Flux is available.'}</span>
      <button type="button" className="ui-btn ui-btn--primary" onClick={() => update.apply()}>Reload</button>
    </div>
  );
}
