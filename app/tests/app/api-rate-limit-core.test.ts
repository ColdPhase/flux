import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { useDomainErrors } from '../../apps/server/src/http/errors.js';
import { SESSION_COOKIE_PREFIX, sessionCookieName } from '../../apps/server/src/identity/session-cookie.js';
import { API_RATE_LIMIT, addressKey, credentialOf, useApiRateLimit, type ApiRateLimitOptions } from '../../apps/server/src/http/rate-limit.js';

// The API-wide request limit (#838, CodeQL js/missing-rate-limiting): per credential the server has accepted, per address without one, and per
// address for credentials it has not accepted (#1022); only API traffic counts; the answer is the domain 429 with Retry-After. No database,
// network or process: Fastify's inject and a clock. A route plays the session resolver: it accepts the credential with the token of the session
// its cookie names (`requirePrincipal` does), unless that session has ended (a 401); `/api/v1/open` answers 200 to any cookie without ever
// accepting it; `/mcp` plays the MCP route (a bearer that is not `junk-…` or revoked is answered, any other gets a 401 from a hijacked reply).
// That the cookie name here is the one a real sign-in sets and that Better Auth reads the cookie the way the limit does is
// tests/app/api-rate-limit.test.ts.

async function server(options: Partial<ApiRateLimitOptions> = {}, clock = { at: 1_000_000 }) {
  const app = Fastify({ logger: false });
  useDomainErrors(app);
  useApiRateLimit(app, { enabled: true, now: () => clock.at, ...options });
  const name = options.sessionCookie ?? sessionCookieName(false);
  const ended = new Set<string>();
  const revoked = new Set<string>();
  const sessionOf = (request: FastifyRequest) => {
    for (const part of String(request.headers.cookie ?? '').split(';')) {
      if (part.split('=', 1)[0]!.trim() !== name) continue;
      const value = part.slice(part.indexOf('=') + 1).trim();
      return value.startsWith('"') ? value.slice(1, -1) : value;
    }
    return null;
  };
  const me = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = sessionOf(request);
    if (token && ended.has(token)) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    if (token) request.acceptCredential?.({ sessionToken: token });
    return { ok: true };
  };
  for (const path of ['/api/v1/me', '/health', '/.well-known/oauth-protected-resource', '/assets/app.js', '/sign-in']) app.get(path, me);
  app.get('/api/v1/open', async () => ({ ok: true }));
  // A route that accepts a session other than the one the request's cookie names, and one that accepts a bearer: neither may give the cookie a budget.
  app.get('/api/v1/swap', async (request) => { request.acceptCredential?.({ sessionToken: 'someone-else' }); return { ok: true }; });
  app.get('/api/v1/bearer', async (request) => { request.acceptCredential?.({ bearer: true }); return { ok: true }; });
  app.get('/mcp', async (request, reply) => {
    reply.hijack();
    const authorization = String(request.headers.authorization ?? '');
    const refused = /junk|revoked/.test(authorization) || revoked.has(authorization);
    if (refused) request.refuseCredential?.();
    else if (authorization) request.acceptCredential?.({ bearer: true });
    reply.raw.writeHead(refused ? 401 : 200, { 'content-type': 'application/json' });
    reply.raw.end('{}');
  });
  await app.ready();
  return { app, clock, ended, revoked };
}
const call = (app: FastifyInstance, url: string, headers: Record<string, string> = {}, remoteAddress = '10.0.0.1') => app.inject({ method: 'GET', url, headers, remoteAddress });
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE_PREFIX}.session_token=${token}; theme=dark` });
const statuses = async (count: number, run: (n: number) => Promise<{ statusCode: number }>) => {
  const answers: number[] = [];
  for (let n = 0; n < count; n += 1) answers.push((await run(n)).statusCode);
  return answers;
};

describe('the API request limit', () => {
  test('a credential has its own window: the call past the limit is a 429 with Retry-After, another credential is untouched, the window ends', async () => {
    const { app, clock } = await server({ credentialPerMinute: 3 });
    assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200, 'the first call is charged to the address and accepts the credential');
    for (let n = 0; n < 3; n += 1) assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200);
    clock.at += 20_000;
    const refused = await call(app, '/api/v1/me', cookie('ada'));
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().code, 'RATE_LIMITED');
    assert.equal(refused.headers['retry-after'], '40', 'the seconds left in the minute that began with the first call of its own');
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
    for (let n = 0; n < 6; n += 1) assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200, 'signed-in calls are not the anonymous count');
    await app.close();
  });

  test('a made-up credential is never its own: every request with one is charged to the address, however many cookies there are (#1022)', async () => {
    const { app, clock } = await server({ newCredentialsPerMinute: 5, credentialPerMinute: 2 });
    const answers = [];
    // /api/v1/open answers 200 to any cookie and accepts none, as an anonymous route does.
    for (let n = 0; n < 7; n += 1) answers.push((await call(app, '/api/v1/open', cookie(`made-up-${n}`))).statusCode);
    assert.deepEqual(answers, [200, 200, 200, 200, 200, 429, 429], 'one cookie each, and the address\'s budget is all there is');
    assert.equal((await call(app, '/api/v1/open', cookie('made-up-0'))).statusCode, 429, 'a cookie that was seen before has no budget of its own either');
    const one = [];
    for (let n = 0; n < 3; n += 1) one.push((await call(app, '/api/v1/open', cookie('made-up-0'), '10.0.0.9')).statusCode);
    assert.deepEqual(one, [200, 200, 200], 'another address; the credential\'s own limit (2) was never in play');
    clock.at += 60_000;
    assert.equal((await call(app, '/api/v1/open', cookie('made-up-6'))).statusCode, 200, 'the next minute');
    await app.close();
  });

  test('a credential the server has accepted has a window of its own, and the address is not charged for it any more', async () => {
    const { app } = await server({ newCredentialsPerMinute: 3, credentialPerMinute: 100 });
    assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200, 'the first call is charged to the address, and accepted');
    for (let n = 0; n < 20; n += 1) assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200, `call ${n}`);
    for (let n = 0; n < 2; n += 1) assert.equal((await call(app, '/api/v1/open', cookie(`made-up-${n}`))).statusCode, 200);
    assert.equal((await call(app, '/api/v1/me', cookie('ada'))).statusCode, 200, 'the address\'s budget is not what Ada spends');
    await app.close();
  });

  test('many people behind one address are not limited together: no address-wide total exists', async () => {
    const { app } = await server({ credentialPerMinute: 30, anonymousPerMinute: 5, newCredentialsPerMinute: 600 });
    // 300 people, 31 requests each (9,300 in the minute) from one address: every one answered. The first is charged to the address, the other 30
    // are the person's own.
    for (let person = 0; person < 300; person += 1) {
      for (let n = 0; n < 31; n += 1) assert.equal((await call(app, '/api/v1/me', cookie(`person-${person}`))).statusCode, 200, `person ${person} request ${n}`);
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
    for (let n = 0; n < 4; n += 1) answers.push((await call(app, '/api/v1/me', cookie('steady'), '10.3.0.1')).statusCode);
    assert.deepEqual(answers, [200, 200, 200, 429], 'one charged to the address, then its own two');
    await app.close();
  });

  test('the credential is hashed: the table never holds a session token, and the header is not part of a cookie\'s key', () => {
    const token = 'secret-session-token-value';
    const key = credentialOf({ url: '/api/v1/me', headers: cookie(token) });
    assert.equal(key?.kind, 'session');
    assert.match(key?.key ?? '', /^[0-9a-f]{32}$/);
    assert.ok(!key!.key.includes(token));
    assert.deepEqual(credentialOf({ url: '/api/v1/me', headers: { authorization: 'Bearer x', ...cookie(token) } }), key, 'an Authorization header changes nothing outside /mcp');
    assert.equal(credentialOf({ url: '/api/v1/me', headers: { authorization: 'Bearer x' } }), null, 'and is no credential of its own there');
    assert.equal(credentialOf({ url: '/api/v1/me', headers: { cookie: 'theme=dark' } }), null);
    assert.equal(credentialOf({ url: '/api/v1/me', headers: {} }), null);
    assert.ok(API_RATE_LIMIT.credentialPerMinute > API_RATE_LIMIT.anonymousPerMinute);
  });

  test('the session cookie is read the way Better Auth reads it: its name only, the first of that name, trimmed and decoded, without the signature (#1022)', () => {
    assert.equal(SESSION_COOKIE_PREFIX, 'flux');
    const key = (header: string, name?: string) => credentialOf({ url: '/api/v1/me', headers: { cookie: header } }, name)?.key ?? null;
    const plain = key('flux.session_token=abc.sig');
    assert.match(plain ?? '', /^[0-9a-f]{32}$/);
    // The name Better Auth reads is one: `__Secure-` only over https, and a cookie of the other name is no credential.
    const secure = sessionCookieName(true);
    assert.equal(secure, '__Secure-flux.session_token');
    assert.equal(key('theme=dark; __Secure-flux.session_token=abc.sig', secure), plain, 'the same session over https');
    assert.equal(key('__Secure-flux.session_token=abc.sig'), null, 'over http the prefixed name is not read');
    assert.equal(key('flux.session_token=abc.sig', secure), null, 'over https the plain name is not read');
    assert.equal(key('better-auth.session_token=abc.sig'), null, 'the library\'s default name is not what Flux sets');
    assert.equal(key('xflux.session_token=abc.sig'), null);
    // A decoy placed before the real cookie is the one Better Auth reads (the first of its name), and a decoy of the other name is ignored.
    const decoy = key('flux.session_token=junk.sig');
    assert.notEqual(decoy, plain);
    assert.equal(key('flux.session_token=junk.sig; flux.session_token=abc.sig'), decoy, 'the first one counts');
    assert.equal(key('__Secure-flux.session_token=junk.sig; flux.session_token=abc.sig'), plain, 'a decoy of the name that is not read changes nothing');
    assert.equal(key('flux.session_token=abc.sig; __Secure-flux.session_token=junk.sig', secure), key('__Secure-flux.session_token=junk.sig', secure));
    // Spaces, quotes and percent-encoding are not new credentials.
    for (const same of ['flux.session_token=abc.sig ', 'flux.session_token= abc.sig', '  flux.session_token =abc.sig;', 'flux.session_token="abc.sig"', 'flux.session_token=a%62c.sig', 'flux.session_token=abc%2Esig', 'theme=dark;flux.session_token=abc.sig']) {
      assert.equal(key(same), plain, same);
    }
    // The signature is not part of the key: its last base64 character carries bits that are ignored, so one session is written several ways.
    const sign = (last: string) => `flux.session_token=abc.${'A'.repeat(42)}${last}=`;
    assert.equal(key(sign('A')), key(sign('B')));
    assert.equal(key(sign('A')), plain);
    assert.notEqual(key('flux.session_token=abd.sig'), plain);
    assert.equal(key('flux.session_token='), null);
  });

  test('on /mcp the bearer is the credential and cookies are nothing; the signature, the scheme\'s case and spaces are not new credentials', () => {
    const key = (headers: Record<string, string>, url = '/mcp') => credentialOf({ url, headers });
    const bearer = key({ authorization: 'Bearer head.body.sigA' });
    assert.equal(bearer?.kind, 'bearer');
    assert.match(bearer?.key ?? '', /^[0-9a-f]{32}$/);
    for (const same of ['bearer head.body.sigB', 'Bearer   head.body.sigA  ', 'BEARER head.body.x']) assert.deepEqual(key({ authorization: same }), bearer, same);
    assert.notEqual(key({ authorization: 'Bearer head.other.sigA' })?.key, bearer?.key);
    assert.deepEqual(key({ authorization: 'Bearer head.body.sigA', ...cookie('ada') }), bearer, 'a cookie next to it changes nothing');
    assert.equal(key({ ...cookie('ada') }), null, 'a cookie alone is no credential on /mcp');
    assert.equal(key({ authorization: 'junk' }), null);
    assert.equal(key({ authorization: 'Bearer head.body.sigA' }, '/mcp?x=1')?.key, bearer?.key);
    assert.equal(key({ authorization: 'Bearer head.body.sigA' }, '/api/v1/me'), null, 'outside /mcp the header is nothing');
    assert.equal(key({ authorization: 'Bearer head.body.sigA' }, '/mcpx'), null);
  });

  test('a cookie with a made-up bearer next to it is one credential, however many bearers are sent (#1022)', async () => {
    const { app } = await server({ credentialPerMinute: 2, newCredentialsPerMinute: 1000, anonymousPerMinute: 1000 });
    const answers = await statuses(6, (n) => call(app, '/api/v1/me', { ...cookie('ada'), authorization: `Bearer junk-${n}` }));
    assert.deepEqual(answers, [200, 200, 200, 429, 429, 429], 'one charged to the address, then the cookie\'s own two: the bearers got no budget');
    await app.close();
  });

  test('a decoy cookie, a cookie with spaces around it, or the other cookie name do not make a second credential (#1022)', async () => {
    const { app } = await server({ credentialPerMinute: 2, newCredentialsPerMinute: 1000, anonymousPerMinute: 1000 });
    const variants = ['flux.session_token=ada', 'flux.session_token=ada ', 'flux.session_token= ada', '__Secure-flux.session_token=junk-1; flux.session_token=ada', '__Secure-flux.session_token=junk-2; flux.session_token="ada"', 'flux.session_token=ada;'];
    const answers = await statuses(variants.length, (n) => call(app, '/api/v1/me', { cookie: variants[n]! }));
    assert.deepEqual(answers, [200, 200, 200, 429, 429, 429]);
    await app.close();
    // Over https the name that is read is the prefixed one; a plain cookie placed first is not what the session comes from.
    const https = await server({ credentialPerMinute: 2, newCredentialsPerMinute: 1000, sessionCookie: sessionCookieName(true) });
    const secure = ['__Secure-flux.session_token=ada', 'flux.session_token=junk-1; __Secure-flux.session_token=ada', '__Secure-flux.session_token=ada ', 'flux.session_token=junk-2; __Secure-flux.session_token=ada', '__Secure-flux.session_token=ada'];
    assert.deepEqual(await statuses(secure.length, (n) => call(https.app, '/api/v1/me', { cookie: secure[n]! })), [200, 200, 200, 429, 429]);
    await https.app.close();
  });

  test('a route that accepts another session than the one the cookie names, or a bearer, gives the cookie no budget of its own (#1022)', async () => {
    const { app } = await server({ credentialPerMinute: 1, newCredentialsPerMinute: 3, anonymousPerMinute: 1000 });
    assert.deepEqual(await statuses(5, () => call(app, '/api/v1/swap', cookie('ada'))), [200, 200, 200, 429, 429], 'the address\'s budget is all there is');
    const bearer = await server({ credentialPerMinute: 1, newCredentialsPerMinute: 3, anonymousPerMinute: 1000 });
    assert.deepEqual(await statuses(5, () => call(bearer.app, '/api/v1/bearer', cookie('ben'))), [200, 200, 200, 429, 429], 'a bearer is not what a cookie is accepted with');
    await app.close();
    await bearer.app.close();
  });

  test('outside /mcp an Authorization header is no credential: made-up headers are the address\'s anonymous count', async () => {
    const { app } = await server({ anonymousPerMinute: 2, newCredentialsPerMinute: 1000, credentialPerMinute: 1000 });
    assert.deepEqual(await statuses(4, (n) => call(app, '/api/v1/open', { authorization: `Bearer junk-${n}` })), [200, 200, 429, 429]);
    await app.close();
  });

  test('on /mcp a bearer is accepted once it is not answered with a 401; a 401 takes the budget away (#1022)', async () => {
    const { app, revoked } = await server({ credentialPerMinute: 2, newCredentialsPerMinute: 3, anonymousPerMinute: 1000 });
    // Made-up bearers are 401 and never accepted: the address's count is all there is.
    assert.deepEqual(await statuses(5, (n) => call(app, '/mcp', { authorization: `Bearer junk-${n}` }, '10.0.0.5')), [401, 401, 401, 429, 429]);
    // A bearer the server answers has a budget of its own: one charged to the address, then two.
    assert.deepEqual(await statuses(4, () => call(app, '/mcp', { authorization: 'Bearer good.token.sig' }, '10.0.0.6')), [200, 200, 200, 429]);
    // Cookies are nothing on /mcp.
    assert.deepEqual(await statuses(3, () => call(app, '/mcp', cookie('ada'), '10.0.0.7')), [200, 200, 200], 'anonymous: 1,000 a minute');
    // Revoked after it was accepted: the next 401 ends its own budget, so the rest is the address's again (3 in all, then 429).
    const second = { authorization: 'Bearer second.token.sig' };
    assert.equal((await call(app, '/mcp', second, '10.0.0.8')).statusCode, 200);
    revoked.add('Bearer second.token.sig');
    assert.deepEqual(await statuses(4, () => call(app, '/mcp', second, '10.0.0.8')), [401, 401, 401, 429]);
    await app.close();
  });

  test('a 401 for an accepted session takes its budget away: a signed-out or expired session is the address\'s again (#1022)', async () => {
    const { app, ended } = await server({ credentialPerMinute: 100, newCredentialsPerMinute: 3, anonymousPerMinute: 1000 });
    assert.equal((await call(app, '/api/v1/me', cookie('ada'), '10.0.0.8')).statusCode, 200, 'accepted');
    for (let n = 0; n < 5; n += 1) assert.equal((await call(app, '/api/v1/me', cookie('ada'), '10.0.0.8')).statusCode, 200, 'its own budget; the address is not charged');
    ended.add('ada');
    // The first 401 is still counted under the budget that was its own; the rest are the address's (the first call above and two more, then 429).
    assert.deepEqual(await statuses(5, () => call(app, '/api/v1/me', cookie('ada'), '10.0.0.8')), [401, 401, 401, 429, 429]);
    // A session that works again is accepted again, from the address's count.
    ended.delete('ada');
    for (let n = 0; n < 6; n += 1) assert.equal((await call(app, '/api/v1/me', cookie('ada'), '10.0.0.9')).statusCode, 200, `call ${n}`);
    await app.close();
  });

  test('an IPv6 client counts by its /64 in the per-address limits; an IPv4 address by itself (#1040)', async () => {
    const { app } = await server({ anonymousPerMinute: 2, newCredentialsPerMinute: 3, credentialPerMinute: 1000 });
    // Three addresses of one /64 share the anonymous count of the address.
    const block = ['2001:db8:1:2::1', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:DB8:0001:0002:0:0:0:9'];
    assert.deepEqual(await statuses(3, (n) => call(app, '/api/v1/open', {}, block[n]!)), [200, 200, 429]);
    assert.equal((await call(app, '/api/v1/open', {}, '2001:db8:1:3::1')).statusCode, 200, 'another /64');
    // And the made-up credentials: four cookies from four addresses of one /64 are one address\'s count.
    const made = ['2001:db8:9:9::1', '2001:db8:9:9::2', '2001:db8:9:9:ffff::3', '2001:db8:9:9::4'];
    assert.deepEqual(await statuses(4, (n) => call(app, '/api/v1/open', cookie(`made-up-${n}`), made[n]!)), [200, 200, 200, 429]);
    // IPv4 stays per address: two neighbours are two clients, and an IPv4-mapped IPv6 address is the IPv4 one.
    assert.deepEqual(await statuses(3, () => call(app, '/api/v1/open', {}, '192.0.2.1')), [200, 200, 429]);
    assert.equal((await call(app, '/api/v1/open', {}, '192.0.2.2')).statusCode, 200);
    assert.equal((await call(app, '/api/v1/open', {}, '::ffff:192.0.2.1')).statusCode, 429);
    await app.close();
  });

  test('addressKey: IPv4 as it is, an IPv4-mapped address as IPv4, other IPv6 by the first 64 bits in any spelling', () => {
    assert.equal(addressKey('10.0.0.1'), '10.0.0.1');
    assert.equal(addressKey('::ffff:10.0.0.1'), '10.0.0.1');
    assert.equal(addressKey('::ffff:a00:1'), '10.0.0.1');
    assert.equal(addressKey('::FFFF:10.0.0.1'), '10.0.0.1');
    const block = addressKey('2001:db8:1:2::1');
    assert.equal(block, '2001:db8:1:2::/64');
    for (const same of ['2001:db8:1:2::', '2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002:0000:0000:0000:0001', '2001:db8:1:2:3:4:5:6', '2001:db8:1:2:0:0:192.0.2.1']) assert.equal(addressKey(same), block, same);
    for (const other of ['2001:db8:1:3::1', '2001:db8:1::2:1', '2001:db8:2:2::1', '2002:db8:1:2::1']) assert.notEqual(addressKey(other), block, other);
    assert.equal(addressKey('2001:db8::'), '2001:db8:0:0::/64');
    assert.equal(addressKey('2001:db8:0:0:1::'), '2001:db8:0:0::/64');
    assert.equal(addressKey('::1'), '0:0:0:0::/64');
    assert.equal(addressKey('fe80::1%eth0'), addressKey('fe80::abcd'));
    assert.equal(addressKey('unknown'), 'unknown', 'what is no address is kept as it is');
    assert.equal(addressKey(''), '');
  });
});
