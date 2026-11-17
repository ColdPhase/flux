import { useLayoutEffect, type RefObject } from 'react';
import { useScrollEdges } from '../ui/scrollEdges';

/** The panel's lower fade (work.css `.wd__scroll::after`), drawn only while there is more below. */
const FADE = 20;

/** The room under which a panel counts as short: 25 rem (400 px), so larger text (200 %, Text size) makes the same panel short sooner. */
const SHORT_ROOM_REM = 25;

/** Per panel scroller: where it opened and whether the reader's last scroll reached its end. */
const reading = new WeakMap<HTMLElement, { opened: number; atEnd: boolean }>();

/** The panel is the phone's sheet: a few lines of room, under the work it was opened over. */
export const inPhoneSheet = (element: Element | null | undefined) => !!element?.closest('.ui-detent-sheet');

/**
 * The panel opens at its top, what the object is first (round 14 new P2-3; round 15 look-1 P2-2, look-3 F3): on the phone's sheet, and
 * wherever its scrolling room is short (under 25 rem, as at 200 % text on a computer), where the newest line would leave the title out
 * of view. Otherwise it opens at the discussion's newest line.
 */
export function opensAtTop(element: Element | null | undefined) {
  const scroller = element?.closest<HTMLElement>('.wd__scroll');
  if (!scroller) return inPhoneSheet(element);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return inPhoneSheet(scroller) || scroller.clientHeight < SHORT_ROOM_REM * rem;
}

/**
 * Scrolls the panel only as far as needed to show `target` whole, clear of the lower fade, never past its top and never past the top of
 * the title (`keep`): one move of the panel's own `scrollTop`, so the sheet and the page around it stay where they are. What the object is
 * stays in view first (round 15 look-1 P2-1, look-3 F2: a blocked task's sheet scrolled its title under the header to show the card).
 */
export function showWhole(scroller: HTMLElement, target: HTMLElement | null | undefined, keep?: HTMLElement | null) {
  if (!target) return;
  const room = scroller.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const over = box.bottom - (room.bottom - FADE);
  const title = keep ? keep.getBoundingClientRect().top - room.top : Infinity;
  // Whole pixels up: WebKit keeps `scrollTop` whole, so a fraction would leave the target half a pixel under the fade.
  if (over > 0) scroller.scrollTop += Math.max(0, Math.ceil(Math.min(over, box.top - room.top, title)));
}

/**
 * How a task's or a decision's panel opens (F-026 §7 "Both panels open the same way"; round 14 new P2-3, look-b B3, look-a A3). On the
 * computer the discussion's newest line is in view above the field (`ActivityTimeline`, `DecisionMessages`). The phone's sheet, and a short
 * panel (`opensAtTop`, 200 % text), show a few lines, so there the newest would leave no title, no Why and no state: it opens at its top,
 * what the object is first, scrolled only as far as needed to show whole what it asks of the reader (a proposed decision's Accept row, a
 * blocked task's "Waiting for" card) while its title stays in view.
 * The cursor put in its field (Discuss, `R`, a tap) brings the newest line into view, as a conversation's composer does.
 * The panel's lower edge fades only while there is more below (`useScrollEdges`).
 */
export function usePanelOpening(scrollRef: RefObject<HTMLElement | null>, objectKey: string, ask: string) {
  useScrollEdges(scrollRef, [objectKey]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    if (opensAtTop(scroller)) {
      scroller.scrollTop = 0;
      showWhole(scroller, scroller.querySelector<HTMLElement>(ask), scroller.querySelector<HTMLElement>('.details__title'));
    }
    // Whether the reader has since scrolled on to the panel's end (`wantsNewest`): a later part that grows the panel (its rows, its
    // discussion) moves the end away from them without a scroll of theirs.
    const state = { opened: scroller.scrollTop, atEnd: false };
    reading.set(scroller, state);
    const onScroll = () => { state.atEnd = scroller.scrollTop > state.opened && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2; };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  // Once for each object opened: what it asks stays where the reader leaves it after that.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey]);
}


/**
 * Where the panel opened at its top (`opensAtTop`), a discussion drawn for the first time still shows its newest line when the person already
 * asked for it before the lines arrived: the cursor is in the panel's field (`R`, Discuss: `useNewestOnWrite` had nothing to show yet), or
 * they had read to the panel's end, where the discussion now begins (personas-36 at 200 %: R, or reading on, showed not one line of it).
 */
export function wantsNewest(section: HTMLElement | null | undefined) {
  const scroller = section?.closest<HTMLElement>('.wd__scroll');
  if (!section || !scroller) return false;
  if (scroller.closest('.wd')?.querySelector('.wd__foot')?.contains(document.activeElement)) return true;
  return !!reading.get(scroller)?.atEnd
    || (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - section.offsetHeight - 2);
}

/** Where the panel opened at its top (`opensAtTop`), the newest line comes into view when the cursor goes into the panel's field at its foot. */
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
