/**
 * Whether this page is being left (#471). From `beforeunload` until `pagehide` the browser may
 * cancel any request that starts, and WebKit reports a cancelled `fetch` as an uncaught page error
 * ("... due to access control checks") even when the app handles the rejection. A navigation the
 * person cancels never reaches `pagehide`, so the page is live again after a short grace, at once
 * on a click or key press, and on `pageshow`.
 *
 * Only background work waits here: reads nobody asked for at that moment (polls, refetches after a
 * stream event, checks that follow a state change). A request the person starts, or the load a
 * view needs to open, never goes through this module. Waiting work is started again when the page
 * is live, never dropped, so a cancelled navigation leaves nothing stale.
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
