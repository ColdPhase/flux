import { useEffect } from 'react';

/**
 * The tab and the installed app say that something unread would notify you (#1243; docs/product/mobile-pwa.md "While Flux is open"):
 * the title gets "(N)", the favicon a dot, and the app's icon the same number through the Badging API where the engine has it. The
 * number is the Inbox's `notifying` count, read with the sidebar's; reading the items clears it. Nothing here asks the server.
 */
const ICON = '/icons/icon.svg';
const ICON_DOT = '/icons/icon-dot.svg';
const PREFIX = /^\(\d+\+?\)\s/;

interface Badging { setAppBadge?(count?: number): Promise<void>; clearAppBadge?(): Promise<void> }

function show(count: number) {
  const base = document.title.replace(PREFIX, '');
  document.title = count ? `(${count > 99 ? '99+' : count}) ${base}` : base;
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    // The PNG icon keeps its own address so a browser that prefers it is given the dot too, and gets it back after.
    link.dataset.fluxIcon ??= link.getAttribute('href') ?? ICON;
    link.dataset.fluxType ??= link.getAttribute('type') ?? '';
    if (count) { link.href = ICON_DOT; link.type = 'image/svg+xml'; } else {
      link.href = link.dataset.fluxIcon;
      if (link.dataset.fluxType) link.type = link.dataset.fluxType; else link.removeAttribute('type');
    }
  }
  const badging = navigator as Navigator & Badging;
  try {
    const done = count ? badging.setAppBadge?.(count) : badging.clearAppBadge?.();
    void done?.catch(() => undefined);
  } catch { /* an engine without the Badging API, or a page that may not set it, shows the title and the dot only */ }
}

export function useTabSignals(count: number) {
  useEffect(() => {
    show(count);
  }, [count]);
  // Signing out (the shell goes) takes the number away.
  useEffect(() => () => show(0), []);
}

export { ICON, ICON_DOT };
