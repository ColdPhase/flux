import { useEffect, type RefObject } from 'react';

/**
 * Where a list or a panel that scrolls can still go (#1375): its lower edge fades while there is more below, its upper edge while it is
 * scrolled, so a row cut by the edge reads as "more", not as the end. The marks are set when the size, the contents or the position
 * change; the fade itself is static CSS on `data-scroll-down` and `data-scroll-up`. At the end there is no fade, so it never washes out the
 * last line or a button (round 14 look-b B1, look-a A5: the task and decision panels faded their newest message and Accept).
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => {
      el.toggleAttribute('data-scroll-down', el.scrollTop + el.clientHeight < el.scrollHeight - 1);
      el.toggleAttribute('data-scroll-up', el.scrollTop > 1);
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const observer = new ResizeObserver(check);
    const watch = () => { observer.observe(el); for (const child of el.children) observer.observe(child); };
    watch();
    // A part that comes or goes later (a discussion read after the panel, a blocker being edited) is watched too.
    const added = new MutationObserver(() => { watch(); check(); });
    added.observe(el, { childList: true });
    return () => { el.removeEventListener('scroll', check); observer.disconnect(); added.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);
}
