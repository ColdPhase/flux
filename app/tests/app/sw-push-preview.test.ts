import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// What the service worker's push handler shows for each payload (#1346). The worker's own source runs here with a stub `self`: a full preview
// shows its title and body, a hidden one (Hide previews) its title alone, and anything else the fixed text. The closed-app browser check is
// tests/app/e2e/push-browser.e2e.ts; this one pins the handler's choice for every payload kind without a browser.

function push(payload: unknown) {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: { title: string; body: string; tag: string | undefined }[] = [];
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers.set(type, handler); },
    location: { origin: 'https://flux.example' },
    registration: { showNotification: async (title: string, options: { body: string; tag?: string }) => { shown.push({ title, body: options.body, tag: options.tag }); } },
  };
  vm.runInNewContext(readFileSync('apps/web/src/pwa/sw.js', 'utf8'), { self, URL, Request, Response, console, AbortSignal, caches: {}, fetch: async () => { throw new Error('offline'); } });
  const waits: Promise<unknown>[] = [];
  handlers.get('push')!({ data: { json: () => payload }, waitUntil: (work: Promise<unknown>) => waits.push(work) });
  return Promise.all(waits).then(() => shown);
}

const id = '6b0d7a52-3c1e-4f0a-9d4e-2a7c5f9e1b33';

test('a full preview shows its title and body, and a hidden one only its title, even if a body came with it', async () => {
  assert.deepEqual(await push({ preview: 'full', notificationId: id, title: 'Ada replied in Tool library', body: 'See you at nine', url: '/dm/x' }),
    [{ title: 'Ada replied in Tool library', body: 'See you at nine', tag: id }]);
  assert.deepEqual(await push({ preview: 'hidden', notificationId: id, title: 'Ada mentioned you in Tool library' }),
    [{ title: 'Ada mentioned you in Tool library', body: '', tag: id }]);
  assert.deepEqual(await push({ preview: 'hidden', notificationId: id, title: 'Ada mentioned you in Tool library', body: 'must not be shown' }),
    [{ title: 'Ada mentioned you in Tool library', body: '', tag: id }]);
});

test('a generic, an unknown or a broken payload shows the fixed text and no content', async () => {
  const fixed = [{ title: 'New activity in Flux', body: '', tag: id }];
  assert.deepEqual(await push({ preview: 'generic', notificationId: id, title: 'New activity in Flux' }), fixed);
  assert.deepEqual(await push({ preview: 'something-new', notificationId: id, title: 'Secret title', body: 'Secret body' }), fixed);
  assert.deepEqual(await push({ preview: 'hidden', notificationId: id, title: '' }), fixed);
  assert.deepEqual(await push({ preview: 'hidden', notificationId: id }), fixed);
});
