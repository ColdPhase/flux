import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
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
  if (root) root.inert = inertCount > 0;
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
  children: ReactNode;
}

const offstage: Record<OverlayPlacement, string> = {
  left: 'translateX(calc(-100% - 24px))',
  right: 'translateX(100%)',
  bottom: 'translateY(100%)',
  center: 'translateY(-8px) scale(.98)',
};

/**
 * Modal surface in a portal: scrim, focus moved in and trapped, Esc and scrim close,
 * the rest of the app inert, focus returned to the opener. Slides from its edge.
 */
export function Overlay({ open, onClose, placement, label, labelledBy, initialFocus, className, id, children }: OverlayProps) {
  const { mounted, unmount } = usePresence(open);
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
    const ms = duration('--dur-3');
    void play(scrim, [{ opacity: 0 }, { opacity: 1 }], ms, '--ease-out', { fill: 'backwards' });
    void play(surface, [{ transform: offstage[placement] }, { transform: 'none' }], ms, '--ease-sheet', { fill: 'backwards' });
    (initialFocus?.current ?? surface)?.focus({ preventScroll: true });
    return () => {
      setAppInert(false);
      const target = returnRef.current;
      returnRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
      const ms2 = placement === 'bottom' ? duration('--dur-3') * 0.85 : duration('--dur-2');
      void play(scrim, [{ opacity: 1 }, { opacity: 0 }], ms2, '--ease-in', { fill: 'forwards' });
      void play(surface, [{ transform: 'none' }, { transform: offstage[placement] }], ms2, '--ease-in', { fill: 'forwards' }).then(() => { if (!openRef.current) unmount(); });
    };
    // unmount/initialFocus are stable for the lifetime of one open overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted, placement]);

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
        className={['ui-overlay__surface', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        inert={!open}
      >
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
  return <Overlay placement="bottom" {...props} className={['ui-sheet', props.className].filter(Boolean).join(' ')} />;
}
