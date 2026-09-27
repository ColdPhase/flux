import { useEffect, useState } from 'react';
import { onServiceWorkerUpdate, type ServiceWorkerUpdate } from './register.js';

/**
 * Shows "A new version is available" while an updated service worker waits. Reloading is the
 * person's choice, so unsent input is never discarded by an automatic update.
 */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<ServiceWorkerUpdate | null>(null);
  useEffect(() => onServiceWorkerUpdate(setUpdate), []);
  if (!update) return null;
  return (
    <div role="status" aria-live="polite" className="pwa-update" data-testid="flux-update-prompt">
      <span>A new version of Flux is available.</span>
      <button type="button" className="ui-btn ui-btn--primary" onClick={() => update.apply()}>Reload</button>
    </div>
  );
}
