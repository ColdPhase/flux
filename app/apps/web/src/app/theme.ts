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
  // The page's own background token, the colour of the header and the pane that sit under the status bar: the body takes the sidebar's
  // colour around the app on a computer, which would leave a strip of another colour above a phone's header (#1544).
  let colour = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (!colour) colour = background(document.body);
  if (transparent(colour)) colour = background(document.documentElement);
  if (transparent(colour)) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = colour;
}

/**
 * An installed Android app paints its navigation bar, the strip under the app, from the manifest's colours, which cannot follow the
 * theme (#1544): the dark theme links the dark manifest, the light theme the light one. Chrome reads it again when it checks the
 * installed app for an update.
 */
function syncManifest() {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) return;
  const shown = document.documentElement.dataset.theme ?? (systemTheme?.matches ? 'dark' : 'light');
  const href = shown === 'dark' ? '/manifest-dark.webmanifest' : '/manifest.webmanifest';
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function publish() {
  syncThemeColor();
  syncManifest();
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
