import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

// The web app's page lifecycle gate (#471): background reads wait while the page is being left and
// run again if the navigation is cancelled. A fake window drives the real module.
const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  mock.timers.reset();
  if (original) Object.defineProperty(globalThis, 'window', { configurable: true, value: original.value }); else Reflect.deleteProperty(globalThis, 'window');
});

let serial = 0;
async function fixture() {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  const window = Object.assign(new EventTarget(), {
    setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  const url = new URL('../../apps/web/src/api/pageLeaving.ts', import.meta.url);
  url.searchParams.set('case', String(++serial));
  const page = await import(url.href) as typeof import('../../apps/web/src/api/pageLeaving.js');
  const fire = (name: string) => window.dispatchEvent(new Event(name));
  return { page, fire, tick: (ms: number) => mock.timers.tick(ms) };
}

test('a live page runs waiting work at once', async () => {
  const { page } = await fixture();
  let runs = 0;
  page.whenPageLive(() => { runs += 1; });
  assert.equal(page.pageLeaving(), false);
  assert.equal(runs, 1);
});

test('work waits from beforeunload and runs once when the grace of a cancelled navigation ends', async () => {
  const { page, fire, tick } = await fixture();
  let runs = 0;
  fire('beforeunload');
  assert.equal(page.pageLeaving(), true);
  page.whenPageLive(() => { runs += 1; });
  tick(page.LEAVING_GRACE_MS - 1);
  assert.equal(runs, 0, 'still being left');
  tick(1);
  assert.equal(runs, 1);
  assert.equal(page.pageLeaving(), false);
  tick(10_000);
  assert.equal(runs, 1, 'not repeated');
});

test('a second beforeunload restarts the grace', async () => {
  const { page, fire, tick } = await fixture();
  let runs = 0;
  fire('beforeunload');
  page.whenPageLive(() => { runs += 1; });
  tick(page.LEAVING_GRACE_MS - 100);
  fire('beforeunload');
  tick(page.LEAVING_GRACE_MS - 1);
  assert.equal(runs, 0);
  tick(1);
  assert.equal(runs, 1);
});

test('after pagehide the page stays left: work never starts until pageshow', async () => {
  const { page, fire, tick } = await fixture();
  let runs = 0;
  fire('beforeunload');
  fire('pagehide');
  page.whenPageLive(() => { runs += 1; });
  tick(60_000);
  assert.equal(runs, 0, 'an unloaded page starts nothing');
  assert.equal(page.pageLeaving(), true);
  fire('pageshow');
  assert.equal(runs, 1, 'restored from the back-forward cache');
  assert.equal(page.pageLeaving(), false);
});

test('pagehide alone, without a preceding beforeunload, also leaves the page', async () => {
  const { page, fire } = await fixture();
  fire('pagehide');
  assert.equal(page.pageLeaving(), true);
  fire('pageshow');
  assert.equal(page.pageLeaving(), false);
});

test('a click or a key press proves the page stays and runs waiting work at once', async () => {
  for (const event of ['pointerdown', 'keydown']) {
    const { page, fire } = await fixture();
    let runs = 0;
    fire('beforeunload');
    page.whenPageLive(() => { runs += 1; });
    assert.equal(runs, 0);
    fire(event);
    assert.equal(runs, 1, event);
    assert.equal(page.pageLeaving(), false, event);
  }
});

test('a cancelled wait never runs, and a pageshow of a live page changes nothing', async () => {
  const { page, fire, tick } = await fixture();
  let runs = 0;
  fire('pageshow');
  assert.equal(page.pageLeaving(), false);
  fire('beforeunload');
  const cancel = page.whenPageLive(() => { runs += 1; });
  cancel();
  tick(page.LEAVING_GRACE_MS);
  assert.equal(runs, 0);
});

test('onPageLive is told every time a page that was being left is live again', async () => {
  const { page, fire, tick } = await fixture();
  let told = 0;
  const stop = page.onPageLive(() => { told += 1; });
  fire('pointerdown');
  assert.equal(told, 0, 'a page that was never left reports nothing');
  fire('beforeunload');
  tick(page.LEAVING_GRACE_MS);
  fire('beforeunload');
  fire('keydown');
  assert.equal(told, 2);
  stop();
  fire('beforeunload');
  fire('pageshow');
  assert.equal(told, 2);
});

test('work that waits several times runs once for each request, in order', async () => {
  const { page, fire, tick } = await fixture();
  const order: string[] = [];
  fire('beforeunload');
  page.whenPageLive(() => order.push('first'));
  page.whenPageLive(() => order.push('second'));
  tick(page.LEAVING_GRACE_MS);
  assert.deepEqual(order, ['first', 'second']);
});
