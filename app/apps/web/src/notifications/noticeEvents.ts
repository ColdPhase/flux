/**
 * What the shell needs to know about an in-app notice before the card's code is here (#1243, #1428): which stream events are notices, how old one
 * is, and which are too old for a card. The card (`Notices.tsx`) and the code that waits for it (`app/DeferredSurfaces.tsx`) share these, so an
 * event heard before the card's code has arrived is judged exactly as the card judges the ones that come after.
 */

export const NOTICE_EVENT = /^(project|dm)\.notice\.v1$/;
/** Older than this when it reaches the tab (it was held while the tab was hidden): the Inbox and push have it, the card does not. */
export const STALE_MS = 60_000;

/**
 * How old an event is, from the server's own times: the gap between the client's clock and an event's `createdAt` is smallest for an
 * event that arrived the moment it was written, so the smallest gap seen stands for "now" on the server's clock, whatever the client's
 * clock says (a clock minutes ahead or behind changes nothing).
 */
let nearest = Infinity;
export function eventAge(createdAt: string) {
  const gap = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(gap)) return 0;
  nearest = Math.min(nearest, gap);
  return gap - nearest;
}
