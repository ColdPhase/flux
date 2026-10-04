import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type AccentChoice = 'mint' | 'sky' | 'copper';
type ResolvedTheme = 'light' | 'dark';
const LEGACY_ACCENT_KEY = 'flux.accent';
const accentKey = (theme: ResolvedTheme) => `flux.accent.${theme}`;
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

function validAccent(value: string | null): value is AccentChoice {
  return value === 'mint' || value === 'sky' || value === 'copper';
}

function readAccents(): Record<ResolvedTheme, AccentChoice> {
  try {
    const legacy = localStorage.getItem(LEGACY_ACCENT_KEY);
    const migrated: AccentChoice = legacy === 'iris' || legacy === 'sky' ? 'sky' : 'mint';
    const result: Record<ResolvedTheme, AccentChoice> = { light: 'mint', dark: 'mint' };
    const missing: ResolvedTheme[] = [];
    for (const theme of ['light', 'dark'] as const) {
      const value = localStorage.getItem(accentKey(theme));
      result[theme] = validAccent(value) ? value : value === null ? migrated : 'mint';
      if (value === null) missing.push(theme);
    }
    // Read both slots before writing: refused persistence must not reset valid
    // readable choices, and the original key stays intact for older clients.
    for (const theme of missing) {
      try {
        if (localStorage.getItem(accentKey(theme)) === null) localStorage.setItem(accentKey(theme), result[theme]);
      } catch { /* visit-local */ }
    }
    return result;
  } catch {
    return { light: 'mint', dark: 'mint' };
  }
}

let accents: Record<ResolvedTheme, AccentChoice> = typeof window === 'undefined' ? { light: 'mint', dark: 'mint' } : readAccents();
let current: ThemeChoice = typeof window === 'undefined' ? 'system' : read();
const systemTheme = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)');
let listening = false;

function resolvedTheme(): ResolvedTheme {
  return current === 'system' ? systemTheme?.matches ? 'dark' : 'light' : current;
}

function publish() {
  document.documentElement.dataset.accent = accents[resolvedTheme()];
  listeners.forEach((listener) => listener());
}

/**
 * Theme and accent changes switch every colour at once: transitions are paused for two frames so
 * nothing cross-fades through an unreadable mix of the old and new palette.
 */
function settleInstantly() {
  const root = document.documentElement;
  root.dataset.themeSwitching = '';
  requestAnimationFrame(() => requestAnimationFrame(() => { delete root.dataset.themeSwitching; }));
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** Applies the stored choice before the first render so there is no flash of the other theme. */
export function applyStoredTheme() {
  current = read();
  apply(current);
  accents = readAccents();
  publish();
  if (!listening) {
    listening = true;
    systemTheme?.addEventListener('change', () => { if (current === 'system') { settleInstantly(); publish(); } });
    window.addEventListener('storage', (event) => {
      if (event.key === null || [KEY, LEGACY_ACCENT_KEY, accentKey('light'), accentKey('dark')].includes(event.key)) {
        current = read();
        accents = readAccents();
        settleInstantly();
        apply(current);
        publish();
      }
    });
  }
}

export function setTheme(choice: ThemeChoice) {
  current = choice;
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private windows may refuse storage; the choice still applies for this visit.
  }
  settleInstantly();
  apply(choice);
  publish();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => 'system',
  );
}

export function setAccent(choice: AccentChoice) {
  const theme = resolvedTheme();
  accents[theme] = choice;
  try { localStorage.setItem(accentKey(theme), choice); } catch {
    // Storage may be unavailable; retain the appearance for this visit.
  }
  settleInstantly();
  publish();
}

export function useAccent(): AccentChoice {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => accents[resolvedTheme()],
    () => 'mint',
  );
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    resolvedTheme,
    () => 'light',
  );
}
