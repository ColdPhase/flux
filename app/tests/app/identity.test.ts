import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pool } from './support/db.js';
import { Browser, mailCount, publicOrigin, register, signIn, uniqueEmail, waitForMail } from './support/http.js';
import { password } from './support/people.js';

// End-to-end identity checks against the running API container (issue #29, AC-1).
if (!publicOrigin) throw new Error('FLUX_PUBLIC_ORIGIN is required');

interface Me { principal: { id: string; kind: string }; user: { id: string; email: string }; session: { id: string } }
interface SessionSummary { id: string; current: boolean; ipAddress: string | null; token?: string }

function sessionCookie(setCookies: string[]) {
  return setCookies.find((cookie) => cookie.startsWith('flux.session_token='));
}

describe('human identity', () => {
  test('register, sign in, authenticated request and sign out', async () => {
    const email = uniqueEmail('journey');
    const { response: signUp } = await register(email, password, 'Journey Person');
    const cookie = sessionCookie(signUp.setCookies);
    assert.ok(cookie, 'sign-up sets a session cookie');
    assert.match(cookie, /;\s*HttpOnly/i);
    assert.match(cookie, /;\s*SameSite=Lax/i);
    assert.match(cookie, /;\s*Path=\//i);

    const { browser, response: login } = await signIn(email, password);
    assert.equal(login.status, 200);
    assert.ok(sessionCookie(login.setCookies));
    assert.equal((login.json as { token?: string }).token, undefined, 'session token is not readable by script');
    const authSession = await browser.request('GET', '/api/auth/get-session');
    assert.equal(authSession.status, 200);
    assert.equal((authSession.json as { session: { token?: string } }).session.token, undefined);
    assert.equal(authSession.text.includes(browser.cookies.get('flux.session_token')!.split('.')[0]!), false);
    const me = await browser.request('GET', '/api/v1/me');
    assert.equal(me.status, 200);
    const body = me.json as Me;
    assert.equal(body.user.email, email);
    assert.deepEqual(body.principal, { id: body.user.id, kind: 'human' });

    const token = browser.cookies.get('flux.session_token');
    assert.ok(token);
    const logout = await browser.request('POST', '/api/auth/sign-out', { body: {} });
    assert.equal(logout.status, 200);
    assert.equal(browser.cookies.has('flux.session_token'), false, 'sign-out clears the cookie');
    const stale = new Browser();
    stale.cookies.set('flux.session_token', token);
    assert.equal((await stale.request('GET', '/api/v1/me')).status, 401, 'signed-out session is rejected');
    assert.equal((await new Browser().request('GET', '/api/v1/me')).status, 401, 'anonymous request is rejected');
  });

  test('wrong password and unknown account are rejected without a session', async () => {
    const email = uniqueEmail('wrong');
    await register(email, password);
    const wrong = await signIn(email, 'not the password at all');
    assert.equal(wrong.response.status, 401);
    assert.equal(sessionCookie(wrong.response.setCookies), undefined);
    const unknown = await signIn(uniqueEmail('nobody'), password);
    assert.equal(unknown.response.status, 401);
    assert.equal(sessionCookie(unknown.response.setCookies), undefined);
  });

  test('sessions are listed without tokens and revocation applies on the next request', async () => {
    const email = uniqueEmail('sessions');
    const { browser: laptop } = await register(email, password);
    const { browser: phone } = await signIn(email, password);
    const { browser: tablet } = await signIn(email, password);

    const listed = await laptop.request('GET', '/api/v1/sessions');
    assert.equal(listed.status, 200);
    const sessions = listed.json as SessionSummary[];
    assert.equal(sessions.length, 3);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    assert.ok(sessions.every((s) => s.token === undefined), 'tokens are never listed');
    assert.equal((await laptop.request('GET', '/api/auth/list-sessions')).status, 404, 'token-returning endpoint is disabled');

    const phoneId = ((await phone.request('GET', '/api/v1/me')).json as Me).session.id;
    assert.equal((await laptop.request('DELETE', `/api/v1/sessions/${phoneId}`)).status, 204);
    assert.equal((await phone.request('GET', '/api/v1/me')).status, 401, 'revoked session fails on the next request');
    assert.equal((await tablet.request('GET', '/api/v1/me')).status, 200);

    const other = await register(uniqueEmail('other'), password);
    const otherId = ((await other.browser.request('GET', '/api/v1/me')).json as Me).session.id;
    const foreign = await laptop.request('DELETE', `/api/v1/sessions/${otherId}`);
    assert.equal(foreign.status, 404, 'cannot revoke another person\'s session');
    assert.deepEqual(foreign.json, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    assert.equal((await other.browser.request('GET', '/api/v1/me')).status, 200);

    const revoked = await laptop.request('POST', '/api/v1/sessions/revoke-others');
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json, { revoked: 1 });
    assert.equal((await tablet.request('GET', '/api/v1/me')).status, 401);
    assert.equal((await laptop.request('GET', '/api/v1/me')).status, 200, 'current session survives revoke-others');
  });

  test('password reset through SMTP uses a single-use expiring token', async () => {
    const email = uniqueEmail('reset');
    const { browser: before } = await register(email, password);
    const capabilities = await new Browser().request('GET', '/api/v1/auth/capabilities');
    assert.deepEqual(capabilities.json, { passwordReset: 'available', signup: 'open', sso: null });

    const request = await new Browser().request('POST', '/api/auth/request-password-reset', {
      body: { email, redirectTo: `${publicOrigin}/reset-password` },
      headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', forwarded: 'host=evil.example;proto=https' },
    });
    assert.equal(request.status, 200);
    const mail = await waitForMail(email);
    const link = mail.match(/https?:\/\/\S+/)?.[0];
    assert.ok(link, 'mail contains a reset link');
    assert.ok(link.startsWith(`${publicOrigin}/api/auth/reset-password/`), `reset link uses the configured public origin, not forwarded headers: ${link}`);
    assert.doesNotMatch(mail, /evil\.example/);

    const path = new URL(link);
    const token = path.pathname.split('/').pop()!;
    const callback = await new Browser().request('GET', `${path.pathname}${path.search}`, { origin: null });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), `${publicOrigin}/reset-password?token=${token}`);

    const newPassword = 'a different long passphrase';
    const reset = await new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword } });
    assert.equal(reset.status, 200);
    assert.equal((await before.request('GET', '/api/v1/me')).status, 401, 'reset revokes existing sessions');
    assert.equal((await signIn(email, password)).response.status, 401, 'old password no longer works');
    assert.equal((await signIn(email, newPassword)).response.status, 200, 'new password works');

    const reuse = await new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'yet another long passphrase' } });
    assert.equal(reuse.status, 400, 'a used token is rejected');
    assert.equal((await signIn(email, newPassword)).response.status, 200);

    const second = await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: `${publicOrigin}/reset-password` } });
    assert.equal(second.status, 200);
    let expiredToken: string | undefined;
    const deadline = Date.now() + 10_000;
    while (!expiredToken && Date.now() < deadline) {
      const text = await waitForMail(email);
      const candidate = text.match(/reset-password\/([^?\s]+)/)?.[1];
      if (candidate && candidate !== token) expiredToken = candidate;
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(expiredToken, 'second reset mail arrives');
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM auth_users WHERE email = $1', [email]);
    const updated = await pool.query("UPDATE auth_verifications SET expires_at = now() - interval '1 minute' WHERE value = $1", [rows[0]!.id]);
    assert.equal(updated.rowCount, 1, 'the pending reset token is stored once');
    const stored = await pool.query('SELECT 1 FROM auth_verifications WHERE identifier LIKE $1', [`%${expiredToken}%`]);
    assert.equal(stored.rowCount, 0, 'reset tokens are stored hashed');
    const expired = await new Browser().request('POST', '/api/auth/reset-password', { body: { token: expiredToken, newPassword: 'expired token passphrase' } });
    assert.equal(expired.status, 400, 'an expired token is rejected');
    assert.equal((await signIn(email, newPassword)).response.status, 200, 'password is unchanged after the rejected token');
  });

  test('reset request for an unknown email gives the same answer and sends nothing', async () => {
    const email = uniqueEmail('ghost');
    const response = await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: `${publicOrigin}/reset-password` } });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await mailCount(email), 0);
  });

  test('state-changing requests from a foreign origin are rejected', async () => {
    const email = uniqueEmail('csrf');
    const { browser } = await register(email, password);
    for (const origin of ['https://evil.example', 'null', `${publicOrigin}.evil.example`]) {
      const response = await browser.request('POST', '/api/v1/sessions/revoke-others', { origin });
      assert.equal(response.status, 403, `origin ${origin}`);
      assert.equal((response.json as { code: string }).code, 'ORIGIN_REJECTED');
    }
    const login = await new Browser().request('POST', '/api/auth/sign-in/email', { body: { email, password }, origin: 'https://evil.example' });
    assert.equal(login.status, 403, 'login CSRF is rejected');
    assert.equal(sessionCookie(login.setCookies), undefined);
    const spoofed = await new Browser().request('POST', '/api/auth/sign-in/email', {
      body: { email, password }, origin: 'https://evil.example', headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    });
    assert.equal(spoofed.status, 403, 'X-Forwarded-Host cannot make a foreign origin look local');
    const noOrigin = await browser.request('POST', '/api/auth/sign-out', { body: {}, origin: null });
    assert.equal(noOrigin.status, 403, 'cookie-bearing state change without Origin is rejected');
    const crossSite = await browser.request('POST', '/api/auth/sign-out', { body: {}, origin: null, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const foreignReferer = await browser.request('POST', '/api/auth/sign-out', { body: {}, origin: null, headers: { referer: 'https://evil.example/page' } });
    assert.equal(foreignReferer.status, 403);
    assert.equal((await browser.request('GET', '/api/v1/me')).status, 200, 'rejected requests changed nothing');
  });

  test('spoofed forwarding headers do not set the recorded client address', async () => {
    const email = uniqueEmail('proxy');
    await register(email, password);
    const { browser } = await signIn(email, password, { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.8', 'x-flux-client-ip': '203.0.113.9' });
    const sessions = (await browser.request('GET', '/api/v1/sessions')).json as SessionSummary[];
    const current = sessions.find((s) => s.current);
    assert.ok(current);
    assert.ok(current.ipAddress, 'the socket address is recorded');
    assert.doesNotMatch(current.ipAddress, /^203\.0\.113\./, 'untrusted forwarding headers are ignored');
  });
});
