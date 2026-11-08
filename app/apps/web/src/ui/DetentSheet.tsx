import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { duration, settle } from './motion';

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
 * height while the content changes. It sits in a modal overlay. Its top edge travels to the other height with `transform` over
 * --dur-in on --ease-out, never by animating `height` (#863 rule 8). Going up it takes the full height at once and its top edge
 * rises from where it was; going down it keeps the full height while it travels, so its bottom edge stays on the screen's edge
 * and the page never shows beneath it, and takes the half height when it arrives.
 */
export function DetentSheet({ onClose, startFull = false, onHeight, className, children, ...rest }: {
  onClose: () => void;
  /** It opens at full height; a thread opens at half like every sheet (guide §4: full is dragged up, #868). The height then stays while the content changes. */
  startFull?: boolean;
  /** Told the height whenever it is chosen, so a screen that is left can open at it again (#592). */
  onHeight?: (full: boolean) => void;
  className?: string;
  id?: string;
  role?: string;
  'aria-modal'?: boolean;
  'aria-labelledby'?: string;
  children: ReactNode;
}) {
  const [full, setFullNow] = useState(startFull);
  // Going down the sheet keeps its full height until it has travelled to the half one.
  const [lowering, setLowering] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const chosen = useRef(startFull);
  // Where the top edge was when the person chose the other height: the sheet travels from there to where it is after the change.
  const from = useRef<number | null>(null);
  const setFull = (next: boolean | ((value: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(chosen.current) : next;
    if (value === chosen.current) return;
    chosen.current = value;
    from.current = sheet.current?.getBoundingClientRect().top ?? null;
    setLowering(!value);
    setFullNow(value);
  };
  useLayoutEffect(() => {
    const el = sheet.current;
    const before = from.current;
    from.current = null;
    if (!el || before === null) return;
    if (full) {
      const shift = before - el.getBoundingClientRect().top;
      if (Math.abs(shift) >= 1) void settle(el, { transform: 'none' }, duration('--dur-in'), '--ease-out', { from: { transform: `translateY(${shift}px)` } });
      return;
    }
    // Down: the full height is still on (`lowering`); the half height's top edge is where the sheet is going.
    el.dataset.height = 'half';
    const shift = el.getBoundingClientRect().top - before;
    el.dataset.height = 'full';
    const done = (animation: Animation | null) => {
      if (chosen.current) return;
      flushSync(() => setLowering(false));
      animation?.cancel();
    };
    if (shift < 1) { setLowering(false); return; }
    void settle(el, { transform: `translateY(${shift}px)` }, duration('--dur-in'), '--ease-out', { from: { transform: 'none' }, fill: 'forwards' }).then(done);
  }, [full]);
  const heard = useRef(onHeight);
  useEffect(() => { heard.current = onHeight; });
  useEffect(() => { heard.current?.(full); }, [full]);
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
    <div {...rest} ref={sheet} tabIndex={-1} className={['ui-detent-sheet', className].filter(Boolean).join(' ')}
      data-detent-sheet="" data-height={full || lowering ? 'full' : 'half'} onKeyDown={onKeyDown} {...handlers}>
      <SheetGrabber full={full} onToggle={() => setFull((value) => !value)} />
      {children}
    </div>
  );
}
