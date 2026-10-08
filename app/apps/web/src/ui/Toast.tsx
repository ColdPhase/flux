import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Kreska } from './Kreska';
import { duration, play } from './motion';

export type ToastTone = 'neutral' | 'success' | 'danger';

/** One quick way back (F-026 S9/S11): the button, and `Z` while the toast is up. */
export interface ToastAction {
  label: string;
  onAction: () => void;
  /** Shown beside the label as the key that does the same; only `Z` is wired. */
  key?: 'Z';
}

export interface ToastOptions {
  message: string;
  action?: ToastAction;
  tone?: ToastTone;
  /** Milliseconds before it leaves on its own; errors stay until dismissed. */
  timeout?: number;
}

interface ToastEntry extends Required<Omit<ToastOptions, 'timeout' | 'action'>> {
  action: ToastAction | null;
  id: number;
  timeout: number | null;
  leaving: boolean;
}

const ToastContext = createContext<(options: ToastOptions) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

function ToastItem({ toast, onDone, registerAction }: { toast: ToastEntry; onDone: (id: number) => void; registerAction: (id: number, run: (() => void) | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  const dismiss = useCallback(() => setLeaving(true), []);
  const act = useCallback(() => { if (!toast.action) return; toast.action.onAction(); setLeaving(true); }, [toast.action]);
  // `Z` runs the newest toast's action once; a toast that is leaving no longer answers to it.
  useEffect(() => {
    if (!toast.action || leaving) return undefined;
    registerAction(toast.id, act);
    return () => registerAction(toast.id, null);
  }, [toast.action, toast.id, leaving, act, registerAction]);
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
      {toast.tone === 'success' ? <Icon name="check" /> : toast.tone === 'danger' ? <Icon name="alert" /> : toast.action ? <Kreska size={24} expression="done" /> : null}
      <span className="ui-toast__msg">{toast.message}</span>
      {toast.action ? (
        <>
          <span className="ui-toast__sep" aria-hidden="true" />
          <button type="button" className="ui-toast__action" onClick={act} aria-keyshortcuts={toast.action.key}>
            {toast.action.label}{toast.action.key ? <kbd aria-hidden="true">{toast.action.key}</kbd> : null}
          </button>
        </>
      ) : null}
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
    const entry: ToastEntry = { id: nextId.current++, message: options.message, tone, timeout: options.timeout ?? (tone === 'danger' ? null : options.action ? 7000 : 5000), leaving: false, action: options.action ?? null };
    // Keep at most three; older ones leave.
    setToasts((current) => [...current.slice(-2), entry]);
  }, []);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const actions = useRef(new Map<number, () => void>());
  const registerAction = useCallback((id: number, run: (() => void) | null) => {
    if (run) actions.current.set(id, run); else actions.current.delete(id);
  }, []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const newest = [...actions.current.keys()].sort((a, b) => b - a)[0];
      if (newest === undefined) return;
      event.preventDefault();
      actions.current.get(newest)?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="ui-toasts" role="status" aria-live="polite" aria-relevant="additions text">
          {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDone={remove} registerAction={registerAction} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
