import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originals = new Map(['window', 'document', 'navigator'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
afterEach(() => {
  for (const [name, original] of originals) {
    if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name);
  }
});
class Worker extends EventTarget {
  state = 'installed';
  sent: unknown[] = [];
  postMessage(message: unknown) { this.sent.push(message); }
}
let serial = 0;
async function fixture(waiting: Worker | null = null, controller: Worker | null = null) {
  const registration = Object.assign(new EventTarget(), { waiting, installing: null as Worker | null, update: async () => undefined });
  const container = Object.assign(new EventTarget(), { controller, register: async () => registration });
  let reloads = 0;
  const window = Object.assign(new EventTarget(), { isSecureContext: true, location: { reload() { reloads++; } }, setInterval() { return 1; } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: container } });
  const url = new URL('../../apps/web/src/pwa/register.ts', import.meta.url); url.searchParams.set('case', String(++serial));
  const api = await import(url.href) as typeof import('../../apps/web/src/pwa/register.js');
  const offers: (import('../../apps/web/src/pwa/register.js').ServiceWorkerUpdate | null)[] = [];
  api.onServiceWorkerUpdate((offer) => offers.push(offer));
  await api.registerServiceWorker();
  return { api, offers, registration, container, reloads: () => reloads };
}

test('WebKit first installed worker exposed as waiting and controller never announces an update', async () => {
  const worker = new Worker();
  const f = await fixture(worker, worker);
  assert.deepEqual(f.offers, [null]);
  worker.state = 'activating'; f.registration.waiting = null; worker.dispatchEvent(new Event('statechange'));
  worker.state = 'activated'; worker.dispatchEvent(new Event('statechange'));
  assert.deepEqual(f.offers, [null]); assert.equal(f.reloads(), 0);
});

test('existing distinct waiting update applies once and clears when another tab activates it', async () => {
  const current = new Worker(); current.state = 'activated';
  const next = new Worker();
  const f = await fixture(next, current);
  const offered = f.offers.at(-1)!; assert.ok(offered);
  offered.apply(); offered.apply();
  assert.deepEqual(next.sent, [{ type: 'SKIP_WAITING' }]);
  f.container.controller = next; next.state = 'activating'; f.registration.waiting = null;
  next.dispatchEvent(new Event('statechange'));
  assert.equal(f.offers.at(-1), null, 'no stale waiting action remains');
  f.container.dispatchEvent(new Event('controllerchange')); f.container.dispatchEvent(new Event('controllerchange'));
  assert.equal(f.reloads(), 1, 'explicit apply reloads once');
});

test('installation already in progress is watched, and a late explicit apply uses its current controller', async () => {
  const current = new Worker(); current.state = 'activated';
  const next = new Worker(); next.state = 'installing';
  const f = await fixture(null, current);
  f.registration.installing = next; f.registration.dispatchEvent(new Event('updatefound'));
  assert.deepEqual(f.offers, [null]);
  next.state = 'installed'; f.registration.waiting = next; f.registration.installing = null;
  next.dispatchEvent(new Event('statechange'));
  const offered = f.offers.at(-1)!; assert.ok(offered);
  f.container.controller = next; next.state = 'activated'; f.registration.waiting = null;
  next.dispatchEvent(new Event('statechange'));
  assert.equal(f.offers.at(-1), null);
  offered.apply(); offered.apply();
  assert.equal(f.reloads(), 1, 'user intent after other-tab activation still reloads exactly once');
  assert.deepEqual(next.sent, []);
});
