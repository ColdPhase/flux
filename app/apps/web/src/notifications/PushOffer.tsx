import { useEffect, useState } from 'react';
import { enablePushNotifications, getPushState, pushOnServer } from '../pwa/push';
import { installState, isAppleMobile, onInstallState, type InstallState } from '../pwa/install';
import { Button, Icon, useToast } from '../ui';
import './push-offer.css';

/**
 * The one-time offer to turn notifications on (#1243; docs/design/final/README.md "Asking for notifications", docs/product/mobile-pwa.md
 * "While Flux is open"). It comes after the first direct message, mention or question to the person, only while this browser has not
 * been asked and the server can push, and not within 14 days of a Not now. Turn on asks the browser from the tap itself. iPhone and
 * iPad in Safari get the Add to Home Screen steps first; Android gets Install Flux where the browser offers it; Block gets the way back.
 */
export const OFFER_AGAIN_MS = 14 * 24 * 3600_000;
const storageKey = (userId: string) => `flux:push-offer:${userId}`;
const READY = 'flux:push-offer-ready';

interface Remembered { ready?: boolean; notNowAt?: number }

function remembered(userId: string): Remembered {
  try { return JSON.parse(localStorage.getItem(storageKey(userId)) ?? '{}') as Remembered; } catch { return {}; }
}
function remember(userId: string, change: Remembered) {
  try { localStorage.setItem(storageKey(userId), JSON.stringify({ ...remembered(userId), ...change })); } catch { /* private mode: offered again next time */ }
}

/** Someone wrote to, mentioned or asked the person: the offer may come now (a notice calls this). */
export function markPushOfferReady(userId: string) {
  if (remembered(userId).ready) return;
  remember(userId, { ready: true });
  window.dispatchEvent(new CustomEvent(READY, { detail: userId }));
}

type View =
  | { kind: 'hidden' }
  | { kind: 'offer'; publicKey: string }
  | { kind: 'home-screen' }
  | { kind: 'blocked' }
  | { kind: 'asking'; publicKey: string };

/** An iPad says it is a Mac to websites; its touch screen gives it away, as `isAppleMobile` reads it. */
const deviceWord = () => /iPad/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1) ? 'iPad' : 'iPhone';
const desktopSafari = () => /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(navigator.userAgent);

function blockedSteps() {
  if (desktopSafari() && !isAppleMobile()) return 'To allow them, open Safari’s Settings, then Websites, then Notifications, and choose Allow for this site.';
  if (isAppleMobile()) return 'To allow them, open Settings, then Notifications, then Flux, and turn Allow Notifications on.';
  if (/Android/i.test(navigator.userAgent)) return 'To allow them, open the browser menu, then Site settings, then Notifications, and allow this site.';
  return 'To allow them, click the icon left of the address, open Notifications and choose Allow.';
}

export function PushOffer({ userId, ready }: { userId: string; ready: boolean }) {
  const toast = useToast();
  const [view, setView] = useState<View>({ kind: 'hidden' });
  const [heard, setHeard] = useState(false);
  const [install, setInstall] = useState<InstallState>(() => installState());
  useEffect(() => onInstallState(setInstall), []);
  useEffect(() => {
    const onReady = (event: Event) => { if ((event as CustomEvent<string>).detail === userId) setHeard(true); };
    window.addEventListener(READY, onReady);
    return () => window.removeEventListener(READY, onReady);
  }, [userId]);
  // Home's waiting items name a mention or a question: the offer may come.
  useEffect(() => { if (ready) markPushOfferReady(userId); }, [ready, userId]);

  const due = ready || heard;
  useEffect(() => {
    const stored = remembered(userId);
    if (!(due || stored.ready)) return undefined;
    if (stored.notNowAt && Date.now() - stored.notNowAt < OFFER_AGAIN_MS) return undefined;
    // Asked before (allowed or blocked): nothing to offer, and nothing is read from the server.
    if (typeof Notification !== 'undefined' && Notification.permission !== 'default') return undefined;
    let live = true;
    getPushState().then(async (state) => {
      if (!live) return;
      if (state.state === 'prompt') setView({ kind: 'offer', publicKey: state.publicKey });
      // The Home Screen steps only where the installed app could then be notified: this server must be able to push (#763 SG-3).
      else if (state.state === 'needs-install' && await pushOnServer().catch(() => false) && live) setView({ kind: 'home-screen' });
    }, () => undefined);
    return () => { live = false; };
  }, [userId, due]);

  if (view.kind === 'hidden') return null;
  const notNow = () => { remember(userId, { notNowAt: Date.now() }); setView({ kind: 'hidden' }); };
  const turnOn = (publicKey: string) => {
    // Called directly in the tap's handler: the browser asks only after a gesture, and this is the request's first step.
    const pending = enablePushNotifications(publicKey);
    setView({ kind: 'asking', publicKey });
    void pending.then((result) => {
      if (result.status === 'subscribed') { setView({ kind: 'hidden' }); toast({ message: 'Notifications are on for this device', tone: 'success' }); return; }
      if (result.status === 'denied') { setView({ kind: 'blocked' }); return; }
      if (result.status === 'dismissed') { notNow(); return; }
      setView({ kind: 'offer', publicKey });
      toast({ message: 'Notifications could not be turned on. Try again, or in Settings › Notifications.', tone: 'danger' });
    });
  };
  const installable = install.state === 'available' ? install.install : null;

  const title = view.kind === 'home-screen' ? `Get notified on this ${deviceWord()}`
    : view.kind === 'blocked' ? 'Notifications are blocked for Flux' : 'Get notified when someone writes to you or calls';
  return (
    <section className="home__card push-offer" aria-labelledby="push-offer-title">
      <span className="nyc__face nyc__face--icon" aria-hidden="true"><Icon name="bell" size={16} /></span>
      <div className="push-offer__text">
        <h3 className="push-offer__t" id="push-offer-title">{title}</h3>
        {view.kind === 'home-screen' ? <>
          <p className="push-offer__s">Notifications on {deviceWord()} work from Flux on your Home Screen:</p>
          <ol className="push-offer__steps">
            <li>Tap Share, then Add to Home Screen.</li>
            <li>Open Flux from your Home Screen.</li>
            <li>Turn notifications on there.</li>
          </ol>
        </> : view.kind === 'blocked' ? <p className="push-offer__s" role="status">{blockedSteps()} Your Inbox always has everything.</p>
          : <p className="push-offer__s">Flux asks your browser once. You can turn it off in Settings.</p>}
      </div>
      <div className="push-offer__actions">
        {view.kind === 'offer' || view.kind === 'asking' ? <Button variant="primary" busy={view.kind === 'asking'} onClick={() => { if (view.kind === 'offer') turnOn(view.publicKey); }}>Turn on</Button> : null}
        {view.kind === 'blocked' ? <Button variant="secondary" onClick={notNow}>Got it</Button> : <Button variant="secondary" onClick={notNow}>Not now</Button>}
        {installable && view.kind !== 'blocked' ? <Button variant="secondary" onClick={() => void installable()}>Install Flux</Button> : null}
      </div>
    </section>
  );
}
