import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Browser, publicOrigin, register, uniqueEmail } from './support/http.js';
import { password } from './support/people.js';

// A path written with percent-encoding is the same path to the router (#1047): `/%61pi/v1/me` runs `/api/v1/me`. Everything that decides by the
// kind of path (no-store, the 404 answer, compression of auth answers, the sign-in checks in front of Better Auth) has to decide by what the
// router decided, on the running API. (`fetch` resolves dot segments and drops a fragment before it sends, so those spellings are tried over a socket in
// api-rate-limit.test.ts and routed-path-core.test.ts.)
if (!publicOrigin) throw new Error('FLUX_PUBLIC_ORIGIN is required');

describe('an encoded path on the running API', () => {
  test('an encoded /api is the API in every hook: the same answer, no-store, and a JSON 404 where nothing is', async () => {
    const { browser } = await register(uniqueEmail('encoded-api'), password);
    const plain = await browser.request('GET', '/api/v1/me');
    assert.equal(plain.status, 200);
    for (const path of ['/%61pi/v1/me', '/%61%70%69/v1/%6De', '/api/v1/m%65?x=1']) {
      const answer = await browser.request('GET', path);
      assert.equal(answer.status, 200, path);
      assert.deepEqual(answer.json, plain.json, path);
      assert.equal(answer.headers.get('cache-control'), 'no-store', `${path}: nothing under /api/ is kept by a cache`);
      assert.equal(answer.headers.get('x-content-type-options'), 'nosniff', path);
    }
    for (const path of ['/%61pi/v1/no-such-route', '/api/v1/no-such%2Froute']) {
      const answer = await browser.request('GET', path, { headers: { accept: 'text/html' } });
      assert.equal(answer.status, 404, path);
      assert.deepEqual(answer.json, { error: 'Not Found' }, `${path}: an API 404 is JSON, not the app shell`);
      assert.equal(answer.headers.get('cache-control'), 'no-store', path);
    }
    // A path that does not decode is a 400 before any route, and the hooks that read the path do not turn it into a 500.
    for (const path of ['/api/v1/%E0%A4%A', '/api/v1/m%65%']) assert.equal((await browser.request('GET', path)).status, 400, path);
    // A path the router does not read as /api/ is no API route: the signed-in person's answer is not given.
    for (const path of ['/%2561pi/v1/me', '/api%2Fv1/me']) assert.notEqual((await browser.request('GET', path)).status, 200, path);
  });

  test('the sign-in routes are not reachable under another spelling of their path, so no check in front of them is stepped around', async () => {
    const email = uniqueEmail('encoded-auth');
    await register(email, password);
    const anonymous = new Browser();
    const signIn = (path: string) => anonymous.request('POST', path, { body: { email, password } });
    assert.equal((await signIn('/api/auth/sign-in/email')).status, 200, 'the plain path signs in');
    for (const path of ['/api/auth/sign%2Din/email', '/api/auth/%73ign-in/email', '/api/auth/sign-in%2Femail', '/%61pi/auth/sign-in/email', '/api/auth/sign-in/e%6dail']) {
      const answer = await new Browser().request('POST', path, { body: { email, password } });
      assert.notEqual(answer.status, 200, `${path} is no sign-in`);
      assert.equal(answer.setCookies.length, 0, `${path} sets no session`);
    }
    // The raw ID-token sign-in is refused on its own path (#113) and under no other spelling of it either.
    const social = { provider: 'google', idToken: { token: 'made-up' } };
    assert.equal((await anonymous.request('POST', '/api/auth/sign-in/social', { body: social })).status, 400);
    for (const path of ['/api/auth/sign%2Din/social', '/api/auth/%73ign-in/social', '/%61pi/auth/sign-in/social']) {
      const answer = await new Browser().request('POST', path, { body: social });
      assert.notEqual(answer.status, 200, path);
      assert.equal(answer.setCookies.length, 0, `${path} sets no session`);
    }
  });
});
