import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { duration, play } from './motion';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Milliseconds before it leaves on its own; errors stay until dismissed. */
  timeout?: number;
  /** A quiet action after the message (e.g. Hand back); it stays until dismissed or used (#347 review N1). */
  action?: { label: string; onAction: () => void };
}

interface ToastEntry extends Required<Omit<ToastOptions, 'timeout' | 'action'>> {
  id: number;
  timeout: number | null;
  leaving: boolean;
  action: ToastOptions['action'];
}

const ToastContext = createContext<(options: ToastOptions) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
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
      {toast.action ? <button type="button" className="ui-link ui-toast__action" onClick={() => { toast.action!.onAction(); dismiss(); }}>{toast.action.label}</button> : null}
      <button type="button" className="ui-toast__close" onClick={dismiss} aria-label="Dismiss notification"><Icon name="x" size={14} /></button>
    </div>
  );
}

/** Short confirmations and recoverable errors, announced politely, bottom centre, one at a time on top. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const show = useCallback((options: ToastOptions) => {
    const tone = options.tone ?? 'neutral';
    const entry: ToastEntry = { id: nextId.current++, message: options.message, tone, action: options.action,
      timeout: options.timeout ?? (tone === 'danger' || options.action ? null : 5000), leaving: false };
    // Keep at most three; older ones leave.
    setToasts((current) => [...current.slice(-2), entry]);
  }, []);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="ui-toasts" role="status" aria-live="polite" aria-relevant="additions text">
          {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDone={remove} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
