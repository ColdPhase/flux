import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Kreska } from './Kreska';
import { duration, play } from './motion';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Milliseconds before it leaves on its own; errors stay until dismissed. */
  timeout?: number;
  /** One quiet action beside the message, e.g. Undo or Hand back. Taking it closes the toast. */
  action?: { label: string; onClick: () => void; key?: 'Z' };
}

interface ToastEntry extends Required<Omit<ToastOptions, 'timeout' | 'action'>> {
  action: ToastOptions['action'] | null;
  id: number;
  timeout: number | null;
  leaving: boolean;
  sessionEpoch: number;
}

const ToastContext = createContext<(options: ToastOptions) => () => void>(() => () => {});

export function useToast() {
  return useContext(ToastContext);
}

function ToastItem({ toast, onDone, registerAction }: { toast: ToastEntry; onDone: (id: number) => void; registerAction: (id: number, run: (() => void) | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const dismiss = useCallback(() => setLeaving(true), []);
  const ran = useRef(false);
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
      {toast.action && !leaving && !toast.leaving ? (
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
export function ToastProvider({ children, sessionId }: { children: ReactNode; sessionId: string | null }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const [session, setSession] = useState(() => ({ id: sessionId, epoch: 0 }));
  const sessionEpoch = session.id === sessionId ? session.epoch : session.epoch + 1;
  if (session.id !== sessionId) setSession({ id: sessionId, epoch: sessionEpoch });
  const committedSession = useRef({ id: sessionId, epoch: sessionEpoch });
  const actions = useRef(new Map<number, () => void>());
  useLayoutEffect(() => {
    committedSession.current = { id: sessionId, epoch: sessionEpoch };
    actions.current.clear();
  }, [sessionId, sessionEpoch]);
  const show = useCallback((options: ToastOptions) => {
    const tone = options.tone ?? 'neutral';
    const actionEpoch = committedSession.current.epoch;
    const action = options.action ? {
      ...options.action,
      onClick: () => { if (committedSession.current.epoch === actionEpoch) options.action!.onClick(); },
    } : null;
    const entry: ToastEntry = { id: nextId.current++, message: options.message, tone, timeout: options.timeout ?? (tone === 'danger' || action ? null : 5000), leaving: false, action, sessionEpoch: actionEpoch };
    setToasts((current) => [...current.slice(-2), entry]);
    return () => setToasts((current) => current.filter((toast) => toast.id !== entry.id));
  }, []);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
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
  const visibleToasts = toasts.filter((toast) => toast.sessionEpoch === sessionEpoch);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="ui-toasts" role="status" aria-live="polite" aria-relevant="additions text">
          {visibleToasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDone={remove} registerAction={registerAction} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
