import { useSyncExternalStore } from 'react';

// The person's own "Reduce motion" choice (Settings → Appearance, F-026 §2 and §9). It lives in the
// ui layer because motion.ts reads it. It only ever adds reduction: a stored "off" never overrides
// the operating system's reduced-motion setting, so `prefersReducedMotion()` is true when either asks.
// The root carries `data-motion="reduce"` while the choice is on; ui.css and tokens.css turn every
// duration to 0 for that attribute, exactly as they do for the system setting.

const KEY = 'flux.reduceMotion';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

let stored = typeof window === 'undefined' ? false : read();

function apply(on: boolean) {
  const root = document.documentElement;
  if (on) root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
}

let listening = false;

/**
 * Applies the stored choice before the first render, as applyStoredSmallMoments does, and follows other
 * tabs of this browser: a choice made in Settings there stops motion already running here (#452 review).
 */
export function applyStoredReduceMotion() {
  stored = read();
  apply(stored);
  if (!listening) {
    listening = true;
    window.addEventListener('storage', (event) => {
      if (event.key === null || event.key === KEY) {
        stored = read();
        apply(stored);
        listeners.forEach((listener) => listener());
      }
    });
  }
}

export function setReduceMotion(on: boolean) {
  stored = on;
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // Private windows may refuse storage; the choice still applies for this visit.
  }
  apply(on);
  listeners.forEach((listener) => listener());
}

/** The stored choice (not the system setting) for the Settings switch. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => stored,
    () => false,
  );
}

/** True when script-driven motion must stop: the person's choice, or the system's reduced-motion setting. */
export function prefersReducedMotion(): boolean {
  if (stored) return true;
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
