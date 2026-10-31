import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
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

let current: ThemeChoice = typeof window === 'undefined' ? 'system' : read();
const systemTheme = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)');
let listening = false;

/**
 * An installed app's title bar follows the theme actually shown, not only the system setting:
 * every theme-color tag takes the page's current background (#203). The static tags in
 * index.html stay the first-paint default.
 */
function syncThemeColor() {
  const background = (element: Element) => getComputedStyle(element).backgroundColor;
  const transparent = (value: string) => !value || value === 'transparent' || /^rgba\(.*,\s*0\)$/.test(value);
  let colour = background(document.body);
  if (transparent(colour)) colour = background(document.documentElement);
  if (transparent(colour)) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = colour;
}

function publish() {
  syncThemeColor();
  listeners.forEach((listener) => listener());
}

/**
 * A theme change switches every colour at once: transitions are paused for two frames so nothing
 * cross-fades through an unreadable mix of the old and new palette.
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
  publish();
  if (!listening) {
    listening = true;
    systemTheme?.addEventListener('change', () => { if (current === 'system') { settleInstantly(); publish(); } });
    window.addEventListener('storage', (event) => {
      if (event.key === null || event.key === KEY) {
        current = read();
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
