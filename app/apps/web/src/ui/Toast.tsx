import { useKeysLive } from './useKeysLive';
import { createContext, type CSSProperties, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { Icon } from './Icon';
import { Kreska, type KreskaExpression } from './Kreska';
import { duration, settle } from './motion';
import { useSmallMoments } from './smallMoments';
import { isTyping } from './keys';
import './moments.css';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
  key?: 'Z';
  /** A step back that is not called Undo (Hand back): an Undo toast all the same, with its 10 s and its place (#1424). */
  undoes?: true;
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Milliseconds before a toast without Undo leaves on its own; errors stay until dismissed. An Undo toast always has
   *  {@link UNDO_MS} (#1424), so it takes no timeout. */
  timeout?: number;
  /** One quiet action beside the message, e.g. Undo or Hand back. Taking it closes the toast. */
  action?: ToastAction;
  /** A second quiet action after the first, e.g. "Another task" after Undo (#1235). Taking it closes the toast too. */
  also?: ToastAction;
  /** A small moment: the wink after a task is closed. Shown only while Small moments is on; the message says it all. */
  mascot?: KreskaExpression;
  /** Called once when the toast leaves without its action being taken: its time, ×, a newer toast, another place, the session
   *  ending, or a toast that could not be shown. A change held for Undo is sent then (#1424). */
  onLeave?: () => void;
}

interface ToastEntry extends Required<Omit<ToastOptions, 'timeout' | 'action' | 'also' | 'mascot' | 'onLeave'>> {
  mascot: KreskaExpression | null;
  /** An Undo toast (#1424): 10 s, and it leaves when the person goes to another place. */
  undo: boolean;
  /** Mutable: set when its action ran, or when it left; `onLeave` runs at most once and never after the action. */
  done: { acted: boolean; ended: boolean; onLeave: (() => void) | null };
  id: number;
  action: ToastOptions['action'] | null;
  also: ToastOptions['also'] | null;
  timeout: number | null;
  leaving: boolean;
  sessionEpoch: number;
}

/** How long a toast with an Open-style action stays (CW-5). */
const ACTION_TIMEOUT_MS = 8000;
/** How long every Undo toast stays (founder decision, 2026-11-14, #1424), paused while hovered or focused. */
export const UNDO_MS = 10_000;
/** A toast's action ignores a tap this soon after the toasts moved: the tap was meant for what was there. */
const ACTION_ARMED_MS = 600;
/** How far the toasts must move for the tap guard: about half a toast, so a tap aimed elsewhere could land on one. */
const MOVE_PX = 24;

const ToastContext = createContext<(options: ToastOptions) => () => void>(() => () => {});
const ToastScopeContext = createContext<() => boolean>(() => true);
const ToastTopContext = createContext<number | null>(null);
/** Takes the Undo toasts away now, as moving to another place does (#1424). */
const LeaveUndoContext = createContext<() => void>(() => {});

/** Actual top of the rendered feedback stack, or null while no feedback is shown. */
export function useToastTop() { return useContext(ToastTopContext); }

const ToastStackContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

/**
 * A conversation keeps its end clear of the toast while one shows (#1424, B-8): the end of its list moves up by the part of the
 * toast over the feed (`--toast-clear`, a transparent bottom border of the feed's column, see ui.css), so the newest card or an
 * inline Delete / Keep row is never under it. A reader at the end stays at the end; one reading higher up is not moved. When the
 * toast goes, nothing moves either: the room is given back only once the reader's view ends above it (they scrolled up, or were
 * never at the end), so the message under the pointer stays under it.
 */
export function useClearOfToast(ref: RefObject<HTMLElement | null>, attached: HTMLElement | null) {
  const top = useToastTop();
  const stack = useContext(ToastStackContext);
  useLayoutEffect(() => {
    if (!attached) return undefined;
    // `grow` is false for the reader's own scrolling: that only gives room back, it never takes more.
    const update = (grow: boolean) => {
      const feed = ref.current;
      if (!feed || (top === null && !feed.style.getPropertyValue('--toast-clear'))) return;
      const box = feed.getBoundingClientRect();
      // The toasts that stay: one that is leaving takes no room, so its going never adds any.
      const staying = top === null ? [] : [...(stack?.current?.querySelectorAll<HTMLElement>('.ui-toast:not([data-leaving])') ?? [])];
      const toasts = staying.map((toast) => toast.getBoundingClientRect()).filter((rect) => rect.height > 0 && rect.left < box.right && rect.right > box.left && rect.top < box.bottom);
      const clear = toasts.length ? Math.max(0, Math.ceil(box.bottom - Math.min(...toasts.map((rect) => rect.top)) + 8)) : 0;
      const was = parseFloat(feed.style.getPropertyValue('--toast-clear')) || 0;
      if (clear === was || (!grow && clear > was)) return;
      const left = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
      // Less room: only while the part given back is out of view, so nothing on screen moves.
      if (clear < was && left < was - clear - 1) return;
      if (clear) feed.style.setProperty('--toast-clear', `${clear}px`); else feed.style.removeProperty('--toast-clear');
      if (clear > was && left <= 2) feed.scrollTop = feed.scrollHeight;
    };
    const measure = () => update(true);
    const scrolled = () => update(false);
    measure();
    // A toast settles after it is shown (it comes in from below, and stands above a composer that may still be moving): measured again.
    const frame = requestAnimationFrame(measure);
    const later = [window.setTimeout(measure, 400), window.setTimeout(measure, 1000)];
    const feed = ref.current;
    window.addEventListener('resize', measure);
    feed?.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      cancelAnimationFrame(frame); later.forEach((id) => window.clearTimeout(id));
      window.removeEventListener('resize', measure); feed?.removeEventListener('scroll', scrolled);
    };
  }, [ref, attached, top, stack]);
}

export function useToast() {
  return useContext(ToastContext);
}

/** A captured action/result remains current only within this provider's original session epoch. */
/** A pointer that hovers (a mouse or a trackpad); a touch screen's has none (`(hover: none)`, as elsewhere in the app). */
const hovers = () => !window.matchMedia('(hover: none)').matches;

/**
 * Undo toasts leave now, as when the address changes: a window that lists what they would undo (the Inbox's "for later" and "done today")
 * has its own way back, and a toast over it covered its rows on a phone (personas-30).
 */
export function useLeaveUndoToasts() {
  return useContext(LeaveUndoContext);
}

export function useToastScope() {
  return useContext(ToastScopeContext);
}

function ToastItem({ toast, onDone, onLeaving, registerAction, movedAt }: { toast: ToastEntry; onDone: (id: number) => void; onLeaving: (toast: ToastEntry) => void; registerAction: (id: number, run: (() => void) | null) => void; movedAt: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLSpanElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const timer = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ran = useRef(false);
  const moments = useSmallMoments();
  const dismiss = useCallback(() => setLeaving(true), []);
  // Its key (Z) is shown only while it works: in the composer Z is typing (F-026 §4, persona round 30).
  const keysLive = useKeysLive();
  const pressedFrom = useRef<HTMLElement | null>(null);
  const notePress = () => { const active = document.activeElement; pressedFrom.current = active instanceof HTMLElement && active !== document.body && !ref.current?.contains(active) ? active : null; };
  const act = useCallback((event?: { detail: number }, second = false) => {
    const action = second ? toast.also : toast.action;
    if (!action || ran.current || leaving || toast.leaving) return;
    // A pointer tap that lands just as the toasts moved (above a sheet that opened) was aimed at what was there (CW-5).
    if (event && event.detail > 0 && performance.now() - movedAt < ACTION_ARMED_MS) return;
    ran.current = true;
    action.onClick();
    dismiss();
    // A press with the mouse leaves focus where the person was before it (the control that made the change), as Z and Enter do, never on the
    // page's content once the toast is gone (F-026 §4).
    const before = pressedFrom.current;
    pressedFrom.current = null;
    if (before) requestAnimationFrame(() => requestAnimationFrame(() => {
      const active = document.activeElement;
      const lost = !active || active === document.body || active.id === 'content' || !!ref.current?.contains(active);
      if (lost && before.isConnected && !before.closest('.ui-toast, [inert]')) before.focus({ preventScroll: true });
    }));
  }, [toast.action, toast.also, leaving, toast.leaving, dismiss, movedAt]);
  useEffect(() => {
    if (!toast.action?.key || leaving || toast.leaving) return undefined;
    registerAction(toast.id, () => act());
    return () => registerAction(toast.id, null);
  }, [toast.action, toast.id, leaving, toast.leaving, act, registerAction]);
  // The time left: hovering or focusing the toast pauses it, and leaving it runs on from there (#1424, as a notice's do). Only a pointer that
  // hovers pauses it: on a touch screen the tap on Undo leaves the browser's pointer where the next toast ("#4 back to To do") appears, and
  // no finger would ever leave it, so that toast stayed until the next tap elsewhere.
  const left = useRef(toast.timeout);
  const armedAt = useRef(0);
  const held = useRef({ pointer: false, focus: false });
  const arm = useCallback(() => {
    if (left.current === null || timer.current !== null) return;
    armedAt.current = performance.now();
    timer.current = window.setTimeout(dismiss, Math.max(0, left.current));
  }, [dismiss]);
  const disarm = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    if (left.current !== null) left.current -= performance.now() - armedAt.current;
  }, []);

  useLayoutEffect(() => {
    const node = message.current;
    if (!node) return;
    const update = () => setScrollable(node.scrollHeight > node.clientHeight + 1);
    const observer = new ResizeObserver(update);
    observer.observe(node, { box: 'border-box' });
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void settle(ref.current, { opacity: 1, transform: 'none' }, duration('--dur-in'), '--ease-out', { from: { opacity: 0, transform: 'translateY(8px)' } });
    arm();
    return disarm;
  }, [arm, disarm]);

  useEffect(() => {
    if (!leaving && !toast.leaving) return;
    onLeaving(toast);
    // A toast dismissed while it arrives leaves from where it is; it is gone in --dur-out and never held.
    void settle(ref.current, { opacity: 0, transform: 'translateY(8px)' }, duration('--dur-out'), '--ease-in', { from: { opacity: 1, transform: 'none' }, fill: 'forwards' })
      .then(() => onDone(toast.id));
  }, [leaving, toast, onDone, onLeaving]);

  return (
    <div ref={ref} data-leaving={leaving || toast.leaving ? '' : undefined} className={`ui-toast ui-toast--${toast.tone}${toast.also ? ' ui-toast--also' : ''}${scrollable ? ' ui-toast--scrollable' : ''}`} onMouseEnter={() => { if (!hovers()) return; held.current.pointer = true; disarm(); }} onMouseLeave={() => { held.current.pointer = false; if (!held.current.focus) arm(); }}
      onFocus={() => { held.current.focus = true; disarm(); }} onBlur={(event) => { if (event.currentTarget.contains(event.relatedTarget as Node | null)) return; held.current.focus = false; if (!held.current.pointer) arm(); }}>
      {/* One look for every toast that says what was done (round 14, daily P3-10: Done in the Inbox had no mark, a role change a ✓): no
          mark beside the words. Only Kreska's Wink for a closed task, and the alert of what failed, stand there. */}
      {toast.mascot && moments ? <Kreska expression={toast.mascot} size={24} /> : toast.tone === 'danger' ? <Icon name="alert" /> : null}
      <span ref={message} className="ui-toast__msg" tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? 'region' : undefined} aria-label={scrollable ? 'Notification message' : undefined}>{toast.message}</span>
      {toast.action && !leaving && !toast.leaving ? (
        <>
          <span className="ui-toast__sep" aria-hidden="true" />
          <button type="button" className="ui-toast__action" onPointerDown={notePress} onClick={(event) => act(event)} aria-keyshortcuts={toast.action.key} title={toast.action.key ? `${toast.action.label} (${toast.action.key})` : undefined}>
            {toast.action.label}{toast.action.key ? <kbd aria-hidden="true" style={keysLive ? undefined : { visibility: 'hidden' }}>{toast.action.key}</kbd> : null}
          </button>
        </>
      ) : null}
      {toast.also && !leaving && !toast.leaving ? <button type="button" className="ui-toast__action" onClick={(event) => act(event, true)}>{toast.also.label}</button> : null}
      <button type="button" className="ui-toast__close" onClick={dismiss} aria-label="Dismiss notification"><Icon name="x" size={14} /></button>
    </div>
  );
}

/**
 * CW-5: while a dialog or sheet is open, toasts sit above its lowest controls (Next, Cancel, Save…), so a tap meant for
 * them never lands on a toast. Measured from the open modal surfaces while any toast shows; `movedAt` is when that last
 * changed, for the action's tap guard.
 */
/** Where the toasts stand beside an open detail panel, centred over the work left of it (`left`, px) and no wider than it (`width`). */
type Beside = { left: number; width: number } | null;

/**
 * The open detail panel on a computer or tablet (never modal, F-026 §4) keeps its rows clear of a toast: a toast that would stand on the panel
 * is centred over the work beside it instead, as narrow as that work, when there is room there (personas-33/34: at 200 % the toast covered
 * the new task's Due row). The phone's sheet is a modal surface, which `useModalLift` already keeps clear.
 */
function besidePanel(node: HTMLElement | null): Beside {
  const panel = document.getElementById('details');
  if (!node || !panel || window.innerWidth <= 640 || document.querySelector('[aria-modal="true"]')) return null;
  const box = panel.getBoundingClientRect();
  if (!box.width || !box.height || box.left >= window.innerWidth) return null;
  const kept = [node.style.getPropertyValue('--toast-left'), node.style.getPropertyValue('--toast-max')] as const;
  node.style.removeProperty('--toast-left'); node.style.removeProperty('--toast-max');
  const natural = node.getBoundingClientRect();
  if (kept[0]) node.style.setProperty('--toast-left', kept[0]);
  if (kept[1]) node.style.setProperty('--toast-max', kept[1]);
  if (!natural.height || natural.right <= box.left || natural.left >= box.right || natural.bottom <= box.top || natural.top >= box.bottom) return null;
  const work = document.querySelector('.app__main')?.getBoundingClientRect();
  const left = (work?.left ?? 0) + 12;
  const right = box.left - 12;
  return right - left >= 200 ? { left: Math.round((left + right) / 2), width: Math.floor(right - left) } : null;
}

/**
 * A page of two columns names the column its toasts stand under (`data-toast-home`): the two-column Inbox's open item, where Done and Not now
 * were pressed, so a toast never straddles the line between the columns or covers the list's last card (round 15 look-1 P3-4).
 */
function toastHome(): Beside {
  const home = document.querySelector<HTMLElement>('[data-toast-home]');
  if (!home || window.innerWidth <= 640 || document.querySelector('[aria-modal="true"]')) return null;
  const box = home.getBoundingClientRect();
  return box.width >= 280 ? { left: Math.round(box.left + box.width / 2), width: Math.floor(box.width - 24) } : null;
}

function useModalLift(active: boolean, stack: RefObject<HTMLElement | null>): { inset: number; movedAt: number; beside: Beside } {
  const [lift, setLift] = useState<{ inset: number; movedAt: number; beside: Beside }>({ inset: 0, movedAt: -Infinity, beside: null });
  useLayoutEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    // Toasts that just appeared did not move under a finger: their first placement, and its settling while the action that
    // showed them re-lays the sheet (a phone's Resolve removes the blocker card, #249), do not arm the tap guard. Only a
    // later change of MOVE_PX or more (a sheet opening while a toast shows) does, so an Undo tapped right away still works.
    let placedAt: number | null = null;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let top = Infinity;
        let surfaceTop = Infinity;
        const controls: DOMRect[] = [];
        for (const surface of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
          const box = surface.getBoundingClientRect();
          if (!box.height || box.bottom < window.innerHeight - 160) continue;
          surfaceTop = Math.min(surfaceTop, box.top);
          // The surface's footer actions, where they reach the band at the bottom of the screen that toasts use.
          for (const control of surface.querySelectorAll<HTMLElement>('button, a[href], [role="button"], input, select, textarea, label:has(input[type="checkbox"], input[type="radio"])')) {
            const rect = control.getBoundingClientRect();
            if (!rect.height || rect.top >= window.innerHeight) continue;
            controls.push(rect);
            if (rect.bottom > Math.max(box.bottom - 120, window.innerHeight - 160)) top = Math.min(top, rect.top);
          }
        }
        const band = Number.isFinite(top) ? Math.max(0, Math.round(window.innerHeight - top + 8)) : 0;
        // The toast is also kept off any control it would stand on where it lands: it is as tall as its message and lands above the lowest
        // control, which can put it on the one above (a phone sheet's "Dropped, not finished" and "What came of it", #1116). It is raised
        // above each control it would cover until none is; a sheet whose controls leave no such place within the lower half of the
        // window (a sheet is a stack of rows) has the toast stand above the sheet, over the page behind it, when there is room there.
        const node = stack.current;
        let inset = band;
        if (node && controls.length) {
          const kept = node.style.getPropertyValue('--toast-modal-inset');
          node.style.setProperty('--toast-modal-inset', '0px');
          const rest = node.getBoundingClientRect();
          if (kept) node.style.setProperty('--toast-modal-inset', kept); else node.style.removeProperty('--toast-modal-inset');
          if (rest.height) {
            const start = Math.max(band, window.innerHeight - rest.bottom);
            let bottom = start;
            for (let pass = 0; pass < 12; pass += 1) {
              const over = controls.find((rect) => window.innerHeight - rect.top > bottom + 0.5 && window.innerHeight - rect.bottom < bottom + rest.height);
              if (!over) break;
              bottom = window.innerHeight - over.top + 8;
            }
            // Only a toast that would stand on a control is moved from where the band puts it.
            if (bottom > start) {
              if (bottom <= window.innerHeight / 2) inset = Math.round(bottom);
              else if (surfaceTop >= rest.height + 16) inset = Math.round(window.innerHeight - surfaceTop + 8);
            }
          }
        }
        const now = performance.now();
        const settled = placedAt !== null && now - placedAt >= ACTION_ARMED_MS;
        placedAt ??= now;
        // A few pixels (a control re-rendering in the band) is not a move: a tap aimed at the toast still lands on it.
        const beside = besidePanel(node) ?? toastHome();
        setLift((current) => current.inset === inset && current.beside?.left === beside?.left && current.beside?.width === beside?.width ? current
          : { inset, beside, movedAt: settled && (Math.abs(inset - current.inset) >= MOVE_PX || Math.abs((beside?.left ?? 0) - (current.beside?.left ?? 0)) >= MOVE_PX) ? now : current.movedAt });
        // A surface's content that is still moving (a panel taking the place of another enters a few pixels low and settles) is measured
        // where it is going, not where it was: no DOM change follows its last frame, so measure again when each such motion ends (#1106).
        for (const animation of document.getAnimations()) {
          const effect = animation.effect;
          const target = effect instanceof KeyframeEffect ? effect.target : null;
          if (animation.playState === 'running' && target?.closest('[aria-modal="true"]') && effect!.getComputedTiming().iterations !== Infinity) animation.finished.then(measure, () => undefined);
        }
      });
    };
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'data-state', 'data-height'] });
    // The stack also stands above the edges other controls publish on the root (a composer in the sheet, edgeInset.ts), and where it
    // stands is what is measured against the sheet's controls: a composer whose edge is published after the sheet has settled moves the
    // stack, so the place is measured again (WebKit: the toast stood on the link above a decision's composer, test_connected_flow 08).
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', measure);
    // The first toast is drawn where it belongs (over the work beside a panel, under the Inbox's open item), never first at the window's
    // centre and a frame later there (founder check, Hubert 2026-11-18: it appeared off centre and jumped): placed before the first paint,
    // on the node, as `measure` then keeps it in state on its frame.
    const node = stack.current;
    const first = besidePanel(node) ?? toastHome();
    if (node && first) { node.style.setProperty('--toast-left', `${first.left}px`); node.style.setProperty('--toast-max', `${first.width}px`); }
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [active, stack]);
  return active ? lift : { inset: 0, movedAt: lift.movedAt, beside: null };
}

/** Short confirmations and recoverable errors, announced politely, bottom centre, one at a time: a newer one replaces the older. */
export function ToastProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string | null }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const stack = useRef<HTMLDivElement>(null);
  const [toastTop, setToastTop] = useState<number | null>(null);
  const [scope, setScope] = useState({ key: scopeKey, epoch: 0 });
  if (scope.key !== scopeKey) setScope({ key: scopeKey, epoch: scope.epoch + 1 });
  const sessionEpoch = scope.epoch;
  const committedSession = useRef({ key: scopeKey, epoch: sessionEpoch });
  const actions = useRef(new Map<number, () => void>());
  /** Every toast shown and not yet ended, so each one's `onLeave` runs once, whatever takes it away (#1424). */
  const live = useRef(new Map<number, ToastEntry>());
  const end = useCallback((entry: ToastEntry) => {
    live.current.delete(entry.id);
    if (entry.done.ended) return;
    entry.done.ended = true;
    if (!entry.done.acted) entry.done.onLeave?.();
  }, []);
  useLayoutEffect(() => {
    committedSession.current = { key: scopeKey, epoch: sessionEpoch };
    actions.current.clear();
    // Another session's toasts are gone with it: what they held is sent now.
    for (const entry of [...live.current.values()]) if (entry.sessionEpoch !== sessionEpoch) end(entry);
  }, [scopeKey, sessionEpoch, end]);
  useEffect(() => () => { for (const entry of [...live.current.values()]) end(entry); }, [end]);
  // Another place (founder decision, 2026-11-14, #1424): an Undo toast leaves the moment the address changes, so `Z` never
  // undoes there what was done here. Toasts without Undo keep their own short time.
  const { pathname } = useLocation();
  const shownAt = useRef(pathname);
  const leaveUndo = useCallback(() => setToasts((current) => current.some((toast) => toast.undo && !toast.leaving)
    ? current.map((toast) => (toast.undo && !toast.leaving ? { ...toast, leaving: true } : toast)) : current), []);
  useLayoutEffect(() => {
    if (shownAt.current === pathname) return;
    shownAt.current = pathname;
    leaveUndo();
  }, [pathname, leaveUndo]);
  const isCurrent = useCallback(() => committedSession.current.epoch === sessionEpoch && committedSession.current.key === scopeKey, [scopeKey, sessionEpoch]);
  const show = useCallback((options: ToastOptions) => {
    if (!isCurrent()) { options.onLeave?.(); return () => {}; }
    const tone = options.tone ?? 'neutral';
    const actionEpoch = sessionEpoch;
    const done: ToastEntry['done'] = { acted: false, ended: false, onLeave: options.onLeave ?? null };
    const action = options.action ? {
      ...options.action,
      onClick: () => { done.acted = true; if (isCurrent() && committedSession.current.epoch === actionEpoch) options.action!.onClick(); },
    } : null;
    const also = options.also ? {
      ...options.also,
      onClick: () => { if (isCurrent() && committedSession.current.epoch === actionEpoch) options.also!.onClick(); },
    } : null;
    const undo = options.action?.key === 'Z' || options.action?.undoes === true;
    const entry: ToastEntry = {
      id: nextId.current++, message: options.message, tone, action, also, mascot: options.mascot ?? null, undo,
      // One rule for Undo (#1424): 10 s, paused while hovered or focused. An Open-style action leaves on its own too (CW-5); errors stay.
      timeout: undo ? UNDO_MS : tone === 'danger' ? null : options.timeout ?? (action ? ACTION_TIMEOUT_MS : 5000),
      leaving: false, sessionEpoch: actionEpoch, done,
    };
    live.current.set(entry.id, entry);
    // One toast at a time (v0.2 visual review): a newer toast takes the place of the one shown, which leaves at once with its
    // action. Its change stays made: every change is applied when its toast shows, and a delayed one (Accept, Answer) is sent
    // when its toast leaves (#1424). Stacked toasts covered a phone's work (a column's head) after a few quick changes.
    setToasts((current) => [...current.filter((toast) => toast.sessionEpoch === actionEpoch)
      .map((toast) => (toast.leaving ? toast : { ...toast, leaving: true })), entry]);
    return () => { end(entry); setToasts((current) => current.filter((toast) => toast.id !== entry.id)); };
  }, [isCurrent, sessionEpoch, end]);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const registerAction = useCallback((id: number, run: (() => void) | null) => {
    if (run) actions.current.set(id, run); else actions.current.delete(id);
  }, []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (isTyping(target) || target?.closest('[role="menu"]')) return;
      const newest = [...actions.current.keys()].sort((a, b) => b - a)[0];
      if (newest === undefined) return;
      event.preventDefault();
      actions.current.get(newest)?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const value = useMemo(() => show, [show]);
  const visible = toasts.filter((toast) => toast.sessionEpoch === sessionEpoch);
  const lift = useModalLift(visible.length > 0, stack);
  useLayoutEffect(() => {
    const node = stack.current;
    if (!node) return;
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      setToastTop(bounds.height > 0 ? bounds.top : null);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [sessionEpoch, visible.length]);
  return (
    <ToastStackContext.Provider value={stack}><ToastTopContext.Provider value={toastTop}><ToastScopeContext.Provider value={isCurrent}><ToastContext.Provider value={value}><LeaveUndoContext.Provider value={leaveUndo}>
      {children}
      {createPortal(
        <div ref={stack} className={`ui-toasts${lift.beside ? ' ui-toasts--beside' : ''}`} role="status" aria-live="polite" aria-relevant="additions text"
          style={lift.inset || lift.beside ? { ...(lift.inset ? { '--toast-modal-inset': `${lift.inset}px` } : {}),
            ...(lift.beside ? { '--toast-left': `${lift.beside.left}px`, '--toast-max': `${lift.beside.width}px` } : {}) } as CSSProperties : undefined}>
          {visible.map((toast) => <ToastItem key={toast.id} toast={toast} onDone={remove} onLeaving={end} registerAction={registerAction} movedAt={lift.movedAt} />)}
        </div>,
        document.body,
      )}
    </LeaveUndoContext.Provider></ToastContext.Provider></ToastScopeContext.Provider></ToastTopContext.Provider></ToastStackContext.Provider>
  );
}
