import { useSyncExternalStore } from 'react';

// Text size on the computer (Settings → Appearance, F-026 §2 and S17): Small, Default or Large. The
// type tokens are in rem, so the root size scales them (tokens.css). The phone keeps following the
// system text size and has no control, so the choice is stored per device and applied only on
// screens wider than the phone breakpoint (`data-text-size` on the root; absent for Default).

export type TextSize = 'small' | 'default' | 'large';
const KEY = 'flux.textSize';
const listeners = new Set<() => void>();

function read(): TextSize {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'small' || value === 'large' ? value : 'default';
  } catch {
    return 'default';
  }
}

let current: TextSize = typeof window === 'undefined' ? 'default' : read();

function apply(size: TextSize) {
  const root = document.documentElement;
  if (size === 'default') delete root.dataset.textSize;
  else root.dataset.textSize = size;
}

/** Applies the stored size before the first render, as applyStoredSmallMoments does. */
export function applyStoredTextSize() {
  current = read();
  apply(current);
}

export function setTextSize(size: TextSize) {
  current = size;
  try {
    if (size === 'default') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, size);
  } catch {
    // Private windows may refuse storage; the choice still applies for this visit.
  }
  apply(size);
  listeners.forEach((listener) => listener());
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => 'default',
  );
}
