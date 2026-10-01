/* Flux service worker (issue #41). Built to /sw.js by build/service-worker-plugin.ts, which
 * replaces the version and precache placeholders below. Plain JavaScript on purpose: it is a
 * classic worker script with no imports, so every supported browser can run it. */
/* global self, caches, fetch, URL, Request, Response, console, AbortSignal */

const VERSION = '__FLUX_SW_VERSION__';
const PRECACHE = /* __FLUX_PRECACHE__ */ [];
const CACHE = `flux-shell-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  // Fetch every shell file fresh from the network. No skipWaiting here: a new version waits
  // until the person chooses "Reload", so an open draft is never swapped out from under them.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('flux-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API responses carry per-user data and authorization decisions: never cached, always network.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (PRECACHED.has(url.pathname)) event.respondWith(cacheFirst(request, url.pathname));
});

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    if (offline) return offline;
    console.warn('Flux offline page missing from cache', error);
    return new Response('Flux is offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function cacheFirst(request, pathname) {
  const cached = await caches.match(pathname, { cacheName: CACHE });
  return cached || fetch(request);
}

function appUrl(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href;
  } catch {
    return new URL('/', self.location.origin).href;
  }
}

const GENERIC_TITLE = 'New activity in Flux';

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const notificationId = typeof data.notificationId === 'string' ? data.notificationId : undefined;
  // Lock-screen privacy: text is shown only when the server sent a full preview, which it does
  // only while the recipient can read the source. Anything else shows the fixed generic title.
  const full = data.preview === 'full' && typeof data.title === 'string' && data.title;
  const title = full ? data.title : GENERIC_TITLE;
  const body = full && typeof data.body === 'string' ? data.body : '';
  // Every push shows a notification: browsers require user-visible pushes.
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    tag: notificationId,
    data: { notificationId },
  }));
});

/**
 * Where a tapped notification leads. The payload's link is not trusted: the server rechecks
 * access for this notification now and answers 404 when the person can no longer read it
 * (or the device was signed out), in which case the app opens at its start page.
 */
async function notificationTarget(notificationId) {
  if (typeof notificationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(notificationId)) return appUrl('/');
  try {
    // Bounded, so the window still opens promptly after the tap (browsers limit how long a
    // notification click may take to open a window).
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3000) : undefined;
    const response = await fetch(`/api/v1/inbox/${notificationId}`, { credentials: 'same-origin', cache: 'no-store', signal });
    if (!response.ok) return appUrl('/');
    const item = await response.json();
    return appUrl(item && typeof item.url === 'string' ? item.url : '/');
  } catch {
    return appUrl('/');
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = await notificationTarget(event.notification.data && event.notification.data.notificationId);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if ('navigate' in client) await client.navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // The push service rotated this browser's subscription; register the replacement.
  event.waitUntil((async () => {
    const options = event.oldSubscription && event.oldSubscription.options;
    const subscription = event.newSubscription || (options ? await self.registration.pushManager.subscribe(options) : null);
    if (!subscription) return;
    await fetch('/api/v1/push/subscriptions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
  })());
});
