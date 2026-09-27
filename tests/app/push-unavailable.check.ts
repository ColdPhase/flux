import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, uniqueEmail } from './support/http.js';
import { subscriptionBody, testSubscription } from './support/push.js';

// Run by scripts/check_application.sh after recreating the API without FLUX_VAPID_PUBLIC_KEY:
// push must report itself unavailable instead of failing silently, and the inbox keeps working.
test('without VAPID keys push is reported unavailable and the inbox still works', async () => {
  const { browser } = await register(uniqueEmail('nopush'), 'correct horse battery staple');
  const key = await browser.request('GET', '/api/v1/push/public-key');
  assert.equal(key.status, 503);
  assert.equal((key.json as { status: string; code: string }).status, 'unavailable');
  assert.equal((key.json as { code: string }).code, 'PUSH_UNAVAILABLE');
  const subscribe = await browser.request('POST', '/api/v1/push/subscriptions', { body: subscriptionBody(testSubscription()) });
  assert.equal(subscribe.status, 503);
  assert.equal((subscribe.json as { code: string }).code, 'PUSH_UNAVAILABLE');
  const inbox = await browser.request('GET', '/api/v1/inbox');
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.json, { items: [], unread: 0 });
});
