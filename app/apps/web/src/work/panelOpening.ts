import { useLayoutEffect, type RefObject } from 'react';
import { useScrollEdges } from '../ui/scrollEdges';

/** The panel's lower fade (work.css `.wd__scroll::after`), drawn only while there is more below. */
const FADE = 20;

/** The panel is the phone's sheet: a few lines of room, under the work it was opened over. */
export const inPhoneSheet = (element: Element | null | undefined) => !!element?.closest('.ui-detent-sheet');

/**
 * Scrolls the panel only as far as needed to show `target` whole, clear of the lower fade, and never past its top: one move of the
 * panel's own `scrollTop`, so the sheet and the page around it stay where they are.
 */
export function showWhole(scroller: HTMLElement, target: HTMLElement | null | undefined) {
  if (!target) return;
  const room = scroller.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const over = box.bottom - (room.bottom - FADE);
  // Whole pixels up: WebKit keeps `scrollTop` whole, so a fraction would leave the target half a pixel under the fade.
  if (over > 0) scroller.scrollTop += Math.ceil(Math.min(over, Math.max(0, box.top - room.top)));
}

/**
 * How a task's or a decision's panel opens (F-026 §7 "Both panels open the same way"; round 14 new P2-3, look-b B3, look-a A3). On the
 * computer the discussion's newest line is in view above the field (`ActivityTimeline`, `DecisionMessages`). The phone's sheet shows a
 * few lines, so there the newest would leave no title, no Why and no state: it opens at its top, what the object is first, scrolled only
 * as far as needed to show whole what it asks of the reader (a proposed decision's Accept row, a blocked task's "Waiting for" card).
 * The cursor put in its field (Discuss, `R`, a tap) brings the newest line into view, as a conversation's composer does.
 * The panel's lower edge fades only while there is more below (`useScrollEdges`).
 */
export function usePanelOpening(scrollRef: RefObject<HTMLElement | null>, objectKey: string, ask: string) {
  useScrollEdges(scrollRef, [objectKey]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !inPhoneSheet(scroller)) return;
    scroller.scrollTop = 0;
    showWhole(scroller, scroller.querySelector<HTMLElement>(ask));
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
      if (!inPhoneSheet(scroller) || !(event.target instanceof HTMLElement) || !event.target.closest('.wd__foot')) return;
      const last = newest();
      const below = last ? last.getBoundingClientRect().bottom - (scroller.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(scroller).paddingBottom) || 0)) : 0;
      if (below > 0) scroller.scrollTop += below;
    };
    panel.addEventListener('focusin', focus);
    return () => panel.removeEventListener('focusin', focus);
  });
}
