import { useLayoutEffect, type RefObject } from 'react';
import { useScrollEdges } from '../ui/scrollEdges';

/** The panel's lower fade (work.css `.wd__scroll::after`), drawn only while there is more below. */
const FADE = 20;

/** The panel is the phone's sheet: a few lines of room, under the work it was opened over. */
export const inPhoneSheet = (element: Element | null | undefined) => !!element?.closest('.ui-detent-sheet');

/** Below this height a panel has a few lines of room, as the phone's sheet: a computer at 200 % or a short window (round 15 look-1 P2-2). */
const SHORT_PANEL_PX = 480;

/**
 * The panel opens at its top, what the object is first: the phone's sheet, and a panel too short to show the title, what it asks and the
 * newest line together (at 200 % a decision opened at the end of its discussion with its title 341 px above the view, round 15).
 */
export function opensAtTop(element: Element | null | undefined): boolean {
  if (inPhoneSheet(element)) return true;
  const scroller = element?.closest<HTMLElement>('.wd__scroll') ?? null;
  return !!scroller && scroller.clientHeight > 0 && scroller.clientHeight < SHORT_PANEL_PX;
}

/**
 * Scrolls the panel only as far as needed to show `target` whole, clear of the lower fade, and never past its top or past the object's
 * title (`keep`): one move of the panel's own `scrollTop`, so the sheet and the page around it stay where they are. Which object it is comes
 * first: a "Waiting for" card that does not fit beside the title is shown as far as it fits (round 15 look-1 P2-1, look-3 F2: the title
 * was scrolled under the sheet's header).
 */
export function showWhole(scroller: HTMLElement, target: HTMLElement | null | undefined, keep?: HTMLElement | null) {
  if (!target) return;
  const room = scroller.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const over = box.bottom - (room.bottom - FADE);
  const title = keep ? Math.max(0, keep.getBoundingClientRect().top - room.top - (parseFloat(getComputedStyle(scroller).paddingTop) || 0)) : Infinity;
  // Whole pixels up: WebKit keeps `scrollTop` whole, so a fraction would leave the target half a pixel under the fade.
  if (over > 0) scroller.scrollTop += Math.floor(Math.min(Math.ceil(over), Math.max(0, box.top - room.top), title));
}

/**
 * How a task's or a decision's panel opens (F-026 §7 "Both panels open the same way"; round 14 new P2-3, look-b B3, look-a A3). On the
 * computer the discussion's newest line is in view above the field (`ActivityTimeline`, `DecisionMessages`). The phone's sheet, and a
 * panel as short (`opensAtTop`), shows a few lines, so there the newest would leave no title, no Why and no state: it opens at its top, what the object is first, scrolled only
 * as far as needed to show whole what it asks of the reader (a proposed decision's Accept row, a blocked task's "Waiting for" card).
 * The cursor put in its field (Discuss, `R`, a tap) brings the newest line into view, as a conversation's composer does.
 * The panel's lower edge fades only while there is more below (`useScrollEdges`).
 */
export function usePanelOpening(scrollRef: RefObject<HTMLElement | null>, objectKey: string, ask: string) {
  useScrollEdges(scrollRef, [objectKey]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !opensAtTop(scroller)) return;
    scroller.scrollTop = 0;
    showWhole(scroller, scroller.querySelector<HTMLElement>(ask), scroller.querySelector<HTMLElement>('.details__title'));
  // Once for each object opened: what it asks stays where the reader leaves it after that.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey]);
}

/** On the phone's sheet the newest line comes into view when the cursor goes into the panel's field at its foot. */
export function useNewestOnWrite(scrollRef: RefObject<HTMLElement | null>) {
  const newest = () => [...(scrollRef.current?.querySelectorAll<HTMLElement>('.wd-act') ?? [])].at(-1)?.lastElementChild as HTMLElement | null | undefined;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const panel = scroller?.closest<HTMLElement>('.wd');
    if (!scroller || !panel) return undefined;
    const focus = (event: FocusEvent) => {
      if (!opensAtTop(scroller) || !(event.target instanceof HTMLElement) || !event.target.closest('.wd__foot')) return;
      const last = newest();
      const below = last ? last.getBoundingClientRect().bottom - (scroller.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(scroller).paddingBottom) || 0)) : 0;
      if (below > 0) scroller.scrollTop += below;
    };
    panel.addEventListener('focusin', focus);
    return () => panel.removeEventListener('focusin', focus);
  });
}
