import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * The two heights of an in-page sheet (F-026 S4), for the thread that sits over the conversation:
 * a drag up on the grabber or header opens the full height, a drag down steps back to half and from
 * half closes. Mouse input and the grabber's own button (which toggles the height) are not dragged.
 */
export function useSheetDetents(startFull: boolean, close: () => void) {
  const [full, setFull] = useState(startFull);
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  return {
    full,
    toggle: () => setFull((value) => !value),
    handlers: {
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
        if (event.pointerType === 'mouse' || !event.isPrimary) return;
        if (!(event.target as HTMLElement).closest('.thread__head, .ui-grabber')) return;
        if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
        start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      },
      onPointerUp(event: ReactPointerEvent<HTMLElement>) {
        const from = start.current;
        start.current = null;
        if (!from || from.id !== event.pointerId) return;
        const dy = event.clientY - from.y;
        const dx = event.clientX - from.x;
        if (Math.abs(dy) < 24 || Math.abs(dx) > Math.abs(dy)) return;
        if (dy < 0) setFull(true);
        else if (full) setFull(false);
        else close();
      },
      onPointerCancel() { start.current = null; },
    },
  };
}
