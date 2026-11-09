import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { publishTopEdge } from '../ui';

/**
 * The map's toolbar at the bottom of the plane (its tools, Undo, zoom): it publishes its top edge, so a toast stands above it and does not
 * cover it while it shows (the "Moved to …" toast over the toolbar for 8 s, #1116), as every floating control at the bottom does (ui.css `--toast-bottom`).
 */
export function DockRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? publishTopEdge(ref.current, '--ui-map-dock-inset') : undefined), []);
  return <div ref={ref} className="sk-dock__row">{children}</div>;
}
