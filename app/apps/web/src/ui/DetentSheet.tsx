import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

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
 * closes; Esc closes; focus moves in when it opens when asked. Mouse input and the grabber's own buttons
 * are not dragged. The content is the children. The Details sheet sits in a modal overlay and the Thread
 * sheet sits over its conversation, both through this component.
 */
export function DetentSheet({ as: Tag = 'div', onClose, detent = true, startFull = false, focusOnOpen = false, className, children, ...rest }: {
  as?: 'div' | 'aside';
  onClose: () => void;
  /** False keeps the same element and children but not the sheet: the thread docked beside its stream is not a sheet, and must not remount when it becomes one. */
  detent?: boolean;
  startFull?: boolean;
  /** Focus the sheet itself when it opens, unless something inside already has focus. */
  focusOnOpen?: boolean;
  className?: string;
  id?: string;
  role?: string;
  'aria-modal'?: boolean;
  'aria-labelledby'?: string;
  children: ReactNode;
}) {
  const [full, setFull] = useState(startFull);
  const ref = useRef<HTMLDivElement & HTMLElement>(null);
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (focusOnOpen && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
    // When it opens; a composer may take focus first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
      if (!target.closest('.thread__head, .ui-panel__head, .ui-grabber')) return;
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
  const Element = Tag as 'div';
  return (
    <Element ref={ref} {...rest} tabIndex={-1} className={[detent ? 'ui-detent-sheet' : '', className].filter(Boolean).join(' ')}
      data-detent-sheet={detent ? '' : undefined} data-height={detent ? (full ? 'full' : 'half') : undefined} onKeyDown={onKeyDown} {...(detent ? handlers : {})}>
      {detent ? <SheetGrabber full={full} onToggle={() => setFull((value) => !value)} /> : null}
      {children}
    </Element>
  );
}
