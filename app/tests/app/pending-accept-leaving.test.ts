import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';

// An accept waits for its Undo window (#342). Leaving the page sends every waiting accept with `keepalive`
// (#471 follow-up): a timer that ends between `beforeunload` and `pagehide` is held by the page-leave gate
// and must still go out on the way out, not be lost because the timer already took it from the waiting list.
const globals = globalThis as unknown as Record<string, unknown>;
const saved = { window: globals.window, document: globals.document, fetch: globals.fetch };
const window = Object.assign(new EventTarget(), {
  setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
  clearTimeout: (id: number) => globalThis.clearTimeout(id),
});
const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
globals.window = window;
globals.document = document;
const { startAccept, hasWaitingAccepts } = await import('../../apps/web/src/notifications/pendingAccept.js');
const { LEAVING_GRACE_MS } = await import('../../apps/web/src/api/pageLeaving.js');

const calls: Array<{ path: string; keepalive: boolean | undefined }> = [];
const fire = (name: string) => window.dispatchEvent(new Event(name));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
let decisionNumber = 0;
const outcomes: string[] = [];
const begin = (delay = 100) => {
  decisionNumber += 1;
  return startAccept({ id: `d${decisionNumber}`, version: 1 }, (outcome) => { outcomes.push(outcome); }, delay);
};

beforeEach(() => {
  calls.length = 0;
  outcomes.length = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  globals.fetch = async (path: string, init: RequestInit) => {
    calls.push({ path, keepalive: init.keepalive });
    return Response.json({ id: 'd', version: 2 });
  };
});
afterEach(() => {
  fire('pageshow');
  mock.timers.reset();
  globals.fetch = saved.fetch;
});
after(() => {
  globals.window = saved.window;
  globals.document = saved.document;
});

test('an accept whose Undo window ends after beforeunload is still sent, with keepalive, at pagehide', async () => {
  begin();
  fire('beforeunload');
  mock.timers.tick(100);
  await settle();
  fire('pagehide');
  await settle();
  assert.equal(calls.length, 1, 'the accept went out on the way out');
  assert.match(calls[0]?.path ?? '', /\/accept$/);
  assert.equal(calls[0]?.keepalive, true);
  assert.deepEqual(outcomes, ['accepted']);
});

test('an accept whose window ends while a cancelled navigation is pending is sent once, when the page is live', async () => {
  begin();
  fire('beforeunload');
  mock.timers.tick(100);
  await settle();
  assert.equal(calls.length, 0, 'nothing starts while the page is left');
  mock.timers.tick(LEAVING_GRACE_MS);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.keepalive, false);
  fire('pagehide');
  fire('pageshow');
  await settle();
  assert.equal(calls.length, 1, 'never sent twice');
  assert.equal(hasWaitingAccepts(), false);
});

test('a held accept sent at pagehide is not sent again when the page comes back', async () => {
  begin();
  fire('beforeunload');
  mock.timers.tick(100);
  fire('pagehide');
  await settle();
  fire('pageshow');
  mock.timers.tick(LEAVING_GRACE_MS);
  await settle();
  assert.equal(calls.length, 1);
});

test('an accept held while the page is left can still be undone, and then never goes out', async () => {
  const accept = begin();
  fire('beforeunload');
  mock.timers.tick(100);
  assert.equal(accept.undo(), true, 'it had not been sent yet');
  fire('pagehide');
  fire('pageshow');
  mock.timers.tick(LEAVING_GRACE_MS);
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(hasWaitingAccepts(), false);
});
