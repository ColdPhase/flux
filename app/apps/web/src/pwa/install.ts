/**
 * Installing Flux on this device (#20, MOB-1). Chromium browsers fire `beforeinstallprompt` when
 * the page meets their install criteria; Flux keeps that event and shows its own "Install Flux"
 * button, which calls `prompt()` from the tap. Safari on iPhone and iPad has no such event:
 * installation is Share, then Add to Home Screen, so Flux shows those steps instead. Nothing is
 * shown once Flux runs as an installed app.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** `failed`: the browser refused to open its dialog (for example a spent offer); the offer is kept for another try. */
export type InstallOutcome = 'accepted' | 'dismissed' | 'failed';

export type InstallState =
  /** Already running as an installed app (standalone window or Home Screen web app). */
  | { state: 'installed' }
  /** The browser offered installation; `install()` must run from a tap or click. */
  | { state: 'available'; install: () => Promise<InstallOutcome> }
  /** Installed from this page just now; the app opens from the home screen or app list. */
  | { state: 'just-installed' }
  /** iPhone or iPad Safari: Share, then Add to Home Screen. */
  | { state: 'apple-steps' }
  /** Android without an offered prompt: the browser menu installs it. */
  | { state: 'menu-steps' }
  /** Nothing useful to say (a desktop browser that offers no installation). */
  | { state: 'none' };

type Listener = (state: InstallState) => void;
const listeners = new Set<Listener>();
let deferred: InstallPromptEvent | null = null;
let justInstalled = false;
let watching = false;

export function isAppleMobile() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

/** Installed and opened from the home screen: the manifest's standalone window, or iOS's Home Screen web app. */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function installState(): InstallState {
  if (justInstalled) return { state: 'just-installed' };
  if (isStandalone()) return { state: 'installed' };
  const event = deferred;
  if (event) {
    return {
      state: 'available',
      async install() {
        let outcome: 'accepted' | 'dismissed';
        try {
          await event.prompt();
          ({ outcome } = await event.userChoice);
        } catch {
          return 'failed';
        }
        // The browser allows one prompt per event; a later offer arrives as a new event.
        if (deferred === event) deferred = null;
        if (outcome === 'accepted') justInstalled = true;
        notify();
        return outcome;
      },
    };
  }
  if (isAppleMobile()) return { state: 'apple-steps' };
  if (/Android/.test(navigator.userAgent)) return { state: 'menu-steps' };
  return { state: 'none' };
}

function notify() {
  const state = installState();
  for (const listener of listeners) listener(state);
}

/**
 * Starts listening for the browser's install offer. Call once at startup, before the first
 * render: Chromium fires the event early and only once per page load.
 */
export function watchInstallPrompt() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's own mini-infobar away; Settings offers the button instead.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    justInstalled = true;
    notify();
  });
  for (const mode of ['standalone', 'fullscreen', 'minimal-ui']) {
    window.matchMedia(`(display-mode: ${mode})`).addEventListener('change', notify);
  }
}

/** Subscribe to changes; the listener is called immediately with the current state. */
export function onInstallState(listener: Listener): () => void {
  listeners.add(listener);
  listener(installState());
  return () => listeners.delete(listener);
}
