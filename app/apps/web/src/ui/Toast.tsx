import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Kreska, type KreskaExpression } from './Kreska';
import { duration, play } from './motion';
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
  /** Milliseconds before it leaves on its own; errors stay until dismissed. */
  timeout?: number;
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

function ToastItem({ toast, onDone, registerAction }: { toast: ToastEntry; onDone: (id: number) => void; registerAction: (id: number, run: (() => void) | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLSpanElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const timer = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ran = useRef(false);
  const moments = useSmallMoments();
  const dismiss = useCallback(() => setLeaving(true), []);
  const act = useCallback(() => {
    if (!toast.action || ran.current || leaving || toast.leaving) return;
    ran.current = true;
    toast.action.onClick();
    dismiss();
  }, [toast.action, leaving, toast.leaving, dismiss]);
  useEffect(() => {
    if (!toast.action?.key || leaving || toast.leaving) return undefined;
    registerAction(toast.id, act);
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
    void play(ref.current, [{ opacity: 0, transform: 'translateY(8px) scale(.98)' }, { opacity: 1, transform: 'none' }], duration('--dur-3'), '--ease-sheet', { fill: 'backwards' });
    arm();
    return disarm;
  }, [arm]);

  useEffect(() => {
    if (!leaving && !toast.leaving) return;
    void play(ref.current, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }], duration('--dur-2'), '--ease-in', { fill: 'forwards' })
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
          <button type="button" className="ui-toast__action" onClick={act} aria-keyshortcuts={toast.action.key} title={toast.action.key ? `${toast.action.label} (${toast.action.key})` : undefined}>
            {toast.action.label}{toast.action.key ? <kbd aria-hidden="true">{toast.action.key}</kbd> : null}
          </button>
        </>
      ) : null}
      <button type="button" className="ui-toast__close" onClick={dismiss} aria-label="Dismiss notification"><Icon name="x" size={14} /></button>
    </div>
  );
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
      timeout: options.timeout ?? (tone === 'danger' || action ? null : 5000),
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
      if (event.key.toLowerCase() !== 'z' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"]')) return;
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
        <div ref={stack} className="ui-toasts" role="status" aria-live="polite" aria-relevant="additions text">
          {visible.map((toast) => <ToastItem key={toast.id} toast={toast} onDone={remove} registerAction={registerAction} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider></ToastScopeContext.Provider></ToastTopContext.Provider>
  );
}
