import { createContext, type CSSProperties, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Kreska, type KreskaExpression } from './Kreska';
import { duration, settle } from './motion';
import { useSmallMoments } from './smallMoments';
import './moments.css';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
  key?: 'Z';
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Milliseconds before it leaves on its own; errors stay until dismissed. `null` keeps an undo-like action (Hand back)
   *  until it is used or dismissed, as Undo stays (#347 N1). */
  timeout?: number | null;
  /** One quiet action beside the message, e.g. Undo or Hand back. Taking it closes the toast. */
  action?: ToastAction;
  /** A small moment: the wink after a task is closed. Shown only while Small moments is on; the message says it all. */
  mascot?: KreskaExpression;
}

interface ToastEntry extends Required<Omit<ToastOptions, 'timeout' | 'action' | 'mascot'>> {
  mascot: KreskaExpression | null;
  id: number;
  action: ToastOptions['action'] | null;
  timeout: number | null;
  leaving: boolean;
  sessionEpoch: number;
}

/** How long a toast with an Open-style action stays (CW-5). */
const ACTION_TIMEOUT_MS = 8000;
/** A toast's action ignores a tap this soon after the toasts moved: the tap was meant for what was there. */
const ACTION_ARMED_MS = 600;
/** How far the toasts must move for the tap guard: about half a toast, so a tap aimed elsewhere could land on one. */
const MOVE_PX = 24;

const ToastContext = createContext<(options: ToastOptions) => () => void>(() => () => {});
const ToastScopeContext = createContext<() => boolean>(() => true);
const ToastTopContext = createContext<number | null>(null);

/** Actual top of the rendered feedback stack, or null while no feedback is shown. */
export function useToastTop() { return useContext(ToastTopContext); }

export function useToast() {
  return useContext(ToastContext);
}

/** A captured action/result remains current only within this provider's original session epoch. */
export function useToastScope() {
  return useContext(ToastScopeContext);
}

function ToastItem({ toast, onDone, registerAction, movedAt }: { toast: ToastEntry; onDone: (id: number) => void; registerAction: (id: number, run: (() => void) | null) => void; movedAt: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLSpanElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const timer = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ran = useRef(false);
  const moments = useSmallMoments();
  const dismiss = useCallback(() => setLeaving(true), []);
  const act = useCallback((event?: { detail: number }) => {
    if (!toast.action || ran.current || leaving || toast.leaving) return;
    // A pointer tap that lands just as the toasts moved (above a sheet that opened) was aimed at what was there (CW-5).
    if (event && event.detail > 0 && performance.now() - movedAt < ACTION_ARMED_MS) return;
    ran.current = true;
    toast.action.onClick();
    dismiss();
  }, [toast.action, leaving, toast.leaving, dismiss, movedAt]);
  useEffect(() => {
    if (!toast.action?.key || leaving || toast.leaving) return undefined;
    registerAction(toast.id, () => act());
    return () => registerAction(toast.id, null);
  }, [toast.action, toast.id, leaving, toast.leaving, act, registerAction]);
  const arm = useCallback(() => {
    if (toast.timeout !== null) timer.current = window.setTimeout(dismiss, toast.timeout);
  }, [dismiss, toast.timeout]);
  const disarm = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };

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
    void settle(ref.current, { opacity: 1, transform: 'none' }, duration('--dur-in'), '--ease-out', { from: { opacity: 0, transform: 'translateY(8px) scale(.98)' } });
    arm();
    return disarm;
  }, [arm]);

  useEffect(() => {
    if (!leaving && !toast.leaving) return;
    // A toast dismissed while it arrives leaves from where it is; it is gone in --dur-out and never held.
    void settle(ref.current, { opacity: 0, transform: 'translateY(4px)' }, duration('--dur-out'), '--ease-in', { from: { opacity: 1, transform: 'none' }, fill: 'forwards' })
      .then(() => onDone(toast.id));
  }, [leaving, toast.leaving, toast.id, onDone]);

  return (
    <div ref={ref} className={`ui-toast ui-toast--${toast.tone}${scrollable ? ' ui-toast--scrollable' : ''}`} onMouseEnter={disarm} onMouseLeave={arm} onFocus={disarm} onBlur={arm}>
      {toast.mascot && moments ? <Kreska expression={toast.mascot} size={24} /> : toast.tone === 'success' ? <Icon name="check" /> : toast.tone === 'danger' ? <Icon name="alert" /> : null}
      <span ref={message} className="ui-toast__msg" tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? 'region' : undefined} aria-label={scrollable ? 'Notification message' : undefined}>{toast.message}</span>
      {toast.action && !leaving && !toast.leaving ? (
        <>
          <span className="ui-toast__sep" aria-hidden="true" />
          <button type="button" className="ui-toast__action" onClick={(event) => act(event)} aria-keyshortcuts={toast.action.key} title={toast.action.key ? `${toast.action.label} (${toast.action.key})` : undefined}>
            {toast.action.label}{toast.action.key ? <kbd aria-hidden="true">{toast.action.key}</kbd> : null}
          </button>
        </>
      ) : null}
      <button type="button" className="ui-toast__close" onClick={dismiss} aria-label="Dismiss notification"><Icon name="x" size={14} /></button>
    </div>
  );
}

/**
 * CW-5: while a dialog or sheet is open, toasts sit above its lowest controls (Next, Cancel, Save…), so a tap meant for
 * them never lands on a toast. Measured from the open modal surfaces while any toast shows; `movedAt` is when that last
 * changed, for the action's tap guard.
 */
function useModalLift(active: boolean): { inset: number; movedAt: number } {
  const [lift, setLift] = useState({ inset: 0, movedAt: -Infinity });
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
        for (const surface of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
          const box = surface.getBoundingClientRect();
          if (!box.height || box.bottom < window.innerHeight - 160) continue;
          // The surface's footer actions, where they reach the band at the bottom of the screen that toasts use.
          for (const control of surface.querySelectorAll<HTMLElement>('button, a[href], [role="button"], input, select, textarea')) {
            const rect = control.getBoundingClientRect();
            if (rect.height && rect.bottom > Math.max(box.bottom - 120, window.innerHeight - 160) && rect.top < window.innerHeight) top = Math.min(top, rect.top);
          }
        }
        const inset = Number.isFinite(top) ? Math.max(0, Math.round(window.innerHeight - top + 8)) : 0;
        const now = performance.now();
        const settled = placedAt !== null && now - placedAt >= ACTION_ARMED_MS;
        placedAt ??= now;
        // A few pixels (a control re-rendering in the band) is not a move: a tap aimed at the toast still lands on it.
        setLift((current) => current.inset === inset ? current
          : { inset, movedAt: settled && Math.abs(inset - current.inset) >= MOVE_PX ? now : current.movedAt });
      });
    };
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'data-state', 'data-height'] });
    window.addEventListener('resize', measure);
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [active]);
  return active ? lift : { inset: 0, movedAt: lift.movedAt };
}

/** Short confirmations and recoverable errors, announced politely, bottom centre, one at a time on top. */
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
  useLayoutEffect(() => {
    committedSession.current = { key: scopeKey, epoch: sessionEpoch };
    actions.current.clear();
  }, [scopeKey, sessionEpoch]);
  const isCurrent = useCallback(() => committedSession.current.epoch === sessionEpoch && committedSession.current.key === scopeKey, [scopeKey, sessionEpoch]);
  const show = useCallback((options: ToastOptions) => {
    if (!isCurrent()) return () => {};
    const tone = options.tone ?? 'neutral';
    const actionEpoch = sessionEpoch;
    const action = options.action ? {
      ...options.action,
      onClick: () => { if (isCurrent() && committedSession.current.epoch === actionEpoch) options.action!.onClick(); },
    } : null;
    const entry: ToastEntry = {
      id: nextId.current++, message: options.message, tone, action, mascot: options.mascot ?? null,
      // An action that is not Undo (Open, Open task…) leaves on its own too (CW-5); Undo keeps its own window, errors stay.
      timeout: options.timeout !== undefined ? options.timeout : (tone === 'danger' || options.action?.key === 'Z' ? null : action ? ACTION_TIMEOUT_MS : 5000),
      leaving: false, sessionEpoch: actionEpoch,
    };
    setToasts((current) => [...current.slice(-2), entry]);
    return () => setToasts((current) => current.filter((toast) => toast.id !== entry.id));
  }, [isCurrent, sessionEpoch]);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const registerAction = useCallback((id: number, run: (() => void) | null) => {
    if (run) actions.current.set(id, run); else actions.current.delete(id);
  }, []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [role="combobox"], [role="listbox"], [contenteditable="true"], [role="textbox"], [role="menu"]')) return;
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
  const lift = useModalLift(visible.length > 0);
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
    <ToastTopContext.Provider value={toastTop}><ToastScopeContext.Provider value={isCurrent}><ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div ref={stack} className="ui-toasts" style={lift.inset ? { '--toast-modal-inset': `${lift.inset}px` } as CSSProperties : undefined} role="status" aria-live="polite" aria-relevant="additions text">
          {visible.map((toast) => <ToastItem key={toast.id} toast={toast} onDone={remove} registerAction={registerAction} movedAt={lift.movedAt} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider></ToastScopeContext.Provider></ToastTopContext.Provider>
  );
}
