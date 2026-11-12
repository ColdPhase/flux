import { useLayoutEffect, useState, type RefObject } from 'react';

export interface Place { top: number; left: number; minWidth: number; maxHeight: number; side: 'below' | 'above' }

/** Measures where `layer` goes against `field`: under it, or over it when there is no room below (the select's rule, #695). */
function measure(field: HTMLElement, layer: HTMLElement, cap: number): Place {
  const box = field.getBoundingClientRect();
  const margin = 12;
  layer.style.maxHeight = 'none';
  const natural = layer.scrollHeight;
  const below = window.innerHeight - box.bottom - margin;
  const above = box.top - margin;
  const side = natural > below && above > below ? 'above' : 'below';
  const maxHeight = Math.max(120, Math.min(side === 'above' ? above : below, cap));
  const height = Math.min(natural, maxHeight);
  const minWidth = Math.round(box.width);
  const width = Math.max(layer.offsetWidth, minWidth);
  const top = side === 'above' ? box.top - 4 - height : box.bottom + 4;
  return {
    side, maxHeight, minWidth,
    top: Math.round(Math.max(8, Math.min(top, window.innerHeight - 8 - height))),
    left: Math.round(Math.max(8, Math.min(box.left, window.innerWidth - width - 8))),
  };
}

/**
 * Where a picker's layer sits on a computer: under its field, or over it when there is no room below, never past the window's
 * edge, and following the field while the page scrolls or the window changes. It is a layer over the page, so opening it never
 * moves the field or what is around it. `key` places it again when what it holds changes size. The last place is kept while the
 * layer fades out, so it leaves where it was.
 */
export function useAnchoredLayer(open: boolean, enabled: boolean, anchor: RefObject<HTMLElement | null>, pane: RefObject<HTMLElement | null>, cap: number, key: unknown) {
  const [place, setPlace] = useState<Place | null>(null);
  useLayoutEffect(() => {
    if (!open || !enabled) return undefined;
    const put = () => {
      if (anchor.current && pane.current) setPlace(measure(anchor.current, pane.current, cap));
    };
    put();
    const again = (event?: Event) => { if (!(event?.target instanceof Node && pane.current?.contains(event.target))) put(); };
    window.addEventListener('resize', again);
    document.addEventListener('scroll', again, true);
    return () => { window.removeEventListener('resize', again); document.removeEventListener('scroll', again, true); };
  }, [open, enabled, anchor, pane, cap, key]);
  return place;
}

/** The layer is a portal and React events cross portals: what it handles must not reach a drawer or panel around the field. */
export const containPointer = {
  onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onPointerMove: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onPointerUp: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onPointerCancel: (event: { stopPropagation: () => void }) => event.stopPropagation(),
};

/** What a field is called, as plain text for the sheet's title: its own label, or the `<label>` that names it. */
export function nameOfField(input: HTMLInputElement | null): string {
  if (!input) return '';
  const own = input.getAttribute('aria-label');
  if (own) return own;
  const by = input.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
  return [...(input.labels ?? [])].map((label) => label.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
}
