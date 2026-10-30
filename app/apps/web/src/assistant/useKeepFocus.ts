import { useCallback, useEffect, useRef } from 'react';

const SETTLE_MS = 1500;

/**
 * A person at the keyboard who presses a button that then goes away (Stop, Retry, Accept, Undo) must not be left on the page
 * with nothing to operate (#68 AC-8, keyboard focus). `ref` goes on `home`, the part of the screen the button belongs to, which
 * also needs `tabIndex={-1}`. When the press was inside `home`, focus moves to `home` as soon as the screen has changed and nothing
 * else holds it, so the next Tab continues from the same place. `fallback` names the next best place when `home` itself went away
 * with the button. The change may land after the action's own promise (a stream update, a refetch), and engines order frames and
 * renders differently, so the screen is watched for a moment rather than read once.
 */
export function useKeepFocus<T extends HTMLElement>(fallback?: () => HTMLElement | null) {
  const node = useRef<T | null>(null);
  const spare = useRef(fallback);
  useEffect(() => { spare.current = fallback; });
  const watching = useRef<(() => void) | null>(null);
  useEffect(() => () => watching.current?.(), []);
  const ref = useCallback((element: T | null) => { node.current = element; }, []);
  /** Whether focus is inside `home` right now. */
  const holds = useCallback(() => !!node.current && node.current.contains(document.activeElement), []);
  const lost = () => { const active = document.activeElement; return !active || active === document.body || active === document.documentElement; };
  const rescue = useCallback(() => {
    if (!lost()) return false;
    const target = node.current?.isConnected ? node.current : spare.current?.() ?? null;
    if (!target) return false;
    target.focus({ preventScroll: true });
    return !lost();
  }, []);
  const keep = useCallback(async <R>(action: () => Promise<R>): Promise<R> => {
    const inside = holds();
    try {
      return await action();
    } finally {
      if (inside) {
        watching.current?.();
        const watcher = new MutationObserver(() => { if (rescue()) stop(); });
        const timer = window.setTimeout(() => stop(), SETTLE_MS);
        const stop = () => { watcher.disconnect(); window.clearTimeout(timer); watching.current = null; };
        watching.current = stop;
        watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert'] });
        requestAnimationFrame(() => { if (rescue()) stop(); });
      }
    }
  }, [holds, rescue]);
  return { ref, holds, keep };
}
