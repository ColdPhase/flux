import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AUTH_SIGN_OUT_PATH } from '@flux/contracts';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { credentialOf, API_RATE_LIMIT } from '../../apps/server/src/http/rate-limit.js';
import { sessionCookieName } from '../../apps/server/src/identity/session-cookie.js';

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

const config = loadServerConfig(env, '/nonexistent/flux_background_key');
let app: FastifyInstance;
before(async () => {
  assert.equal(config.identity.rateLimit, true);
  app = await buildApp(config);
}, { timeout: 120_000 });
after(async () => { await app?.close(); });

/** Signs a new person up from `address` (Better Auth limits sign-ups per address) and answers the session cookie as the browser sends it. */
async function signUp(name: string, address: string, on: FastifyInstance = app, origin: string = config.identity.publicOrigin) {
  const response = await on.inject({ method: 'POST', url: '/api/auth/sign-up/email', remoteAddress: address,
    headers: { origin, 'content-type': 'application/json' },
    payload: { name, email: `limit.${randomUUID()}@example.test`, password: 'a long calm passphrase' } });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const session = setCookie.map((line) => line.split(';', 1)[0]!).find((pair) => /session_token=/.test(pair));
  assert.ok(session, `a session cookie was set: ${setCookie.join(' | ')}`);
  return session;
}
const meAs = (cookie: string, remoteAddress: string, headers: Record<string, string> = {}, on: FastifyInstance = app) =>
  on.inject({ method: 'GET', url: '/api/v1/me', remoteAddress, headers: { cookie, ...headers } });
/** The answers of `count` requests, as [status, how many] in the order they first came. */
async function tally(count: number, run: (n: number) => Promise<{ statusCode: number }>) {
  const counts = new Map<number, number>();
  for (let n = 0; n < count; n += 1) {
    const status = (await run(n)).statusCode;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts];
}

test('the cookie of a real sign-in is the credential, and two people at one address do not share a budget', { timeout: 120_000 }, async () => {
  const ada = await signUp('Limit Ada', '10.20.0.1');
  const jonas = await signUp('Limit Jonas', '10.20.0.2');
  const adaKey = credentialOf({ url: '/api/v1/me', headers: { cookie: ada } }, sessionCookieName(false));
  assert.ok(adaKey, `the limit recognises the cookie a real sign-in sets (${ada.split('=')[0]})`);
  const jonasKey = credentialOf({ url: '/api/v1/me', headers: { cookie: jonas } }, sessionCookieName(false));
  assert.ok(jonasKey && jonasKey.key !== adaKey.key);

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
  // A made-up session cookie never gets a budget of its own (#1022): from one address, however many of them are sent, the address's count for
  // credentials the server has not accepted is all there is, even to a route that answers any cookie with a 200.
  const forged = new Map<number, number>();
  for (let n = 0; n < API_RATE_LIMIT.newCredentialsPerMinute + 5; n += 1) {
    const status = (await app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: '10.20.0.77', headers: { cookie: `flux.session_token=made-up-${n}.${randomUUID()}` } })).statusCode;
    forged.set(status, (forged.get(status) ?? 0) + 1);
  }
  assert.deepEqual([...forged], [[200, API_RATE_LIMIT.newCredentialsPerMinute], [429, 5]]);
  const sameForged = `flux.session_token=made-up-0.${randomUUID()}`;
  const first = await app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: '10.20.0.78', headers: { cookie: sameForged } });
  assert.equal(first.statusCode, 200);
  for (let n = 0; n < 30; n += 1) await app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: '10.20.0.78', headers: { cookie: sameForged } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', remoteAddress: '10.20.0.78', headers: { cookie: sameForged } })).statusCode, 401, 'a made-up cookie is still a 401 where a session is needed');
});

// The key is what the server checked (#1022, review of #1033): a request that carries something else next to the session, a made-up bearer, a
// decoy cookie before the real one, a space after it, gets no budget of its own and is counted under the session the server resolved.
test('a session that is past its budget stays there: a made-up bearer, a decoy cookie or a space around the real one are not another credential', { timeout: 120_000 }, async () => {
  const person = await signUp('Limit Bearer', '10.21.0.1');
  const [name, value] = [person.split('=', 1)[0]!, person.slice(person.indexOf('=') + 1)];
  const from = '10.21.0.9';
  const total = await tally(API_RATE_LIMIT.credentialPerMinute + 1, () => meAs(person, from));
  assert.deepEqual(total, [[200, API_RATE_LIMIT.credentialPerMinute + 1]], 'one charged to the address, then the 1,200 of its own');
  assert.equal((await meAs(person, from)).statusCode, 429, 'the session is past its budget');
  // The same cookie with a made-up bearer each time (the review found 1,200 more requests for each).
  assert.deepEqual(await tally(5, (n) => meAs(person, from, { authorization: `Bearer junk-${n}` })), [[429, 5]], 'a bearer next to the cookie is nothing');
  assert.deepEqual(await tally(3, (n) => meAs(person, '10.21.0.10', { authorization: `Bearer junk-${n + 10}` })), [[429, 3]], 'from another address too: the session\'s own count follows it');
  // A decoy placed before the real cookie, of the name that is read and of the name that is not (over http Better Auth reads `flux.session_token`).
  assert.deepEqual(await tally(3, (n) => meAs(`__Secure-${name}=junk-${n}; ${person}`, from)), [[429, 3]], 'a decoy of the other name changes nothing');
  // The same session written with a space after it, before it, quotes, or the signature percent-decoded: Better Auth reads one session.
  const decoded = decodeURIComponent(value);
  const spelled = [`${name}=${value} `, `${name}= ${value}`, `${name}="${value}"`, `${name}=${decoded}`, `${person};`, `theme=dark;${person}`, `${name}=${value}   ; theme=dark`];
  assert.deepEqual(await tally(spelled.length, (n) => meAs(spelled[n]!, from)), [[429, spelled.length]], `one session, not ${spelled.length} more`);
  // A decoy of the right name placed first is the cookie Better Auth reads (the first one): a made-up session. It is never accepted either.
  assert.deepEqual(await tally(API_RATE_LIMIT.newCredentialsPerMinute + 5, (n) => meAs(`${name}=junk-${n}.${randomUUID()}; ${person}`, '10.21.0.20')),
    [[401, API_RATE_LIMIT.newCredentialsPerMinute], [429, 5]], 'made-up cookies are the address\'s count, with the real session behind them');
});

test('a session that is signed out loses its budget of its own: the next 401 sends it back to the address', { timeout: 120_000 }, async () => {
  const person = await signUp('Limit Gone', '10.22.0.1');
  const from = '10.22.0.9';
  assert.equal((await meAs(person, from)).statusCode, 200, 'accepted');
  const out = await app.inject({ method: 'POST', url: AUTH_SIGN_OUT_PATH, remoteAddress: from,
    headers: { origin: config.identity.publicOrigin, 'content-type': 'application/json', cookie: person }, payload: {} });
  assert.equal(out.statusCode, 200, out.body);
  // The signed-out cookie is a 401 each time. The first one still ends the budget it had; the rest are counted to the address, which a
  // made-up cookie then finds used up (it would find it untouched if the dead session still had a count of its own).
  assert.deepEqual(await tally(API_RATE_LIMIT.newCredentialsPerMinute - 50, () => meAs(person, from)), [[401, API_RATE_LIMIT.newCredentialsPerMinute - 50]]);
  const made = await tally(60, (n) => app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: from, headers: { cookie: `flux.session_token=made-up-${n}.${randomUUID()}` } }));
  assert.equal(made.at(-1)?.[0], 429, `the address is used up by the dead session's requests: ${JSON.stringify(made)}`);
});

test('an IPv6 client is counted by its /64: addresses of one block share the address budgets, another block does not (#1040)', { timeout: 120_000 }, async () => {
  const block = (network: string, n: number) => `${network}:${(n + 1).toString(16)}::${(n * 7 + 1).toString(16)}`;
  const anonymous = await tally(API_RATE_LIMIT.anonymousPerMinute + 5, (n) => app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: block('2001:db8:77:5', n % 40) }));
  assert.deepEqual(anonymous, [[200, API_RATE_LIMIT.anonymousPerMinute], [429, 5]], '40 addresses of one /64 are one client');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: '2001:db8:77:6::1' })).statusCode, 200, 'another /64');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: '10.23.0.1' })).statusCode, 200, 'an IPv4 address is its own');
  const made = await tally(API_RATE_LIMIT.newCredentialsPerMinute + 5, (n) => app.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: block('2001:db8:78:5', n % 40),
    headers: { cookie: `flux.session_token=made-up-${n}.${randomUUID()}` } }));
  assert.deepEqual(made, [[200, API_RATE_LIMIT.newCredentialsPerMinute], [429, 5]], 'made-up cookies from one /64 are one address\'s count');
});

test('over https the prefixed cookie is the one that is read and accepted, and a plain cookie placed before it is ignored', { timeout: 120_000 }, async () => {
  const origin = 'https://flux.example.test';
  const secure = await buildApp(loadServerConfig({ ...env, FLUX_PUBLIC_ORIGIN: origin }, '/nonexistent/flux_background_key'));
  try {
    const person = await signUp('Limit Secure', '10.24.0.1', secure, origin);
    assert.match(person, /^__Secure-flux\.session_token=/, 'Better Auth sets the prefixed name over https');
    assert.equal((await meAs(person, '10.24.0.2', {}, secure)).statusCode, 200, 'accepted');
    // The address is used up by made-up cookies; the accepted session has a budget of its own and is not held by it.
    await tally(API_RATE_LIMIT.newCredentialsPerMinute + 5, (n) => secure.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: '10.24.0.3', headers: { cookie: `__Secure-flux.session_token=made-up-${n}.${randomUUID()}` } }));
    assert.equal((await secure.inject({ method: 'GET', url: '/api/v1/auth/capabilities', remoteAddress: '10.24.0.3', headers: { cookie: '__Secure-flux.session_token=made-up-x.y' } })).statusCode, 429, 'the address is used up');
    assert.equal((await meAs(person, '10.24.0.3', {}, secure)).statusCode, 200, 'the session has its own budget');
    assert.equal((await meAs(`flux.session_token=junk-1.${randomUUID()}; ${person}`, '10.24.0.3', {}, secure)).statusCode, 200, 'a plain decoy before it is not what is read');
    assert.equal((await meAs(`${person} `, '10.24.0.3', {}, secure)).statusCode, 200);
    assert.equal((await meAs(`__Secure-flux.session_token=junk-2.${randomUUID()}; ${person}`, '10.24.0.3', {}, secure)).statusCode, 429, 'a decoy of the name that is read is the cookie that is read: a made-up session, the address\'s count');
  } finally {
    await secure.close();
  }
});
