import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { credentialKey, API_RATE_LIMIT } from '../../apps/server/src/http/rate-limit.js';

// The API-wide limit on the real server, with the limit ON (the shared test stacks switch it off): the session cookie a real sign-in
// sets is what the limit recognises, so people at one address are counted one by one and not as one anonymous crowd (#838, review of
// #1008: the limit once looked for another cookie name, every browser request counted as anonymous at 240 a minute per address, and
// two people got 429 within 30 seconds).

const env: NodeJS.ProcessEnv = {
  ...process.env,
  FLUX_AUTH_RATE_LIMIT: 'true',
  FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `api-rate-limit-${'x'.repeat(40)}`,
  FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080',
};

test('the cookie of a real sign-in is the credential, and two people at one address do not share a budget', { timeout: 120_000 }, async () => {
  const config = loadServerConfig(env, '/nonexistent/flux_background_key');
  assert.equal(config.identity.rateLimit, true);
  const app = await buildApp(config);
  try {
    const origin = config.identity.publicOrigin;
    // Each person signs up from an address of their own (Better Auth limits sign-ups per address), then both use the API from one.
    const signUp = async (name: string, address: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', remoteAddress: address,
        headers: { origin, 'content-type': 'application/json' },
        payload: { name, email: `limit.${randomUUID()}@example.test`, password: 'a long calm passphrase' } });
      assert.equal(response.statusCode, 200, response.body);
      const setCookie = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      const session = setCookie.map((line) => line.split(';', 1)[0]!).find((pair) => /session_token=/.test(pair));
      assert.ok(session, `a session cookie was set: ${setCookie.join(' | ')}`);
      return session;
    };
    const ada = await signUp('Limit Ada', '10.20.0.1');
    const jonas = await signUp('Limit Jonas', '10.20.0.2');
    const adaKey = credentialKey({ headers: { cookie: ada } });
    assert.ok(adaKey, `the limit recognises the cookie a real sign-in sets (${ada.split('=')[0]})`);
    assert.ok(credentialKey({ headers: { cookie: jonas } }) && credentialKey({ headers: { cookie: jonas } }) !== adaKey);

    const shared = '10.20.0.9';
    const me = (cookie: string) => app.inject({ method: 'GET', url: '/api/v1/me', remoteAddress: shared, headers: { cookie } });
    // Each of the two makes more requests in the minute than the anonymous budget of the address allows, 2,000 together.
    const total = API_RATE_LIMIT.anonymousPerMinute + 400;
    assert.ok(2 * total <= 2 * API_RATE_LIMIT.credentialPerMinute);
    const statuses = new Map<number, number>();
    for (let n = 0; n < total; n += 1) {
      for (const cookie of [ada, jonas]) {
        const status = (await me(cookie)).statusCode;
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
      }
    }
    assert.deepEqual([...statuses], [[200, 2 * total]], 'no refusal for two people at one address');
    // Without a session the same address has its own, smaller budget.
    const anonymous = new Map<number, number>();
    for (let n = 0; n < API_RATE_LIMIT.anonymousPerMinute + 5; n += 1) {
      const status = (await app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: shared })).statusCode;
      anonymous.set(status, (anonymous.get(status) ?? 0) + 1);
    }
    assert.deepEqual([...anonymous], [[200, API_RATE_LIMIT.anonymousPerMinute], [429, 5]]);
    assert.equal((await me(ada)).statusCode, 200, 'a signed-in person is not held back by the anonymous count');
    // One person past their own budget is answered 429 with Retry-After; the other at the same address is not.
    for (let n = 0; n < API_RATE_LIMIT.credentialPerMinute; n += 1) await me(ada);
    const refused = await me(ada);
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().code, 'RATE_LIMITED');
    assert.match(String(refused.headers['retry-after']), /^\d+$/);
    assert.equal((await me(jonas)).statusCode, 200);
  } finally {
    await app.close();
  }
});
