/**
 * Whether this page is being left (#471). Once the browser has begun a navigation (from
 * `beforeunload` on) it has stopped the page's loads, and WebKit reports a `fetch` that starts after
 * that as a console error ("... due to access control checks"), which Playwright raises as an
 * uncaught page error, though the app handles the rejection. A request that was already running is
 * only cancelled and reported nowhere. A navigation the person cancels never reaches `pagehide`, so
 * the page is live again after a short grace, at once on a click or key press, and on `pageshow`.
 *
 * Nothing starts a request while the page is left: `api/client` waits here (`pageIsLive`), so the
 * polls, refetches after a stream event and the next step of a chain that the navigation cut
 * short all wait too. Waiting work is started again when the page is live, never dropped, so a
 * cancelled navigation leaves nothing stale, and an unloaded page starts nothing. Only a
 * `keepalive` request, sent on the way out on purpose, does not wait.
 */
export const LEAVING_GRACE_MS = 1000;

let leaving = false;
let graceTimer = 0;
const liveListeners = new Set<() => void>();

export const pageLeaving = () => leaving;

function live() {
  window.clearTimeout(graceTimer);
  graceTimer = 0;
  if (!leaving) return;
  leaving = false;
  for (const listener of [...liveListeners]) listener();
}

/** Called each time a page that was being left is live again. Returns the way to stop listening. */
export function onPageLive(listener: () => void) {
  liveListeners.add(listener);
  return () => { liveListeners.delete(listener); };
}

/**
 * Runs `run` now, or, while the page is being left, once it is live again (never, if it is
 * unloaded). Returns the way to cancel a run that has not started.
 */
export function whenPageLive(run: () => void) {
  if (!leaving) { run(); return () => undefined; }
  const stop = onPageLive(() => { stop(); run(); });
  return stop;
}

/**
 * Resolves when the page is live: at once for a page that is not being left, otherwise on a click, a key
 * press, `pageshow` or when the grace of a cancelled navigation ends; never for an unloaded page. Rejects
 * with an AbortError when `signal` aborts first, as the request it holds back would.
 */
export function pageIsLive(signal?: AbortSignal): Promise<void> {
  if (!leaving) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let stop: () => void = () => undefined;
    const abort = () => { stop(); reject(new DOMException('The request was aborted.', 'AbortError')); };
    stop = whenPageLive(() => { signal?.removeEventListener('abort', abort); resolve(); });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    leaving = true;
    window.clearTimeout(graceTimer);
    graceTimer = window.setTimeout(live, LEAVING_GRACE_MS);
  });
  window.addEventListener('pagehide', () => {
    window.clearTimeout(graceTimer);
    graceTimer = 0;
    leaving = true;
  });
  window.addEventListener('pageshow', live);
  // A person who can still click or type is on a page that stays.
  window.addEventListener('pointerdown', live, true);
  window.addEventListener('keydown', live, true);
}
