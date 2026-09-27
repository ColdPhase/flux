import { INBOX_PATH, PUSH_PUBLIC_KEY_PATH, PUSH_SUBSCRIPTIONS_PATH, type PushPublicKeyResponse, type PushSubscriptionSummary } from '@flux/contracts';
import { registerServiceWorker, serviceWorkerSupported } from './register.js';

/**
 * Web Push client (issue #41, MOB-4). Nothing here asks for notification permission on its own:
 * `enablePushNotifications` must be called from a click/tap handler, and the permission request
 * is its first step so browsers that require a user gesture (Safari, iOS home-screen apps) accept it.
 */
export type PushState =
  | { state: 'unsupported' }
  /** iPhone/iPad Safari tab: Web Push exists only after "Add to Home Screen". */
  | { state: 'needs-install' }
  /** The server has no VAPID keys configured. */
  | { state: 'unavailable' }
  | { state: 'denied' }
  | { state: 'prompt'; publicKey: string }
  | { state: 'subscribed'; publicKey: string };

export type EnableResult =
  | { status: 'subscribed' }
  | { status: 'denied' }
  | { status: 'dismissed' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export const INBOX_URL = INBOX_PATH;

function isAppleMobile() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function pushApisPresent() {
  return serviceWorkerSupported() && 'PushManager' in window && 'Notification' in window;
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(subscription: PushSubscription, publicKey: string) {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function fetchPublicKey(): Promise<string | null> {
  const response = await fetch(PUSH_PUBLIC_KEY_PATH, { credentials: 'same-origin' });
  const body = await response.json().catch(() => null) as PushPublicKeyResponse | null;
  if (response.ok && body?.status === 'available') return body.publicKey;
  if (body?.status === 'unavailable') return null;
  throw new Error(`Push status request failed (${response.status})`);
}

async function saveSubscription(subscription: PushSubscription, deviceLabel?: string | null) {
  const response = await fetch(PUSH_SUBSCRIPTIONS_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...subscription.toJSON(), deviceLabel: deviceLabel ?? null }),
  });
  if (!response.ok) throw new Error(`Saving the push subscription failed (${response.status})`);
  return await response.json() as PushSubscriptionSummary;
}

/** Reads the current state without prompting. Call it on render to decide what to show. */
export async function getPushState(): Promise<PushState> {
  if (!pushApisPresent()) return isAppleMobile() && !isStandalone() ? { state: 'needs-install' } : { state: 'unsupported' };
  const publicKey = await fetchPublicKey();
  if (!publicKey) return { state: 'unavailable' };
  if (Notification.permission === 'denied') return { state: 'denied' };
  const registration = await registerServiceWorker();
  if (!registration) return { state: 'unsupported' };
  const subscription = await registration.pushManager.getSubscription();
  if (Notification.permission === 'granted' && subscription && sameKey(subscription, publicKey)) return { state: 'subscribed', publicKey };
  return { state: 'prompt', publicKey };
}

/**
 * Asks for permission and subscribes this device. Call only from a user gesture handler, with
 * the public key from a previous getPushState(). Denied or dismissed permission is not an
 * error: notifications keep arriving in the in-app inbox.
 */
export async function enablePushNotifications(publicKey: string, deviceLabel?: string | null): Promise<EnableResult> {
  if (!pushApisPresent()) return { status: 'unsupported' };
  // First statement, before any other await, so the user activation is still valid.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { status: 'denied' };
  if (permission !== 'granted') return { status: 'dismissed' };
  try {
    const registration = await registerServiceWorker();
    if (!registration) return { status: 'unsupported' };
    const ready = await navigator.serviceWorker.ready;
    let subscription = await ready.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
    await saveSubscription(subscription, deviceLabel);
    return { status: 'subscribed' };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Removes this device's subscription from the browser and from Flux. */
export async function disablePushNotifications(): Promise<void> {
  if (!pushApisPresent()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  // Re-posting is idempotent and returns this endpoint's own row, never another device's.
  const saved = await saveSubscription(subscription).catch(() => null);
  if (saved) await fetch(`${PUSH_SUBSCRIPTIONS_PATH}/${saved.id}`, { method: 'DELETE', credentials: 'same-origin' });
  await subscription.unsubscribe();
}

/**
 * On app start with permission already granted: re-register the existing subscription (the call
 * is idempotent) and replace it if the server's VAPID key was rotated. Never prompts.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!pushApisPresent() || Notification.permission !== 'granted') return;
  const publicKey = await fetchPublicKey().catch(() => null);
  if (!publicKey) return;
  const registration = await registerServiceWorker();
  let subscription = await registration?.pushManager.getSubscription();
  if (!registration || !subscription) return;
  if (!sameKey(subscription, publicKey)) {
    await subscription.unsubscribe();
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  }
  await saveSubscription(subscription);
}
