import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { useDomainErrors } from '../../apps/server/src/http/errors.js';
import { SESSION_COOKIE_PREFIX } from '../../apps/server/src/identity/session-cookie.js';
import { API_RATE_LIMIT, credentialKey, useApiRateLimit, type ApiRateLimitOptions } from '../../apps/server/src/http/rate-limit.js';

// The API-wide request limit (#838, CodeQL js/missing-rate-limiting): per credential, per address without one, and per address for new
// credentials; only API traffic counts; the answer is the domain 429 with Retry-After. No database, network or process: Fastify's inject and a
// clock. That the cookie name here is the one a real sign-in sets is tests/app/api-rate-limit.test.ts.

async function server(options: Partial<ApiRateLimitOptions> = {}, clock = { at: 1_000_000 }) {
  const app = Fastify({ logger: false });
  useDomainErrors(app);
  useApiRateLimit(app, { enabled: true, now: () => clock.at, ...options });
  for (const path of ['/api/v1/me', '/mcp', '/health', '/.well-known/oauth-protected-resource', '/assets/app.js', '/sign-in']) app.get(path, async () => ({ ok: true }));
  await app.ready();
  return { app, clock };
}
const call = (app: FastifyInstance, url: string, headers: Record<string, string> = {}, remoteAddress = '10.0.0.1') => app.inject({ method: 'GET', url, headers, remoteAddress });
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE_PREFIX}.session_token=${token}; theme=dark` });

describe('the API request limit', () => {
  test('a credential has its own window: the call past the limit is a 429 with Retry-After, another credential is untouched, the window ends', async () => {
    const { app, clock } = await server({ credentialPerMinute: 3 });
    for (let n = 0; n < 3; n += 1) assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200);
    clock.at += 20_000;
    const refused = await call(app, '/api/v1/me', cookie('ada'));
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().code, 'RATE_LIMITED');
    assert.equal(refused.headers['retry-after'], '40', 'the seconds left in the minute that began with the first call');
    assert.equal((await call(app, '/api/v1/me', cookie('ben'))).statusCode, 200, 'another credential from the same address');
    clock.at += 40_000;
    assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200, 'a new window');
    await app.close();
  });

  test('a request without a credential counts per address, apart from the credentialed ones', async () => {
    const { app } = await server({ anonymousPerMinute: 2, credentialPerMinute: 100 });
    const answers = [];
    for (let n = 0; n < 3; n += 1) answers.push((await call(app, '/api/v1/me')).statusCode);
    assert.deepEqual(answers, [200, 200, 429]);
    assert.equal((await call(app, '/api/v1/me', {}, '10.0.0.2')).statusCode, 200, 'another address');
    for (let n = 0; n < 5; n += 1) assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200, 'signed-in calls are not the anonymous count');
    await app.close();
  });

  test('made-up credentials from one address are charged to that address as they start, the ones already known are not', async () => {
    const { app, clock } = await server({ newCredentialsPerMinute: 5, credentialPerMinute: 100 });
    const answers = [];
    for (let n = 0; n < 7; n += 1) answers.push((await call(app, '/api/v1/me', cookie(`made-up-${n}`))).statusCode);
    assert.deepEqual(answers, [200, 200, 200, 200, 200, 429, 429]);
    assert.equal((await call(app, '/api/v1/me', cookie('made-up-0'))).statusCode, 200, 'a credential that already has its window');
    assert.equal((await call(app, '/api/v1/me', cookie('made-up-0'), '10.0.0.9')).statusCode, 200, 'another address');
    assert.equal((await call(app, '/api/v1/me', cookie('made-up-9'), '10.0.0.9')).statusCode, 200, 'a new credential from another address');
    clock.at += 60_000;
    assert.equal((await call(app, '/api/v1/me', cookie('made-up-6'))).statusCode, 200, 'the next minute');
    await app.close();
  });

  test('many people behind one address are not limited together: no address-wide total exists', async () => {
    const { app } = await server({ credentialPerMinute: 30, anonymousPerMinute: 5, newCredentialsPerMinute: 600 });
    // 300 people, 30 requests each (9,000 in the minute) from one address: every one answered.
    for (let person = 0; person < 300; person += 1) {
      for (let n = 0; n < 30; n += 1) assert.equal((await call(app, '/api/v1/me', cookie(`person-${person}`))).statusCode, 200, `person ${person} request ${n}`);
    }
    assert.equal((await call(app, '/api/v1/me', cookie('person-0'))).statusCode, 429, 'one person past their own limit');
    await app.close();
  });

  test('API traffic counts (also /mcp, /health and /.well-known); the web app\'s own files do not', async () => {
    const { app } = await server({ anonymousPerMinute: 2 });
    for (const path of ['/assets/app.js', '/sign-in']) for (let n = 0; n < 6; n += 1) assert.equal((await call(app, path)).statusCode, 200, path);
    for (const path of ['/mcp', '/health', '/.well-known/oauth-protected-resource']) {
      assert.deepEqual([await call(app, path, {}, `10.1.0.${path.length}`), await call(app, path, {}, `10.1.0.${path.length}`), await call(app, path, {}, `10.1.0.${path.length}`)].map((r) => r.statusCode), [200, 200, 429], path);
    }
    await app.close();
  });

  test('switched off it limits nothing; a bad setting is refused at start', async () => {
    const { app } = await server({ enabled: false, anonymousPerMinute: 1, credentialPerMinute: 1, newCredentialsPerMinute: 1 });
    for (let n = 0; n < 10; n += 1) assert.equal((await call(app, '/api/v1/me')).statusCode, 200);
    await app.close();
    for (const bad of [{ credentialPerMinute: 0 }, { windowMs: 0 }, { maxKeys: 1.5 }]) assert.throws(() => useApiRateLimit(Fastify(), { enabled: true, ...bad }), /Invalid API rate limit/);
  });

  test('memory stays bounded: a stream of new credentials past maxKeys evicts the oldest and still counts', async () => {
    const { app } = await server({ maxKeys: 8, newCredentialsPerMinute: 100_000, credentialPerMinute: 2 });
    for (let n = 0; n < 200; n += 1) assert.equal((await call(app, '/api/v1/me', cookie(`c${n}`), `10.2.${n % 250}.1`)).statusCode, 200);
    // A credential that is current is still limited after thousands of others came and went.
    const answers = [];
    for (let n = 0; n < 3; n += 1) answers.push((await call(app, '/api/v1/me', cookie('steady'), '10.3.0.1')).statusCode);
    assert.deepEqual(answers, [200, 200, 429]);
    await app.close();
  });

  test('the credential is hashed: the table never holds a session token, and Authorization wins over a cookie', () => {
    const token = 'secret-session-token-value';
    const key = credentialKey({ headers: cookie(token) });
    assert.match(key ?? '', /^[0-9a-f]{32}$/);
    assert.ok(!key!.includes(token));
    assert.notEqual(credentialKey({ headers: { authorization: 'Bearer x', ...cookie(token) } }), key);
    assert.equal(credentialKey({ headers: { cookie: 'theme=dark' } }), null);
    assert.equal(credentialKey({ headers: {} }), null);
    assert.ok(API_RATE_LIMIT.credentialPerMinute > API_RATE_LIMIT.anonymousPerMinute);
  });

  test('Flux\'s own session cookie is the credential, over http and https; another name is not', () => {
    assert.equal(SESSION_COOKIE_PREFIX, 'flux');
    const plain = credentialKey({ headers: { cookie: 'flux.session_token=abc' } });
    assert.match(plain ?? '', /^[0-9a-f]{32}$/);
    assert.equal(credentialKey({ headers: { cookie: 'theme=dark; __Secure-flux.session_token=abc' } }), plain, 'the same session over https');
    assert.equal(credentialKey({ headers: { cookie: 'better-auth.session_token=abc' } }), null, 'the library\'s default name is not what Flux sets');
    assert.equal(credentialKey({ headers: { cookie: 'xflux.session_token=abc' } }), null);
  });
});
