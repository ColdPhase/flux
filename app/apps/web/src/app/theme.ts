import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type AccentChoice = 'mint' | 'iris' | 'sky';
const ACCENT_KEY = 'flux.accent';
const KEY = 'flux.theme';
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function readAccent(): AccentChoice {
  try {
    const value = localStorage.getItem(ACCENT_KEY);
    return value === 'iris' || value === 'sky' ? value : 'mint';
  } catch {
    return 'mint';
  }
}

let accent: AccentChoice = typeof window === 'undefined' ? 'mint' : readAccent();

let current: ThemeChoice = typeof window === 'undefined' ? 'system' : read();

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** Applies the stored choice before the first render so there is no flash of the other theme. */
export function applyStoredTheme() {
  current = read();
  apply(current);
  accent = readAccent();
  document.documentElement.dataset.accent = accent;
}

export function setTheme(choice: ThemeChoice) {
  current = choice;
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private windows may refuse storage; the choice still applies for this visit.
  }
  apply(choice);
  listeners.forEach((listener) => listener());
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => 'system',
  );
}

export function setAccent(choice: AccentChoice) {
  accent = choice;
  try { localStorage.setItem(ACCENT_KEY, choice); } catch {
    // Storage may be unavailable; retain the appearance for this visit.
  }
  document.documentElement.dataset.accent = choice;
  listeners.forEach((listener) => listener());
}

export function useAccent(): AccentChoice {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => accent,
    () => 'mint',
  );
}
