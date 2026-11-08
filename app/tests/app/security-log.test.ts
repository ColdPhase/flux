import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { DomainError } from '@flux/core';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { authSecurityEvent, failureCode } from '../../apps/server/src/identity/security-events.js';
import { useDomainErrors } from '../../apps/server/src/http/errors.js';
import { createRequestIdGenerator, requestLogSerializer } from '../../apps/server/src/http/log-serializers.js';
import { accountKey, audited, createDenialSampler, securityEvent, type SecurityLogger } from '../../apps/server/src/security-log.js';
import { database } from './support/db.js';

// #997: the security event log (docs/operations/monitoring.md#security-events). Pure parts first, then the real identity routes in-process with a
// log stream, so every line the server writes during a sign-in, a reset or a refusal can be read back and searched for secrets.

const ORIGIN = 'https://flux.example.org';
// The check stack's own secret: the signing keys in its database are encrypted with it, and a session read opens them.
const SECRET = process.env.FLUX_AUTH_SECRET ?? randomBytes(32).toString('hex');
const STRONG = 'a lantern on the harbour wall';

function recorder() {
  const lines: Record<string, unknown>[] = [];
  const log: SecurityLogger = { info: (object, message) => { lines.push({ level: 'info', ...object, msg: message }); }, warn: (object, message) => { lines.push({ level: 'warn', ...object, msg: message }); } };
  return { lines, log };
}

describe('the event line', () => {
  test('carries the channel, event and outcome; warns on a failure and informs on a success; copies only the known fields', () => {
    const { lines, log } = recorder();
    securityEvent(log, { event: 'sign_in', outcome: 'failure', reason: 'bad_credentials', account: 'abc123', ip: '203.0.113.5', reqId: 'req-9' });
    securityEvent(log, { event: 'sign_in', outcome: 'success', userId: 'user-1', ...({ password: 'hunter2hunter2', token: 'abc', email: 'a@b.test' } as object) });
    assert.deepEqual(lines[0], { level: 'warn', channel: 'security', event: 'sign_in', outcome: 'failure', reason: 'bad_credentials', account: 'abc123', ip: '203.0.113.5', reqId: 'req-9',
      msg: 'Security event: sign_in failure' });
    assert.deepEqual(lines[1], { level: 'info', channel: 'security', event: 'sign_in', outcome: 'success', userId: 'user-1', msg: 'Security event: sign_in success' });
  });

  test('a reason or route that is free text, or carries a query, is logged as "other"', () => {
    const { lines, log } = recorder();
    securityEvent(log, { event: 'origin_refused', outcome: 'refused', reason: 'Origin https://evil.example said "hi"', route: '/api/v1/search?q=secret text' });
    assert.equal(lines[0]!.reason, 'other');
    assert.equal(lines[0]!.route, 'other');
    securityEvent(log, { event: 'access_denied', outcome: 'denied', reason: 'WORKSPACE_FORBIDDEN', route: 'GET /api/v1/projects/:projectId' });
    assert.equal(lines[1]!.reason, 'WORKSPACE_FORBIDDEN');
    assert.equal(lines[1]!.route, 'GET /api/v1/projects/:projectId');
  });

  test('an account key is the same for the same address in any case, differs between addresses and between servers, and is not the address', () => {
    assert.equal(accountKey(SECRET, 'Ada@Example.test '), accountKey(SECRET, 'ada@example.test'));
    assert.notEqual(accountKey(SECRET, 'ada@example.test'), accountKey(SECRET, 'bob@example.test'));
    assert.notEqual(accountKey(SECRET, 'ada@example.test'), accountKey(randomBytes(32).toString('hex'), 'ada@example.test'));
    assert.match(accountKey(SECRET, 'ada@example.test'), /^[0-9a-f]{16}$/);
  });

  test('audited records success, and a failure with its code but not its message, then throws it again', async () => {
    const { lines, log } = recorder();
    assert.equal(await audited(log, { event: 'space_lock', userId: 'u1', workspaceId: 'w1' }, async () => 'locked'), 'locked');
    await assert.rejects(audited(log, { event: 'space_unlock', userId: 'u1', workspaceId: 'w1' }, async () => {
      throw Object.assign(new Error('the password swordfish is wrong'), { code: 'WORKSPACE_UNLOCK_FAILED' });
    }), /swordfish/);
    await assert.rejects(audited(log, { event: 'space_unlock', userId: 'u1', workspaceId: 'w1' }, async () => { throw new Error('boom with a secret'); }));
    assert.deepEqual(lines.map((line) => [line.event, line.outcome, line.reason]), [['space_lock', 'success', undefined], ['space_unlock', 'failure', 'WORKSPACE_UNLOCK_FAILED'], ['space_unlock', 'failure', 'error']]);
    assert.equal(JSON.stringify(lines).includes('swordfish'), false);
    assert.equal(JSON.stringify(lines).includes('secret'), false);
  });
});

describe('what a Better Auth route means', () => {
  const failed = (statusCode: number, code: string) => ({ statusCode, body: { code, message: 'free text that never reaches the log' } });

  test('sign-in, reset, change and consent routes map to events with a reason code only', () => {
    assert.equal(failureCode(undefined), null);
    assert.equal(failureCode({ token: 'x' }), null);
    assert.deepEqual(authSecurityEvent({ path: '/sign-in/email', body: { email: 'a@b.test', password: 'p' }, returned: failed(401, 'INVALID_EMAIL_OR_PASSWORD') }),
      { event: 'sign_in', outcome: 'failure', userId: undefined, reason: 'bad_credentials' });
    assert.deepEqual(authSecurityEvent({ path: '/sign-in/email', body: {}, returned: { user: {} }, userId: 'u1' }), { event: 'sign_in', outcome: 'success', userId: 'u1', reason: undefined });
    assert.equal(authSecurityEvent({ path: '/reset-password', body: {}, returned: failed(400, 'INVALID_TOKEN') })?.reason, 'invalid_token');
    assert.equal(authSecurityEvent({ path: '/change-password', body: {}, returned: failed(400, 'INVALID_PASSWORD'), userId: 'u1' })?.reason, 'bad_current_password');
    assert.equal(authSecurityEvent({ path: '/change-email', body: {}, returned: { status: true }, userId: 'u1' })?.event, 'email_changed');
    assert.equal(authSecurityEvent({ path: '/request-password-reset', body: {}, returned: { status: true } })?.event, 'password_reset_requested');
    assert.equal(authSecurityEvent({ path: '/get-session', body: {}, returned: {} }), null);
  });

  test('a consent decision names the client and the answer; a token refusal names the grant and the OAuth error', () => {
    const query = new URLSearchParams({ client_id: 'https://client.example/metadata.json', sig: 'abc' }).toString();
    assert.deepEqual(authSecurityEvent({ path: '/oauth2/consent', body: { accept: true, oauth_query: query }, returned: { url: 'https://x' }, userId: 'u1' }),
      { event: 'oauth_consent', outcome: 'allowed', userId: 'u1', clientId: 'https://client.example/metadata.json' });
    assert.equal(authSecurityEvent({ path: '/oauth2/consent', body: { accept: false, oauth_query: query }, returned: { url: 'https://x' }, userId: 'u1' })?.outcome, 'denied');
    assert.equal(authSecurityEvent({ path: '/oauth2/consent', body: { accept: true, oauth_query: 'client_id=x' }, returned: failed(400, 'invalid_request') })?.outcome, 'refused');
    const refused = authSecurityEvent({ path: '/oauth2/token', body: { grant_type: 'refresh_token', client_id: 'c1', refresh_token: 'SECRET-TOKEN' }, returned: failed(400, 'invalid_grant') });
    assert.deepEqual(refused, { event: 'oauth_token', outcome: 'refused', reason: 'refresh_token:invalid_grant', clientId: 'c1' });
    assert.equal(JSON.stringify(refused).includes('SECRET-TOKEN'), false);
    assert.equal(authSecurityEvent({ path: '/oauth2/token', body: { grant_type: 'refresh_token' }, returned: { access_token: 'x' } }), null, 'a success is a connection in use, not an event');
  });
});

describe('refused requests are bounded', () => {
  test('ten a minute per person are logged, the eleventh once as a summary, the rest are dropped; the next minute and other people start over', () => {
    let clock = 1_000;
    const sampler = createDenialSampler(() => clock);
    const first = Array.from({ length: 13 }, () => sampler('user-1'));
    assert.deepEqual(first, [...Array(10).fill('log'), 'summary', 'skip', 'skip']);
    assert.equal(sampler('user-2'), 'log');
    clock += 60_000;
    assert.equal(sampler('user-1'), 'log');
  });
});

describe('the real routes, with their log read back', () => {
  async function server(options: { rateLimit?: boolean } = {}) {
    const lines: Record<string, unknown>[] = [];
    const sent: { to: string; text: string }[] = [];
    // As the API builds its own: the request serializer drops query strings, and request ids come from the same generator.
    const instance = Fastify({ genReqId: createRequestIdGenerator(),
      logger: { level: 'info', serializers: { req: requestLogSerializer }, stream: { write: (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>); } } } });
    useDomainErrors(instance);
    const config = loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: ORIGIN, FLUX_AUTH_SECRET: SECRET, FLUX_AUTH_RATE_LIMIT: options.rateLimit ? 'true' : 'false' });
    const identity = registerIdentity(instance, { db: database.db, config, mailer: { send: async (message) => { sent.push(message); }, close: () => undefined } });
    // As a real route: it knows the person first (the session), then the access policy refuses.
    instance.get('/api/v1/probe/:projectId', async (request) => { await identity.requirePrincipal(request); throw new DomainError(403, 'PROJECT_FORBIDDEN', 'You cannot open this'); });
    await instance.ready();
    const security = () => lines.filter((line) => line.channel === 'security');
    return { instance, lines, sent, security };
  }
  const post = (instance: Awaited<ReturnType<typeof server>>['instance'], url: string, payload: unknown, extra: { remoteAddress?: string; cookie?: string; origin?: string } = {}) =>
    instance.inject({ method: 'POST', url, payload: payload as object, remoteAddress: extra.remoteAddress ?? '198.51.100.20',
      headers: { origin: extra.origin ?? ORIGIN, ...(extra.cookie ? { cookie: extra.cookie } : {}) } });
  const cookieOf = (response: { headers: Record<string, unknown> }) => ([] as string[]).concat(response.headers['set-cookie'] as string[] ?? []).map((cookie) => cookie.split(';')[0]).join('; ');

  test('failed, limited and successful sign-ins, a reset, a change, a refused origin and a refused request: each one line, and no secret in any line', async () => {
    const app = await server();
    const email = `log-${randomUUID()}@example.test`;
    const another = `log-${randomUUID()}@example.test`;
    const newPassword = 'a second lantern on the harbour wall';
    const third = 'a third lantern on the harbour wall';
    try {
      const created = await post(app.instance, '/api/auth/sign-up/email', { email, password: STRONG, name: 'Logging Person' });
      assert.equal(created.statusCode, 200, `${created.body} ${JSON.stringify(app.lines.filter((line) => Number(line.level) >= 40).slice(-3))}`);
      const session = cookieOf(created);
      for (let attempt = 1; attempt <= 5; attempt++) assert.equal((await post(app.instance, '/api/auth/sign-in/email', { email, password: `guess number ${attempt} here` })).statusCode, 401);
      assert.equal((await post(app.instance, '/api/auth/sign-in/email', { email, password: STRONG })).statusCode, 429);
      assert.equal((await post(app.instance, '/api/auth/sign-in/email', { email: another, password: 'does not matter at all' })).statusCode, 401);

      assert.equal((await post(app.instance, '/api/auth/request-password-reset', { email, redirectTo: `${ORIGIN}/reset-password` })).statusCode, 200);
      const token = app.sent.at(-1)!.text.match(/reset-password\/([^?\s]+)/)![1]!;
      assert.equal((await post(app.instance, '/api/auth/reset-password', { token, newPassword })).statusCode, 200);
      const signedIn = await post(app.instance, '/api/auth/sign-in/email', { email, password: newPassword });
      assert.equal(signedIn.statusCode, 200);
      const changed = await post(app.instance, '/api/auth/change-password', { currentPassword: newPassword, newPassword: third, revokeOtherSessions: true }, { cookie: cookieOf(signedIn) });
      assert.equal(changed.statusCode, 200);
      assert.equal((await post(app.instance, '/api/v1/sessions/revoke-others', {}, { cookie: cookieOf(changed) })).statusCode, 200);

      const foreign = await post(app.instance, '/api/auth/sign-out', {}, { origin: 'https://evil.example/path?token=SECRET-IN-ORIGIN' });
      assert.equal(foreign.statusCode, 403);
      const me = await app.instance.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieOf(changed) } });
      assert.equal(me.statusCode, 200);
      const refused = await app.instance.inject({ method: 'GET', url: `/api/v1/probe/${randomUUID()}?q=private+text`, remoteAddress: '198.51.100.20', headers: { cookie: cookieOf(changed) } });
      assert.equal(refused.statusCode, 403);

      const events = app.security();
      const named = (event: string, outcome: string) => events.filter((line) => line.event === event && line.outcome === outcome);
      const key = accountKey(SECRET, email);
      assert.equal(named('sign_in', 'failure').filter((line) => line.account === key && line.reason === 'bad_credentials').length, 5, 'five wrong passwords, by account');
      assert.equal(named('sign_in', 'failure').filter((line) => line.account === accountKey(SECRET, another)).length, 1, 'an address nobody holds is an account key too');
      const limited = named('sign_in', 'limited');
      assert.equal(limited.length, 1);
      assert.equal(limited[0]!.reason, 'account_back_off');
      assert.equal(limited[0]!.account, key);
      assert.equal(limited[0]!.ip, '198.51.100.20', 'the client address Flux believes');
      assert.match(String(limited[0]!.reqId), /^req-/, 'and the id of its access-log lines');
      assert.equal(named('password_reset_requested', 'success').length, 1);
      const reset = named('password_reset', 'success');
      assert.equal(reset.length, 1);
      assert.ok(reset[0]!.userId, 'a completed reset names the person');
      assert.ok(named('sessions_revoked', 'success').some((line) => line.reason === 'password_reset'));
      assert.equal(named('sign_in', 'success').length, 1);
      assert.equal(named('password_changed', 'success').length, 1);
      assert.ok(named('sessions_revoked', 'success').some((line) => line.reason === 'password_change'));
      assert.ok(named('sessions_revoked', 'success').some((line) => line.reason === 'sign_out_everywhere'));
      const origin = named('origin_refused', 'refused');
      assert.equal(origin.length, 1);
      assert.equal(origin[0]!.reason, 'foreign_origin');
      const denied = named('access_denied', 'denied');
      assert.equal(denied.length, 1);
      assert.equal(denied[0]!.reason, 'PROJECT_FORBIDDEN');
      assert.equal(denied[0]!.route, 'GET /api/v1/probe/:projectId', 'the route template: no id and no query');
      assert.ok(denied[0]!.userId, 'and the person it was refused to');

      // Nothing secret anywhere in the whole log of the run.
      const everything = JSON.stringify(app.lines);
      for (const secret of [STRONG, newPassword, third, 'guess number', token, email, another, 'SECRET-IN-ORIGIN', 'private text', 'private+text', 'Logging Person', session.match(/flux\.session_token=([^;]+)/)![1]!]) {
        assert.equal(everything.includes(secret), false, `the log holds ${secret.slice(0, 20)}`);
      }
    } finally { await app.instance.close(); }
  });

  test('opening the reset link writes the request without its token (#1030)', async () => {
    const app = await server();
    const email = `link-${randomUUID()}@example.test`;
    try {
      assert.equal((await post(app.instance, '/api/auth/sign-up/email', { email, password: STRONG, name: 'Link Person' })).statusCode, 200);
      assert.equal((await post(app.instance, '/api/auth/request-password-reset', { email, redirectTo: `${ORIGIN}/reset-password` })).statusCode, 200);
      const link = app.sent.at(-1)!.text.match(/https?:\/\/\S+\/reset-password\/\S+/)![0];
      const token = new URL(link).pathname.split('/').pop()!;
      assert.ok(token.length >= 16, 'the mail carries a real token');
      const opened = await app.instance.inject({ method: 'GET', url: `${new URL(link).pathname}${new URL(link).search}`, headers: { origin: ORIGIN } });
      assert.equal(opened.statusCode, 302, 'the link redirects to the form');

      const urls = app.lines.filter((line) => line.req).map((line) => (line.req as { url: string }).url);
      assert.ok(urls.includes('/api/auth/reset-password/<token>'), `the log names the route: ${JSON.stringify(urls)}`);
      assert.equal(urls.some((url) => url.includes(token)), false);
      assert.equal(JSON.stringify(app.lines).includes(token), false, 'no line of the log holds the token, whatever its field');
    } finally { await app.instance.close(); }
  });

  test('the address limiter says which route it limited and nothing of the request', async () => {
    const app = await server({ rateLimit: true });
    try {
      const remoteAddress = `198.51.100.${100 + Math.floor(Math.random() * 100)}`;
      const answers = [];
      for (let attempt = 0; attempt < 4; attempt++) answers.push((await post(app.instance, '/api/auth/sign-in/email?next=/private', { email: `limit-${randomUUID()}@example.test`, password: 'wrong wrong wrong wrong' }, { remoteAddress })).statusCode);
      assert.deepEqual(answers, [401, 401, 401, 429]);
      const limited = app.security().filter((line) => line.event === 'rate_limited');
      assert.equal(limited.length, 1);
      assert.deepEqual([limited[0]!.outcome, limited[0]!.reason, limited[0]!.route, limited[0]!.ip], ['limited', 'address_limit', '/api/auth/sign-in/email', remoteAddress]);
      assert.equal(JSON.stringify(app.lines).includes('/private'), false, 'no query string');
    } finally { await app.instance.close(); }
  });
});
