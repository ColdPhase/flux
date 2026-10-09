import { useSyncExternalStore } from 'react';

/**
 * Kreska's small moments (F-026 §3): the mascot in the splash, loading, empty and offline screens and in
 * the toast after a task is closed. Settings → Appearance turns every one of them off for this device,
 * which leaves the plain text states. On by default; the text always carries the meaning.
 */
const KEY = 'flux.kreska';
const listeners = new Set<() => void>();

function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

let current = typeof window === 'undefined' ? true : read();

function publish() {
  if (typeof document !== 'undefined') {
    if (current) delete document.documentElement.dataset.kreska;
    else document.documentElement.dataset.kreska = 'off';
  }
  listeners.forEach((listener) => listener());
}

export function setMoments(on: boolean) {
  current = on;
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off'); } catch { /* private windows keep it for this visit */ }
  publish();
}

/** Applies the stored choice before the first render (the splash in index.html reads the same key). */
export function applyStoredMoments() {
  current = read();
  publish();
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === KEY) { current = read(); publish(); }
  });
}

export function useMoments(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => true,
  );
}

/** A goal's moment plays once: the person has seen it for this goal on this device. */
export function goalMomentSeen(goalId: string): boolean {
  try { return localStorage.getItem(`flux.goal.${goalId}`) === '1'; } catch { return true; }
}

export function markGoalMomentSeen(goalId: string) {
  try { localStorage.setItem(`flux.goal.${goalId}`, '1'); } catch { /* without storage it is not repeated this visit either: the caller holds the state */ }
}
