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

/** Whether going from one path to another is a switch of view that should dissolve now. */
export function shouldDissolve(from: string, to: string): boolean {
  return routeView(from) !== routeView(to) && viewTransitionsSupported() && motionAllowed() && duration('--dur-view') > 0;
}

export function viewDirection(from: string, to: string, history: boolean): TravelDirection {
  const moved = viewRank(to) - viewRank(from);
  return moved > 0 ? 'forward' : moved < 0 ? 'back' : history ? 'back' : 'forward';
}

let release = 0;
/** For the next moments the content area, the pane's composer and the panel's body have names the transition can take pictures of. */
export function markDissolving(direction: TravelDirection) {
  const root = document.documentElement;
  root.dataset.vt = direction;
  window.clearTimeout(release);
  release = window.setTimeout(() => { delete root.dataset.vt; }, 450);
}
