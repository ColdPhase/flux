import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { duration, settle, token, type Easing, type Pose } from './motion';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
}

// The app root is made inert while any modal surface is open; a count supports nesting.
let inertCount = 0;
let inertSeq = 0;
// Open surfaces that leave the live session strip usable (`keepLiveStrip`). While every open surface is one,
// the root is not inert as a whole: everything beside the strip's path to the root is, so the strip is not.
let stripKeepers = 0;
const inertSiblings = new Set<HTMLElement>();
// Only the joined session's strip: the invitation card and the ended notice share `.lv-bar` but are ordinary content.
const liveStrip = () => document.querySelector<HTMLElement>('#root .lv-bar:not(.lv-bar--invite, .lv-bar--ended)');
let stripOnly = false;
const stripOnlyListeners = new Set<() => void>();
/** True while every open modal surface leaves the live strip usable, so the strip's own popover would sit under it. */
export function useStripOnlyModal(): boolean {
  return useSyncExternalStore((listener) => { stripOnlyListeners.add(listener); return () => { stripOnlyListeners.delete(listener); }; }, () => stripOnly, () => false);
}

function applyInert() {
  const root = document.getElementById('root');
  if (!root) return;
  document.getElementById('content')?.getAnimations().forEach((animation) => animation.cancel());
  for (const el of inertSiblings) el.inert = false;
  inertSiblings.clear();
  const strip = inertCount > 0 && stripKeepers === inertCount ? liveStrip() : null;
  if (strip) {
    root.inert = false;
    for (let node: HTMLElement = strip; node !== root && node.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) { sibling.inert = true; inertSiblings.add(sibling); }
      }
    }
  } else {
    root.inert = inertCount > 0;
  }
  // Shortcuts and the pane's interactivity rule ask this, not `root.inert`: the root stays live around the strip.
  if (inertCount > 0) root.setAttribute('data-modal', strip ? 'strip' : ''); else root.removeAttribute('data-modal');
  if (stripOnly !== !!strip) { stripOnly = !!strip; stripOnlyListeners.forEach((listener) => listener()); }
  // Chromium can keep an animated element's inert style after the root leaves inert: on a phone the work pane
  // stayed untappable after Details closed, from its next view slide on (#151). A changed inherited custom
  // property makes every element below the root compute its style again.
  root.style.setProperty('--app-inert', `${inertCount > 0 ? 1 : 0}-${++inertSeq}`);
}

// A strip that arrives or goes while a keeper is open (a session started from Details, #763 P2-1; Leave) changes what is
// inert: the decision is taken again whenever the strip itself changes, not only when a surface opens or closes.
let stripWatch: MutationObserver | null = null;
let watchedStrip: HTMLElement | null = null;
function watchStrip() {
  const root = document.getElementById('root');
  if (stripKeepers > 0 && root && !stripWatch) {
    watchedStrip = liveStrip();
    stripWatch = new MutationObserver(() => {
      const strip = liveStrip();
      if (strip === watchedStrip) return;
      watchedStrip = strip;
      applyInert();
    });
    stripWatch.observe(root, { childList: true, subtree: true });
  } else if (stripKeepers === 0 && stripWatch) {
    stripWatch.disconnect();
    stripWatch = null;
    watchedStrip = null;
  }
}

function setAppInert(on: boolean, keepsStrip = false) {
  inertCount = Math.max(0, inertCount + (on ? 1 : -1));
  if (keepsStrip) stripKeepers = Math.max(0, stripKeepers + (on ? 1 : -1));
  applyInert();
  watchStrip();
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
  /**
   * The surface is a transparent full-screen frame (still animated, inert-aware and focus-trapping) around a
   * sheet that brings its own look, dialog role and name: the content is a `DetentSheet`.
   */
  bare?: boolean;
  /**
   * The live session strip stays where it is, visible and usable, above this surface and its scrim: the
   * overlay starts below the strip, the rest of the app is inert, and Tab runs through the surface and the
   * strip. Leave and the microphone must not be taken away by a thread (F-026, live-ux "never covers").
   */
  keepLiveStrip?: boolean;
  children: ReactNode;
}

// Where each placement comes from and goes back to. The floating dialog and the detail panel's overlay form
// fade and move a few pixels (#593 AC-1); the drawer and the phone sheet travel from their edge.
const offstage = (placement: OverlayPlacement): Pose => ({
  left: { transform: 'translateX(calc(-100% - 24px))' },
  right: { opacity: 0, transform: `translateX(${token('--shift-panel') || '14px'})` },
  bottom: { transform: 'translateY(100%)' },
  center: { opacity: 0, transform: 'translateY(-8px) scale(.98)' },
})[placement];
/**
 * Enter and exit: every surface takes --dur-in (180 ms) and --dur-out (120 ms), the drawer and the phone sheet included
 * (#593 AC-1); they travel from their edge on --ease-sheet, the dialog and the panel on --ease-out.
 */
const timing = (placement: OverlayPlacement) => ({
  enter: duration('--dur-in'), exit: duration('--dur-out'),
  easeIn: (placement === 'center' || placement === 'right' ? '--ease-out' : '--ease-sheet') as Easing,
});

/**
 * Touch dismissal (#266 PF-4): the drawer follows a finger dragging it back to the left and the
 * phone sheet follows a drag down from its header. Released past a third of the way, or with a
 * flick, it closes from where it is; otherwise it settles back. Mouse input and keyboard keep
 * their own paths (scrim, close button, Esc), and vertical scrolling inside the drawer is untouched.
 */
function useDismissDrag(placement: OverlayPlacement, surfaceRef: RefObject<HTMLDivElement | null>, scrimRef: RefObject<HTMLDivElement | null>, close: () => void) {
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
  const springBack = () => {
    const surface = surfaceRef.current;
    const scrim = scrimRef.current;
    const ms = duration('--dur-2');
    // From where the finger let go back to rest; the inline drag offset goes once the animation owns the pose.
    void settle(surface, { transform: 'none' }, ms, '--ease-out', { from: { transform: surface?.style.transform || 'none' } }).then(() => { if (surface) surface.style.transform = ''; });
    void settle(scrim, { opacity: 1 }, ms, '--ease-out', { from: { opacity: scrim?.style.opacity || '1' } }).then(() => { if (scrim) scrim.style.opacity = ''; });
    if (!ms) { if (surface) surface.style.transform = ''; if (scrim) scrim.style.opacity = ''; }
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
      if (Math.sign(along) === sign && (Math.abs(along) > size() / 3 || velocity * sign > 0.5)) close();
      else springBack();
    },
    onPointerCancel() {
      const drag = state.current;
      state.current = null;
      if (drag?.moving) springBack();
    },
  };
}

/**
 * Modal surface in a portal: scrim, focus moved in and trapped, Esc and scrim close,
 * the rest of the app inert, focus returned to the opener. Slides from its edge.
 */
export function Overlay({ open, onClose, placement, label, labelledBy, initialFocus, className, id, bare, keepLiveStrip, children }: OverlayProps) {
  const { mounted, unmount } = usePresence(open);
  const frameRef = useRef<HTMLDivElement>(null);
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
    setAppInert(true, !!keepLiveStrip);
    // A reopen during the exit continues from where the exit had got to (settle), never from a start pose.
    const { enter, easeIn } = timing(placement);
    void settle(scrim, { opacity: 1 }, enter, '--ease-out', { from: { opacity: 0 } });
    void settle(surface, { opacity: 1, transform: 'none' }, enter, easeIn, { from: offstage(placement) });
    (initialFocus?.current ?? surface)?.focus({ preventScroll: true });
    return () => {
      setAppInert(false, !!keepLiveStrip);
      // Focus returns first and at once: the exit below never delays it, the next action or the next open.
      const target = returnRef.current;
      returnRef.current = null;
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        // WebKit may not focus what the app has only just been made operable again for; once more on the next frame.
        if (document.activeElement !== target) requestAnimationFrame(() => {
          if (target.isConnected && (!document.activeElement || document.activeElement === document.body)) target.focus({ preventScroll: true });
        });
      }
      const { exit } = timing(placement);
      // A drag that closed the surface continues from where the finger let go (#266 PF-4); a close during the
      // enter continues from where the enter had got to.
      const dragged = !!surface?.style.transform;
      const goal = offstage(placement);
      void settle(scrim, { opacity: 0 }, exit, '--ease-in', { from: { opacity: scrim?.style.opacity || 1 }, fill: 'forwards' });
      void settle(surface, goal, exit, dragged ? '--ease-out' : '--ease-in', { from: { transform: surface?.style.transform || 'none', ...(goal.opacity === undefined ? {} : { opacity: 1 }) }, fill: 'forwards' }).then(() => {
        if (surface) surface.style.transform = '';
        if (scrim) scrim.style.opacity = '';
        if (!openRef.current) unmount();
      });
    };
    // unmount/initialFocus are stable for the lifetime of one open overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted, placement]);

  // The overlay starts where the strip ends, so neither the scrim nor the sheet is painted over it. The scrim also
  // covers what is above the strip (the header's inert controls), by `--strip-top` and `--strip-bottom`.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const clear = () => { for (const name of ['top', '--strip-top', '--strip-bottom', '--strip-left', '--strip-right']) frame?.style.removeProperty(name); };
    if (!frame || !keepLiveStrip || !open || !mounted) { clear(); return; }
    const observer = new ResizeObserver(() => place());
    // The strip whose surroundings are watched; it may not exist yet when the surface opens (a session started from
    // Details, #763 P2-1) and then arrives under it.
    let watched: HTMLElement | null | undefined;
    function watch(strip: HTMLElement | null) {
      if (strip === watched) return;
      watched = strip;
      observer.disconnect();
      if (!strip) return;
      observer.observe(strip);
      // A move comes from a change above the strip as much as from the strip itself: watch its siblings too.
      for (const sibling of strip.parentElement?.children ?? []) observer.observe(sibling);
    }
    function place() {
      const strip = liveStrip();
      if (!frame) return;
      watch(strip);
      if (!strip) {
        // Leave took the strip (and the focused button) away: the sheet takes the whole screen and the focus.
        clear();
        if (!document.activeElement || document.activeElement === document.body) surfaceRef.current?.focus({ preventScroll: true });
        return;
      }
      const box = strip.getBoundingClientRect();
      frame.style.setProperty('top', `${Math.max(0, Math.round(box.bottom))}px`);
      frame.style.setProperty('--strip-bottom', `${Math.max(0, Math.round(box.bottom))}px`);
      frame.style.setProperty('--strip-top', `${Math.max(0, Math.round(box.top))}px`);
      frame.style.setProperty('--strip-left', `${Math.round(box.left)}px`);
      frame.style.setProperty('--strip-right', `${Math.round(box.right)}px`);
    }
    place();
    // The strip going or coming, anything entering beside it, and the window.
    const changes = new MutationObserver((records) => {
      const strip = liveStrip();
      if (strip !== watched || (strip && records.some((record) => record.target === strip.parentElement))) place();
    });
    const root = document.getElementById('root');
    if (root) changes.observe(root, { childList: true, subtree: true });
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); changes.disconnect(); window.removeEventListener('resize', place); };
  }, [keepLiveStrip, open, mounted]);

  // Tab leaves the surface into the strip and comes back; the surface's own wrap-around moves to the far ends.
  useEffect(() => {
    if (!keepLiveStrip || !open || !mounted) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.key !== 'Tab' && event.key !== 'Escape') || event.defaultPrevented || event.isComposing) return;
      const strip = liveStrip();
      const surface = surfaceRef.current;
      const target = event.target as HTMLElement | null;
      if (!surface || !target) return;
      // Esc closes the sheet from the strip too (a menu or dialog inside it uses its own Esc).
      if (event.key === 'Escape') {
        if (strip?.contains(target) && !target.closest('.lv-pop, [role="dialog"]') && !document.querySelector('.lv-pop')) onCloseRef.current();
        return;
      }
      if (!strip || !strip.contains(target) || target.closest('.lv-pop, [role="dialog"]')) return;
      const items = focusableIn(strip);
      const inside = focusableIn(surface);
      if (!items.length || !inside.length) return;
      if (!event.shiftKey && target === items[items.length - 1]) { event.preventDefault(); inside[0]!.focus(); }
      else if (event.shiftKey && target === items[0]) { event.preventDefault(); inside[inside.length - 1]!.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keepLiveStrip, open, mounted]);

  const drag = useDismissDrag(bare ? 'center' : placement, surfaceRef, scrimRef, () => onCloseRef.current());

  if (!mounted) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); return; }
    trapTab(event, surfaceRef.current);
  };
  // Captured before anything inside traps Tab itself: the ends of the surface continue into the strip.
  const onKeyDownCapture = keepLiveStrip ? (event: KeyboardEvent<HTMLDivElement>) => {
    const strip = liveStrip();
    if (event.key !== 'Tab' || !strip || !surfaceRef.current) return;
    const items = focusableIn(strip);
    const inside = focusableIn(surfaceRef.current);
    if (!items.length || !inside.length) return;
    const active = document.activeElement;
    if (!event.shiftKey && active === inside[inside.length - 1]) { event.preventDefault(); event.stopPropagation(); items[0]!.focus(); }
    else if (event.shiftKey && (active === inside[0] || active === surfaceRef.current)) { event.preventDefault(); event.stopPropagation(); items[items.length - 1]!.focus(); }
  } : undefined;

  return createPortal(
    <div ref={frameRef} className={`ui-overlay ui-overlay--${placement}`} data-state={open ? 'open' : 'closing'}>
      <div ref={scrimRef} className="ui-scrim" onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div
        ref={surfaceRef}
        id={bare ? undefined : id}
        className={['ui-overlay__surface', bare ? 'ui-overlay__surface--bare' : '', className].filter(Boolean).join(' ')}
        role={bare ? 'presentation' : 'dialog'}
        aria-modal={bare ? undefined : true}
        aria-label={bare ? undefined : label}
        aria-labelledby={bare ? undefined : labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onKeyDownCapture={onKeyDownCapture}
        inert={!open}
        {...drag}
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
