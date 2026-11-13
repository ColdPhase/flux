import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { DEFAULT_SESSION_IDLE_SECONDS, DEFAULT_SESSION_MAX_AGE_SECONDS, parseSessionDuration } from '../../apps/server/src/identity/config.js';
import { setupNotice } from '../../apps/server/src/identity/first-owner.js';
import { database, pool } from './support/db.js';

// #993 (sessions, sign-up answers) and #994 (the first owner), in-process against the Compose database.

const ORIGIN = 'https://flux.example.org';
// The check stack's own secret: the signing keys in its database are encrypted with it, and a session read opens them.
const SECRET = process.env.FLUX_AUTH_SECRET ?? randomBytes(32).toString('hex');
const PASSWORD = 'a lantern on the harbour wall';

describe('session limits: FLUX_SESSION_IDLE and FLUX_SESSION_MAX_AGE (#993)', () => {
  const load = (extra: Record<string, string>) => loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: ORIGIN, FLUX_AUTH_SECRET: SECRET, FLUX_AUTH_RATE_LIMIT: 'false', ...extra });

  test('the defaults are 7 days unused and 30 days from sign-in; a number and one unit sets either', () => {
    assert.deepEqual([load({}).sessionIdleSeconds, load({}).sessionMaxAgeSeconds], [7 * 86_400, 30 * 86_400]);
    assert.equal(DEFAULT_SESSION_IDLE_SECONDS, 604_800);
    assert.equal(DEFAULT_SESSION_MAX_AGE_SECONDS, 2_592_000);
    const asvs = load({ FLUX_SESSION_IDLE: '30m', FLUX_SESSION_MAX_AGE: '12h' });
    assert.deepEqual([asvs.sessionIdleSeconds, asvs.sessionMaxAgeSeconds], [1800, 43_200]);
    assert.equal(load({ FLUX_SESSION_IDLE: ' 2d ', FLUX_SESSION_MAX_AGE: '90d' }).sessionMaxAgeSeconds, 90 * 86_400);
  });

  test('a bad value stops the server at start, naming the setting', () => {
    for (const bad of ['0m', '4m', '400d', '7', 'seven days', '-1d', '1.5h', '12H']) {
      assert.throws(() => load({ FLUX_SESSION_MAX_AGE: bad }), /FLUX_SESSION_MAX_AGE must be from 5m to 365d/, bad);
    }
    assert.throws(() => load({ FLUX_SESSION_IDLE: '1d', FLUX_SESSION_MAX_AGE: '12h' }), /FLUX_SESSION_IDLE must not be longer than FLUX_SESSION_MAX_AGE/);
    assert.throws(() => load({ FLUX_SESSION_IDLE: '45d' }), /FLUX_SESSION_IDLE must not be longer/, 'the default maximum is 30 days');
    assert.equal(load({ FLUX_SESSION_MAX_AGE: '12h' }).sessionIdleSeconds, 43_200, 'an idle time left unset never outlasts a shorter maximum');
    assert.equal(load({ FLUX_SESSION_MAX_AGE: '90d' }).sessionIdleSeconds, 7 * 86_400, 'and stays 7 days under a longer one');
    assert.equal(parseSessionDuration('X', '', 99, 5, 100), 99);
  });

  async function app(extra: Record<string, string>) {
    const instance = Fastify();
    registerIdentity(instance, { db: database.db, config: load(extra), mailer: null, openSignUp: true });
    await instance.ready();
    const email = `session-${randomUUID()}@example.test`;
    const created = await instance.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD, name: 'Session Person' } });
    assert.equal(created.statusCode, 200, created.body);
    const raw = ([] as string[]).concat(created.headers['set-cookie'] as string[]).find((cookie) => cookie.includes('session_token='))!;
    const cookie = raw.split(';')[0]!;
    const session = (await pool.query<{ id: string; seconds: number }>(
      'SELECT s.id, extract(epoch FROM s.expires_at - now())::float8 AS seconds FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE u.email = $1', [email])).rows[0]!;
    const me = async () => { const answer = await instance.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } }); if (answer.statusCode === 500) console.error('ME 500', answer.body); return answer; };
    return { instance, email, raw, cookie, session, me };
  }

  test('the cookie and the stored session last as long as the idle setting, 7 days when it is not set', async () => {
    const plain = await app({});
    try {
      assert.match(plain.raw, /Max-Age=604800/i);
      assert.ok(plain.session.seconds > 604_700 && plain.session.seconds <= 604_800, `${plain.session.seconds}`);
      assert.equal((await plain.me()).statusCode, 200);
    } finally { await plain.instance.close(); }
    const strict = await app({ FLUX_SESSION_IDLE: '30m', FLUX_SESSION_MAX_AGE: '12h' });
    try {
      assert.match(strict.raw, /Max-Age=1800/i);
      assert.ok(strict.session.seconds > 1700 && strict.session.seconds <= 1800, `${strict.session.seconds}`);
    } finally { await strict.instance.close(); }
  });

  test('a session older than the maximum ends however recently it was used, on a Flux route and on an auth route, and its row goes', async () => {
    const limited = await app({ FLUX_SESSION_MAX_AGE: '1h' });
    try {
      assert.equal((await limited.me()).statusCode, 200);
      // Used a minute ago, so the idle limit is far off; signed in two hours ago, so the absolute limit has passed.
      await pool.query("UPDATE auth_sessions SET created_at = now() - interval '2 hours', updated_at = now() - interval '1 minute' WHERE id = $1", [limited.session.id]);
      const changed = await limited.instance.inject({ method: 'POST', url: '/api/auth/change-password', headers: { origin: ORIGIN, cookie: limited.cookie },
        payload: { currentPassword: PASSWORD, newPassword: 'a second lantern on the harbour wall', revokeOtherSessions: false } });
      assert.equal(changed.statusCode, 401, 'Better Auth is not given a session past the maximum');
      assert.equal((await limited.me()).statusCode, 401);
      assert.equal((await pool.query('SELECT 1 FROM auth_sessions WHERE id = $1', [limited.session.id])).rowCount, 0, 'the session is deleted, not only refused');
    } finally { await limited.instance.close(); }
  });

  test('a session unused for the idle time ends; a new sign-in starts again', async () => {
    const idle = await app({ FLUX_SESSION_IDLE: '30m' });
    try {
      await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [idle.session.id]);
      assert.equal((await idle.me()).statusCode, 401);
      const again = await idle.instance.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: ORIGIN }, payload: { email: idle.email, password: PASSWORD } });
      assert.equal(again.statusCode, 200);
    } finally { await idle.instance.close(); }
  });
});

describe('the first owner comes from the setup link (#1471)', () => {
  const TOKEN = 'b7'.repeat(32);
  const notice = (over: Partial<{ setupToken: string | null; ssoOnly: boolean }> = {}, hasCompany = false) =>
    setupNotice({ publicOrigin: ORIGIN, setupToken: over.setupToken === undefined ? TOKEN : over.setupToken, ssoOnly: over.ssoOnly ?? false }, hasCompany);

  test('while no company exists the log says where the setup link is, and never the token', () => {
    const said = notice();
    assert.equal(said?.level, 'info');
    assert.match(said?.text ?? '', /open the setup link that \.\/flux up printed \(https:\/\/flux\.example\.org\/setup#…\)/);
    assert.doesNotMatch(said?.text ?? '', new RegExp(TOKEN));
  });

  test('without FLUX_SETUP_TOKEN it warns that no first account can be made, and how to set one', () => {
    const said = notice({ setupToken: null });
    assert.equal(said?.level, 'warn');
    assert.match(said?.text ?? '', /FLUX_SETUP_TOKEN is not set, so nobody can create the first account/);
  });

  test('nothing to say once the company exists, or with single sign-on as the only way in', () => {
    assert.equal(notice({}, true), null);
    assert.equal(notice({ ssoOnly: true }), null);
  });
});
