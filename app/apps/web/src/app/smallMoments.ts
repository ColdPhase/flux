import { useSyncExternalStore } from 'react';

// Kreska's small moments (F-026 §3): splash, loading, thinking, empty Inbox, offline, no results,
// pull to refresh, goal reached and the task-closed toast. On by default; Settings → Appearance
// turns them off on this device. Moments read `useSmallMoments()` (or `[data-kreska="off"]` on
// the root in CSS) and show their plain text state when it is off (#352).

const KEY = 'flux.kreska';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

let current = typeof window === 'undefined' ? true : read();
let listening = false;

function apply(on: boolean) {
  const root = document.documentElement;
  if (on) delete root.dataset.kreska;
  else root.dataset.kreska = 'off';
}

/** Applies the stored choice before the first render, and follows other tabs. */
export function applyStoredSmallMoments() {
  current = read();
  apply(current);
  if (!listening) {
    listening = true;
    window.addEventListener('storage', (event) => {
      if (event.key === null || event.key === KEY) {
        current = read();
        apply(current);
        listeners.forEach((listener) => listener());
      }
    });
  }
}

export function setSmallMoments(on: boolean) {
  current = on;
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // Private windows may refuse storage; the choice still applies for this visit.
  }
  apply(on);
  listeners.forEach((listener) => listener());
}

/** True while Kreska may appear in small moments on this device. */
export function useSmallMoments(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => true,
  );
}
