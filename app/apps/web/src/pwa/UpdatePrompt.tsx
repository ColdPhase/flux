import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { onServiceWorkerUpdate, type ServiceWorkerUpdate } from './register.js';

/**
 * Shows "A new version is available" while an updated service worker waits. Reloading is the
 * person's choice, so unsent input is never discarded by an automatic update; "Later" puts the
 * offer away for this document and leaves the worker waiting.
 *
 * The offer is a row of the page above the shell, never a layer over it (#20, MOB-5): it takes its own
 * height, the shell gives up exactly that much (app.css reads --pwa-update-h), and nothing a person
 * needs (a header, Back, the dock, a composer) is ever under it, at any width or text size. It pads
 * its own top safe-area inset; while it is shown the shell below does not add the inset a second time.
 */
const subscribeLive = (change: () => void) => {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-live'] });
  return () => observer.disconnect();
};
const liveOn = () => document.documentElement.dataset.live === 'on';

export function UpdatePrompt() {
  const [update, setUpdate] = useState<ServiceWorkerUpdate | null>(null);
  // The update the person put away. A newer waiting worker is a different update and is offered again.
  const [later, setLater] = useState<ServiceWorkerUpdate | null>(null);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => onServiceWorkerUpdate(setUpdate), []);
  // In a live session (#62) reloading leaves it; say so before the person chooses.
  const inSession = useSyncExternalStore(subscribeLive, liveOn, () => false);
  const shown = update !== null && update !== later;
  // Publish the row's real height (it wraps with the width and the text size) before the first paint,
  // so the shell is never drawn under it, not even for a frame.
  useLayoutEffect(() => {
    const node = row.current;
    if (!shown || !node) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--pwa-update-h', `${node.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(node, { box: 'border-box' });
    root.dataset.pwaUpdate = 'on';
    measure();
    return () => {
      observer.disconnect();
      root.style.removeProperty('--pwa-update-h');
      delete root.dataset.pwaUpdate;
    };
  }, [shown]);
  if (!update || !shown) return null;
  return (
    <div ref={row} role="status" aria-live="polite" className="pwa-update" data-testid="flux-update-prompt">
      <div className="pwa-update__card">
        <span className="pwa-update__text">{inSession ? 'A new version of Flux is available. Reloading leaves the live session; saved work and drafts stay.' : 'A new version of Flux is available.'}</span>
        <span className="pwa-update__actions">
          <button type="button" className="ui-btn ui-btn--quiet" onClick={() => setLater(update)}>Later</button>
          <button type="button" className="ui-btn ui-btn--primary" onClick={() => update.apply()}>Reload</button>
        </span>
      </div>
    </div>
  );
}
