/**
 * Service worker registration and the "new version available" flow (issue #41, MOB-5).
 * A new worker installs in the background and waits. The app shows a prompt; only when the
 * person confirms does it tell the waiting worker to take over, then reload once.
 */
type Listener = (update: ServiceWorkerUpdate | null) => void;

export interface ServiceWorkerUpdate {
  /** Activates the waiting version and reloads the page once it controls the page. */
  apply(): void;
}

const listeners = new Set<Listener>();
let pending: ServiceWorkerUpdate | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function announce(worker: ServiceWorker) {
  pending = {
    apply() {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
      worker.postMessage({ type: 'SKIP_WAITING' });
    },
  };
  for (const listener of listeners) listener(pending);
}

/** Subscribe to update availability; the listener is called immediately with the current state. */
export function onServiceWorkerUpdate(listener: Listener): () => void {
  listeners.add(listener);
  listener(pending);
  return () => listeners.delete(listener);
}

export function serviceWorkerSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
}

/**
 * Registers /sw.js for scope "/" once. Safe to call repeatedly; resolves to null when the browser
 * has no service worker support (for example plain http outside localhost).
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registrationPromise) return registrationPromise;
  if (!serviceWorkerSupported()) return (registrationPromise = Promise.resolve(null));
  registrationPromise = (async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const check = () => {
          // With no controller this is the first install, not an update.
          if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
        };
        worker.addEventListener('statechange', check);
        check();
      };
      watch(registration.waiting);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      const update = () => { registration.update().catch(() => undefined); };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') update(); });
      window.setInterval(update, 60 * 60 * 1000);
      return registration;
    } catch (error) {
      console.warn('Flux service worker registration failed', error);
      return null;
    }
  })();
  return registrationPromise;
}
