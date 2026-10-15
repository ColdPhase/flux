import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { useToastTop } from '../ui';

/** Reserve only the occupied feedback area in a desktop task list, keeping its reading and focus. */
export function useTaskFeedback(ref: RefObject<HTMLElement | null>, enabled: boolean, observation: string | undefined, revision: unknown) {
  const toastTop = useToastTop();
  const owned = useRef<{ node: HTMLElement; margin: string; baseMargin: number; inset: number } | null>(null);
  const update = useCallback(() => {
    const pane = ref.current;
    if (!pane) return;
    if (owned.current?.node !== pane) {
      if (owned.current) owned.current.node.style.marginBottom = owned.current.margin;
      owned.current = { node: pane, margin: pane.style.marginBottom,
        baseMargin: parseFloat(getComputedStyle(pane).marginBottom) || 0, inset: 0 };
    }
    const previous = owned.current;
    const before = pane.getBoundingClientRect();
    const baseBottom = before.bottom + previous.inset;
    const last = [...pane.querySelectorAll<HTMLElement>('.ws-task .ws-item__t')].at(-1);
    const lastBefore = last?.getBoundingClientRect();
    const endWasVisible = !!lastBefore && lastBefore.top >= before.top && lastBefore.bottom <= baseBottom + 1;
    const inset = enabled && toastTop !== null ? Math.max(0, baseBottom - toastTop + 12) : 0;
    pane.style.marginBottom = inset ? `${previous.baseMargin + inset}px` : previous.margin;
    previous.inset = inset;
    if (!enabled || toastTop === null) return;

    const bounds = pane.getBoundingClientRect();
    const controls = pane.querySelector<HTMLElement>('.ws-task-controls');
    const top = Math.max(bounds.top, controls?.getBoundingClientRect().bottom ?? bounds.top) + 8;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && pane.contains(active) && active.closest('[data-work-kind][data-work-id]') ? active : null;
    if (focused) {
      const row = focused.getBoundingClientRect();
      if (row.top < top) pane.scrollTop += row.top - top;
      else if (row.bottom > bounds.bottom) pane.scrollTop += row.bottom - bounds.bottom;
    }
    // A newly occupied bottom must not hide a final title that was already in sight.
    // Other reading positions keep their existing anchor; never scroll the whole page.
    if (endWasVisible && last) {
      const gap = last.getBoundingClientRect().bottom - bounds.bottom;
      if (gap > 0 && (!focused || focused.getBoundingClientRect().top - gap >= top)) pane.scrollTop += gap;
    }
  }, [enabled, ref, toastTop]);
  const current = useRef(update);
  useLayoutEffect(() => { current.current = update; update(); }, [update, observation, revision]);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    const resize = () => current.current();
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', resize);
      if (owned.current) owned.current.node.style.marginBottom = owned.current.margin;
      owned.current = null;
    };
  }, [ref]);
}
