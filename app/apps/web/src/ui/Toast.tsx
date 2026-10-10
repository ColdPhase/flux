import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { duration, play } from './motion';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Milliseconds before it leaves on its own; errors stay until dismissed. */
  timeout?: number;
  /** One button after the message, e.g. "Undo". The key Z runs the newest toast's action while it is shown. */
  action?: { label: string; onClick: () => void };
}

interface ToastEntry extends Required<Omit<ToastOptions, 'timeout' | 'action'>> {
  id: number;
  action: ToastOptions['action'] | null;
  timeout: number | null;
  leaving: boolean;
  scope: number;
}

const ToastContext = createContext<(options: ToastOptions) => void>(() => {});
const ToastScopeContext = createContext<() => boolean>(() => true);

export function useToast() {
  return useContext(ToastContext);
}

/** A captured action/result remains current only within this provider's original session epoch. */
export function useToastScope() {
  return useContext(ToastScopeContext);
}

function ToastItem({ toast, onDone }: { toast: ToastEntry; onDone: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  const dismiss = useCallback(() => setLeaving(true), []);
  const arm = useCallback(() => {
    if (toast.timeout !== null) timer.current = window.setTimeout(dismiss, toast.timeout);
  }, [dismiss, toast.timeout]);
  const disarm = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };

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
    <div ref={ref} className={`ui-toast ui-toast--${toast.tone}`} onMouseEnter={disarm} onMouseLeave={arm} onFocus={disarm} onBlur={arm}>
      {toast.tone === 'success' ? <Icon name="check" /> : toast.tone === 'danger' ? <Icon name="alert" /> : null}
      <span className="ui-toast__msg">{toast.message}</span>
      {toast.action ? (
        <button type="button" className="ui-toast__action" onClick={() => { toast.action!.onClick(); dismiss(); }}>
          {toast.action.label}{toast.action.label === 'Undo' ? <kbd aria-hidden="true">Z</kbd> : null}
        </button>
      ) : null}
      <button type="button" className="ui-toast__close" onClick={dismiss} aria-label="Dismiss notification"><Icon name="x" size={14} /></button>
    </div>
  );
}

/** Short confirmations and recoverable errors, announced politely, bottom centre, one at a time on top. */
export function ToastProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string | null }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const [scope, setScope] = useState({ key: scopeKey, epoch: 0 });
  if (scope.key !== scopeKey) setScope({ key: scopeKey, epoch: scope.epoch + 1 });
  const epoch = scope.epoch;
  const currentEpoch = useRef(epoch);
  useLayoutEffect(() => {
    currentEpoch.current = epoch;
    return () => { currentEpoch.current = -1; };
  }, [epoch]);
  const isCurrent = useCallback(() => currentEpoch.current === epoch, [epoch]);
  const show = useCallback((options: ToastOptions) => {
    if (!isCurrent()) return;
    const tone = options.tone ?? 'neutral';
    const entry: ToastEntry = { id: nextId.current++, message: options.message, tone, action: options.action ?? null, timeout: options.timeout ?? (tone === 'danger' ? null : options.action ? 8000 : 5000), leaving: false, scope: epoch };
    // Keep at most three; older ones leave.
    setToasts((current) => [...current.slice(-2), entry]);
  }, [epoch, isCurrent]);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const value = useMemo(() => show, [show]);
  // Z undoes the newest toast that offers it, unless the person is typing.
  const visible = toasts.filter((entry) => entry.scope === epoch);
  const latest = useRef(visible);
  useLayoutEffect(() => { latest.current = visible; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      const entry = [...latest.current].reverse().find((toast) => toast.action && !toast.leaving);
      if (!entry) return;
      event.preventDefault();
      entry.action!.onClick();
      setToasts((current) => current.map((toast) => toast.id === entry.id ? { ...toast, leaving: true } : toast));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <ToastScopeContext.Provider value={isCurrent}><ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="ui-toasts" role="status" aria-live="polite" aria-relevant="additions text">
          {visible.map((toast) => <ToastItem key={toast.id} toast={toast} onDone={remove} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider></ToastScopeContext.Provider>
  );
}
