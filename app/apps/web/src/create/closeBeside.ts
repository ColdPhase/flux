import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Whether the Create sheet's five kinds, at equal widths (the widest word times five), need more room than is left beside Close, so that Close
 * lies at the end of the line below instead (README, Segmented controls, #1561). It is measured from the tabs' own natural width, never from the
 * state it sets, so a wider phone or a smaller text puts Close back beside them. The tabs never shrink, scroll or get smaller text.
 */
export function useCloseBelow(head: RefObject<HTMLElement | null>): boolean {
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    const row = head.current;
    if (!row) return undefined;
    const check = () => {
      const bar = row.querySelector<HTMLElement>('.ui-tabs__bar');
      const close = row.querySelector<HTMLElement>('.create__x');
      if (!bar || !close) return;
      // The natural width: the bar hugging its tabs, all as wide as the widest (layout widths, so a sheet that is sliding in does not distort them).
      const kept = [bar.style.width, bar.style.maxWidth] as const;
      bar.style.width = 'max-content';
      bar.style.maxWidth = 'none';
      const natural = bar.offsetWidth;
      [bar.style.width, bar.style.maxWidth] = kept;
      const style = getComputedStyle(row);
      const inner = row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      setBelow(natural > inner - close.offsetWidth - (parseFloat(style.columnGap) || 0) + 0.5);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    // A webfont swap changes the words' widths without resizing the row.
    void document.fonts?.ready.then(check);
    return () => observer.disconnect();
  }, [head]);
  return below;
}
