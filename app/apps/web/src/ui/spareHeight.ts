import { useLayoutEffect, type RefObject } from 'react';

/**
 * A short feed sits against its composer, as in a messenger, instead of at the top with the screen's spare height
 * between it and the field (adaptive-workspaces ADAPT-2, tall screens). The spare height goes into `lift`, an empty
 * element before the feed's column. It is taken when `count` (the feed's entries) or the feed's size change. A row that
 * grows or shrinks in place (a queued message becoming the stored one, an image arriving) only gives height back and
 * never moves what is already there. A feed that fills its box has no spare height and scrolls as before, so reading
 * position owners see the same scroll geometry. With a `count` of 0 there is nothing to seat, so no height is taken.
 * `ready` is the feed's element in state, so the measurement runs once it exists.
 */
export function useSpareHeight(feed: RefObject<HTMLElement | null>, column: RefObject<HTMLElement | null>, lift: RefObject<HTMLElement | null>, count: number, ready: unknown) {
  useLayoutEffect(() => {
    const box = feed.current;
    const content = column.current;
    const spacer = lift.current;
    if (!box || !content || !spacer) return undefined;
    let height = 0;
    const spare = () => (count ? Math.max(0, Math.round(box.clientHeight - content.offsetHeight)) : 0);
    const set = (value: number) => { if (value !== height) { height = value; spacer.style.setProperty('height', `${value}px`); } };
    set(spare());
    let boxHeight = box.clientHeight;
    let boxWidth = box.clientWidth;
    const observer = new ResizeObserver(() => {
      // The feed's own size (a keyboard, a rotation, the panel docking so the text wraps again) takes the spare height afresh.
      if (box.clientHeight !== boxHeight || box.clientWidth !== boxWidth) { boxHeight = box.clientHeight; boxWidth = box.clientWidth; set(spare()); } else set(Math.min(height, spare()));
    });
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
    // The refs are stable; the entries and the feed element are what the measurement follows.
  }, [feed, column, lift, count, ready]);
}
