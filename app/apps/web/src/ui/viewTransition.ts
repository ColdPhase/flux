import { duration, motionAllowed, type TravelDirection } from './motion';
import { routeView, viewRank } from './motion-rules';

/**
 * Views dissolve through the View Transitions API (#593 AC-3). A switch of project view, place or Settings section takes a picture of
 * the content area before and after and crossfades the two: the old content fades out and travels a few pixels in the direction of
 * travel (a view to the right of the last is forward, so Back reverses it) while the new content fades in beneath. The pictures live
 * in the browser's own layer, not in the document, so nothing answers a selector twice, and the header, sidebar, tab bar and a
 * composer (which has its own picture, in place) never move. Where the API is missing, or under reduced motion, the view just swaps.
 *
 * The router asks for the transition (`router.tsx`) and `markDissolving` names what to take pictures of for the moment it happens
 * (`ui.css`, `:root[data-vt]`): the names would otherwise make every content area a stacking context for good.
 */
export const viewTransitionsSupported = () => typeof document !== 'undefined' && typeof document.startViewTransition === 'function';

/** The one dissolve that is running (or being prepared): a second switch meanwhile just swaps. */
let running = false;

/** Whether going from one path to another is a switch of view that should dissolve now. */
export function shouldDissolve(from: string, to: string): boolean {
  return !running && routeView(from) !== routeView(to) && viewTransitionsSupported() && motionAllowed() && duration('--dur-view') > 0;
}

export function viewDirection(from: string, to: string, history: boolean): TravelDirection {
  const moved = viewRank(to) - viewRank(from);
  return moved > 0 ? 'forward' : moved < 0 ? 'back' : history ? 'back' : 'forward';
}

let release = 0;
/**
 * For the moments of the switch, the content area, the pane's composer and the page have the names the transition takes pictures
 * under (`ui.css`, `:root[data-vt]`), and the direction of travel says which way the old content leaves. It is taken off when the
 * transition has finished (a timer is the back-stop for a switch the browser never made a transition of): the names would otherwise
 * make every content area a stacking context for good, and the direction must not change while the old content is on its way out.
 */
export function markDissolving(direction: TravelDirection) {
  const root = document.documentElement;
  root.dataset.vt = direction;
  running = true;
  window.clearTimeout(release);
  release = window.setTimeout(unmark, 1500);
}
function unmark() {
  window.clearTimeout(release);
  running = false;
  delete document.documentElement.dataset.vt;
}

/**
 * A transition that is skipped (a second navigation while one runs, a page that was hidden) rejects its promises with an
 * AbortError; that is the browser doing what it is meant to, not a fault, so no one is left without a handler for it. This is also
 * where the names come off once the transition has finished. Called once, before the router starts its first navigation.
 */
let guarded = false;
export function installViewTransitionGuard() {
  if (guarded || !viewTransitionsSupported()) return;
  guarded = true;
  const start = document.startViewTransition.bind(document) as (callback?: () => void | Promise<void>) => ViewTransition;
  document.startViewTransition = ((callback?: () => void | Promise<void>) => {
    const transition = start(callback);
    for (const promise of [transition.ready, transition.updateCallbackDone]) promise.catch(() => undefined);
    transition.finished.then(unmark, unmark);
    return transition;
  }) as typeof document.startViewTransition;
  // What the router makes of those promises (its own chain on them) is quiet too.
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    if (/view transition|transition was skipped|skipTransition/i.test(text)) event.preventDefault();
  });
}
