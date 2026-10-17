import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

/**
 * The handle of a two-height sheet: a real 44px target with a small bar for touch and mouse, and a
 * separate visually hidden button for keyboard and screen readers. The visible handle is neither a
 * <button> nor focusable: Chrome cancels a touch drag that starts on either, and this one must drag.
 */
export function SheetGrabber({ full, onToggle }: { full: boolean; onToggle: () => void }) {
  return (
    <>
      <div className="ui-grabber" aria-hidden="true" onClick={onToggle}><span /></div>
      <button type="button" className="ui-vh" aria-label={full ? 'Show half height' : 'Show full height'} aria-expanded={full} onClick={onToggle} />
    </>
  );
}

/**
 * The one phone sheet (F-026 S4): a grabber and two heights, half (the work behind stays in view) and full.
 * A drag up on the grabber or header opens the full height, a drag down steps back to half and from half
 * closes; Esc closes. Mouse input and the grabber's own buttons are not dragged. The content is the children:
 * a task, a decision, a thread, an agent or a thought's tasks, one after another in the same sheet, which keeps its
 * height while the content changes. It sits in a modal overlay.
 */
export function DetentSheet({ onClose, startFull = false, className, children, ...rest }: {
  onClose: () => void;
  /** It opens at full height (a thread); the height then stays while the content changes. */
  startFull?: boolean;
  className?: string;
  id?: string;
  role?: string;
  'aria-modal'?: boolean;
  'aria-labelledby'?: string;
  children: ReactNode;
}) {
  const [full, setFull] = useState(startFull);
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Escape that ends an input method's composition, or closes a menu or field inside, is not a request to close.
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    onClose();
  };
  const handlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      const target = event.target as HTMLElement;
      if (!target.closest('.ui-panel__head, .ui-grabber')) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
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
      else onClose();
    },
    onPointerCancel() { start.current = null; },
  };
  return (
    <div {...rest} tabIndex={-1} className={['ui-detent-sheet', className].filter(Boolean).join(' ')}
      data-detent-sheet="" data-height={full ? 'full' : 'half'} onKeyDown={onKeyDown} {...handlers}>
      <SheetGrabber full={full} onToggle={() => setFull((value) => !value)} />
      {children}
    </div>
  );
}
