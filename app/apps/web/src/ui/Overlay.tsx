import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { duration, play } from './motion';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
}

// The app root is made inert while any modal surface is open; a count supports nesting.
let inertCount = 0;
function setAppInert(on: boolean) {
  const root = document.getElementById('root');
  inertCount = Math.max(0, inertCount + (on ? 1 : -1));
  if (!root) return;
  root.inert = inertCount > 0;
  // Chromium can keep an animated element's inert style after the root leaves inert: on a phone the
  // work pane stayed untappable after Details closed, from its next view slide on (#151). A changed
  // inherited custom property makes every element below the root compute its style again.
  root.style.setProperty('--app-inert', inertCount > 0 ? '1' : '0');
}

/** Keeps a component mounted while its exit animation runs. */
export function usePresence(open: boolean) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  return { mounted, unmount: () => setMounted(false) };
}

/** Tab stays inside `root`; returns true when it handled the key. */
export function trapTab(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null): boolean {
  if (event.key !== 'Tab' || !root) return false;
  const items = focusableIn(root);
  if (!items.length) { event.preventDefault(); root.focus(); return true; }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === root)) { event.preventDefault(); last.focus(); return true; }
  if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); return true; }
  return false;
}

/** `center` is a floating dialog near the top (the Jump to… palette); the others slide in from their edge. */
export type OverlayPlacement = 'left' | 'right' | 'bottom' | 'center';

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  placement: OverlayPlacement;
  /** Accessible name of the dialog. */
  label?: string;
  labelledBy?: string;
  /** Element that receives focus on open; defaults to the surface itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  id?: string;
  /** A bottom sheet with two heights, half and full (F-026 S4): the grabber and a drag up or down change it. */
  detents?: boolean;
  children: ReactNode;
}

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

/** The sheet's current height; dragging down from half closes, from full it goes back to half. */
interface Detent { full: boolean; setFull: (full: boolean) => void }

const offstage: Record<OverlayPlacement, string> = {
  left: 'translateX(calc(-100% - 24px))',
  right: 'translateX(100%)',
  bottom: 'translateY(100%)',
  center: 'translateY(-8px) scale(.98)',
};

/**
 * Touch dismissal (#266 PF-4): the drawer follows a finger dragging it back to the left and the
 * phone sheet follows a drag down from its header. Released past a third of the way, or with a
 * flick, it closes from where it is; otherwise it settles back. Mouse input and keyboard keep
 * their own paths (scrim, close button, Esc), and vertical scrolling inside the drawer is untouched.
 */
function useDismissDrag(placement: OverlayPlacement, surfaceRef: RefObject<HTMLDivElement | null>, scrimRef: RefObject<HTMLDivElement | null>, close: () => void, detent?: Detent) {
  const state = useRef<{ id: number; x: number; y: number; t: number; moving: boolean; prev: number; prevT: number; last: number; lastT: number } | null>(null);
  if (placement !== 'left' && placement !== 'bottom') return {};
  const axis = placement === 'left' ? 'x' : 'y';
  const sign = placement === 'left' ? -1 : 1;
  const size = () => { const r = surfaceRef.current?.getBoundingClientRect(); return (axis === 'x' ? r?.width : r?.height) || 1; };
  const apply = (offset: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.style.transform = axis === 'x' ? `translateX(${offset}px)` : `translateY(${offset}px)`;
    if (scrimRef.current) scrimRef.current.style.opacity = String(Math.max(0, 1 - Math.abs(offset) / size()));
  };
  const settle = () => {
    const surface = surfaceRef.current;
    const scrim = scrimRef.current;
    const from = surface?.style.transform || 'none';
    void play(surface, [{ transform: from }, { transform: 'none' }], duration('--dur-2'), '--ease-out').then(() => { if (surface) surface.style.transform = ''; });
    if (scrim) { void play(scrim, [{ opacity: scrim.style.opacity || '1' }, { opacity: 1 }], duration('--dur-2'), '--ease-out').then(() => { scrim.style.opacity = ''; }); }
    if (!duration('--dur-2')) { if (surface) surface.style.transform = ''; if (scrim) scrim.style.opacity = ''; }
  };
  return {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      // The sheet drags only from its header, so its body keeps scrolling normally.
      if (placement === 'bottom' && !(event.target as HTMLElement).closest('.ui-panel__head, .ui-grabber')) return;
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      state.current = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, moving: false, prev: 0, prevT: event.timeStamp, last: 0, lastT: event.timeStamp };
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const drag = state.current;
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      const along = axis === 'x' ? dx : dy;
      const across = axis === 'x' ? dy : dx;
      if (!drag.moving) {
        if (Math.abs(along) < 8) return;
        // Up from half opens the full height; there is nothing to follow.
        if (detent && !detent.full && along < 0 && Math.abs(across) <= Math.abs(along)) { state.current = null; detent.setFull(true); return; }
        if (Math.abs(across) > Math.abs(along) || Math.sign(along) !== sign) { state.current = null; return; }
        drag.moving = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      // Toward the edge it follows the finger; the other way it resists.
      drag.prev = drag.last; drag.prevT = drag.lastT; drag.last = along; drag.lastT = event.timeStamp;
      apply(Math.sign(along) === sign ? along : along / 6);
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      const drag = state.current;
      state.current = null;
      if (!drag || drag.id !== event.pointerId || !drag.moving) return;
      const along = axis === 'x' ? event.clientX - drag.x : event.clientY - drag.y;
      // A flick is judged by the finger's speed as it lets go, not averaged from the start.
      const velocity = (along - drag.prev) / Math.max(1, event.timeStamp - drag.prevT);
      const far = Math.sign(along) === sign && (Math.abs(along) > size() / 3 || velocity * sign > 0.5);
      // Full height steps down to half first; only half closes.
      if (far && detent?.full) { detent.setFull(false); settle(); }
      else if (far) close();
      else settle();
    },
    onPointerCancel() {
      const drag = state.current;
      state.current = null;
      if (drag?.moving) settle();
    },
  };
}

/**
 * Modal surface in a portal: scrim, focus moved in and trapped, Esc and scrim close,
 * the rest of the app inert, focus returned to the opener. Slides from its edge.
 */
export function Overlay({ open, onClose, placement, label, labelledBy, initialFocus, className, id, detents, children }: OverlayProps) {
  const { mounted, unmount } = usePresence(open);
  const [full, setFull] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  useEffect(() => { onCloseRef.current = onClose; openRef.current = open; });


  useLayoutEffect(() => {
    if (!open || !mounted) return;
    // Remember the opener before focus moves into the surface.
    returnRef.current = document.activeElement as HTMLElement | null;
    const surface = surfaceRef.current;
    const scrim = scrimRef.current;
    // A reopen during the exit animation starts from a clean slate.
    for (const el of [surface, scrim]) el?.getAnimations().forEach((animation) => animation.cancel());
    setAppInert(true);
    // Full-screen phone sheets travel further, so they take the longer token (#266 PF-4).
    const ms = duration(placement === 'bottom' ? '--dur-4' : '--dur-3');
    void play(scrim, [{ opacity: 0 }, { opacity: 1 }], ms, '--ease-out', { fill: 'backwards' });
    void play(surface, [{ transform: offstage[placement] }, { transform: 'none' }], ms, '--ease-sheet', { fill: 'backwards' });
    (initialFocus?.current ?? surface)?.focus({ preventScroll: true });
    return () => {
      setAppInert(false);
      const target = returnRef.current;
      returnRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
      const ms2 = placement === 'bottom' ? duration('--dur-3') * 0.85 : duration('--dur-2');
      // A drag that closed the surface continues from where the finger let go (#266 PF-4).
      const from = surface?.style.transform || 'none';
      const scrimFrom = scrim?.style.opacity || '1';
      void play(scrim, [{ opacity: scrimFrom }, { opacity: 0 }], ms2, '--ease-in', { fill: 'forwards' });
      void play(surface, [{ transform: from }, { transform: offstage[placement] }], ms2, from === 'none' ? '--ease-in' : '--ease-out', { fill: 'forwards' }).then(() => {
        if (surface) surface.style.transform = '';
        if (scrim) scrim.style.opacity = '';
        if (!openRef.current) { unmount(); setFull(false); }
      });
    };
    // unmount/initialFocus are stable for the lifetime of one open overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted, placement]);

  const drag = useDismissDrag(placement, surfaceRef, scrimRef, () => onCloseRef.current(), detents ? { full, setFull } : undefined);

  if (!mounted) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); return; }
    trapTab(event, surfaceRef.current);
  };

  return createPortal(
    <div className={`ui-overlay ui-overlay--${placement}`} data-state={open ? 'open' : 'closing'}>
      <div ref={scrimRef} className="ui-scrim" onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div
        ref={surfaceRef}
        id={id}
        className={['ui-overlay__surface', detents ? 'ui-overlay__surface--detent' : '', className].filter(Boolean).join(' ')}
        data-height={detents ? (full ? 'full' : 'half') : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        inert={!open}
        {...drag}
      >
        {detents ? (
          <SheetGrabber full={full} onToggle={() => setFull((value) => !value)} />
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer(props: Omit<OverlayProps, 'placement'>) {
  return <Overlay placement="left" {...props} className={['ui-drawer', props.className].filter(Boolean).join(' ')} />;
}

export function Sheet(props: Omit<OverlayProps, 'placement'>) {
  return <Overlay placement="bottom" {...props} className={['ui-sheet', props.detents ? 'ui-sheet--detent' : '', props.className].filter(Boolean).join(' ')} />;
}
