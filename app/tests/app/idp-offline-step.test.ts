import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { OidcConfig } from '../../apps/server/src/identity/config.js';
import { createOfflineStep, offlineStepProblem } from '../../apps/server/src/identity/offline-step.js';
import { createIdpStanding } from '../../apps/server/src/identity/standing.js';
import { db } from './support/db.js';

// The silent offline-access step of a provider sign-in (F-024 S1, revised 2026-10-09 by founder direction, #314).
// Keycloak 26.1+ deletes the online session when offline_access is the first request of a new session, and then
// sends no back-channel logout; so Flux signs in online and fetches the offline token in a second, silent request.
// The Keycloak-backed run is tests/app/e2e/oidc-mcp.e2e.ts (scripts/check_oidc.sh).
const issuer = 'http://idp.test/realms/flux';
const oidc = (providerId: string): OidcConfig => ({
  providerId, issuer, clientId: 'flux', clientSecret: 'client-secret-xyz', label: 'Acme', standing: 'refresh', standingIntervalMs: 900_000,
});
const authSecret = 'a'.repeat(40);
const jwt = (claims: Record<string, unknown>) => [{ alg: 'RS256' }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.c2ln';

type Reply = { status: number; body: Record<string, unknown> };
function setup(origin = 'https://flux.test', options: { now?: () => number; secret?: string } = {}) {
  const providerId = `oidc-${randomUUID().slice(0, 12)}`;
  const calls: { url: string; body: string; authorization?: string }[] = [];
  const replies: Reply[] = [];
  const fetcher = async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return { ok: true, status: 200, json: async () => ({ authorization_endpoint: `${issuer}/auth?kc_idp_hint=`, token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke` }) };
    }
    calls.push({ url, body: init.body ?? '', authorization: init.headers?.authorization });
    const reply = replies.shift();
    if (!reply) throw new Error('timeout');
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  const log = { info() {}, warn() {}, error() {} };
  const standing = createIdpStanding({ db, oidc: oidc(providerId), authSecret: options.secret ?? authSecret, log, fetcher: fetcher as never });
  const step = createOfflineStep({ oidc: oidc(providerId), publicOrigin: origin, authSecret: options.secret ?? authSecret, standing, now: options.now });
  const callback = (query: string) => new URL(`${origin}/api/auth/callback/${providerId}?${query}`);
  return { providerId, step, calls, replies, callback, redirectUri: `${origin}/api/auth/callback/${providerId}` };
}

/** Runs the first leg: the sign-in callback is held. Returns the silent request's parameters and the cookie header. */
async function hold(context: ReturnType<typeof setup>, query = 'state=s1&code=c1&iss=x') {
  const action = await context.step.intercept(context.callback(query), undefined);
  assert.equal(action.kind, 'redirect');
  if (action.kind !== 'redirect') throw new Error('unreachable');
  return { location: new URL(action.location), cookie: action.cookie, header: action.cookie.split(';')[0]! };
}

describe('the silent offline-access step', () => {
  test('a malformed percent escape in the step cookie is treated as no pending step', async () => {
    const context = setup();
    assert.deepEqual(await context.step.intercept(context.callback(''), '__Secure-flux.idp_offline_step=%'), { kind: 'pass' });
    const local = setup('http://127.0.0.1:18095');
    assert.deepEqual(await local.step.intercept(local.callback(''), 'flux.idp_offline_step=%'), { kind: 'pass' });
  });

  test('a sign-in callback is held and the browser goes back to the provider for offline_access only, silently', async () => {
    const context = setup();
    const { location, cookie } = await hold(context);
    assert.equal(`${location.origin}${location.pathname}`, `${issuer}/auth`);
    const params = Object.fromEntries(location.searchParams);
    assert.equal(params.prompt, 'none');
    assert.equal(params.scope, 'openid offline_access');
    assert.equal(params.response_type, 'code');
    assert.equal(params.client_id, 'flux');
    assert.equal(params.redirect_uri, context.redirectUri, 'the same redirect URI: operators register nothing new');
    assert.equal(params.code_challenge_method, 'S256');
    assert.ok(params.state?.startsWith('flux-offline.') && params.nonce && params.code_challenge, 'its own state, nonce and PKCE');
    assert.equal(params.kc_idp_hint, '', 'the endpoint\'s own query is kept');
    assert.match(cookie, /^__Secure-flux\.idp_offline_step=/);
    for (const attribute of [`Path=/api/auth/callback/${context.providerId}`, 'HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=300']) assert.ok(cookie.includes(attribute), attribute);
    assert.ok(!cookie.includes('c1') && !cookie.includes(params.state), 'the held callback and the state are sealed');
    assert.equal(context.calls.length, 0, 'nothing is redeemed yet');

    const plain = setup('http://127.0.0.1:18095');
    const local = await hold(plain);
    assert.match(local.cookie, /^flux\.idp_offline_step=/);
    assert.ok(!local.cookie.includes('Secure'), 'no Secure cookie on a plain-HTTP origin');
  });

  test('the provider\'s answer is redeemed with PKCE as Flux\'s client, and the held callback resumes with the offline token', async () => {
    const context = setup();
    const { location, header } = await hold(context);
    const nonce = location.searchParams.get('nonce')!;
    context.replies.push({ status: 200, body: { access_token: 'at', refresh_token: 'offline-rt', id_token: jwt({ iss: issuer, aud: ['flux', 'other'], nonce, sub: 'sub-1', sid: 'sid-1' }) } });
    const action = await context.step.intercept(context.callback(`state=${location.searchParams.get('state')}&code=c2&session_state=x`), `other=1; ${header}`);
    assert.equal(action.kind, 'resume');
    if (action.kind !== 'resume') return;
    assert.equal(action.url.pathname, `/api/auth/callback/${context.providerId}`);
    assert.equal(action.url.search, '?state=s1&code=c1&iss=x', 'the held sign-in callback, unchanged');
    assert.deepEqual(action.outcome, { refreshToken: 'offline-rt', subject: 'sub-1', sid: 'sid-1' });
    assert.match(action.cookie, /^__Secure-flux\.idp_offline_step=; Max-Age=0; /, 'the step cookie is cleared');
    const [call] = context.calls;
    assert.equal(call!.url, `${issuer}/token`);
    const body = new URLSearchParams(call!.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'c2');
    assert.equal(body.get('redirect_uri'), context.redirectUri);
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), location.searchParams.get('code_challenge'), 'the verifier matches the challenge');
    assert.equal(call!.authorization, `Basic ${Buffer.from('flux:client-secret-xyz').toString('base64')}`);
    assert.equal(offlineStepProblem('sub-1', 'sid-1', action.outcome), null, 'negative control: this sign-in may go on');
  });

  test('login_required, a provider error, no refresh token or a wrong ID token resume with a reason that refuses the sign-in', async () => {
    const cases: [string, (nonce: string) => Reply | null, string][] = [
      ['login_required', () => null, 'login_required'],
      ['no refresh token', (nonce) => ({ status: 200, body: { access_token: 'at', id_token: jwt({ iss: issuer, aud: 'flux', nonce, sub: 'sub-1' }) } }), 'no_refresh_token'],
      ['another nonce', () => ({ status: 200, body: { refresh_token: 'rt', id_token: jwt({ iss: issuer, aud: 'flux', nonce: 'other', sub: 'sub-1' }) } }), 'invalid_id_token'],
      ['another audience', (nonce) => ({ status: 200, body: { refresh_token: 'rt', id_token: jwt({ iss: issuer, aud: 'other', nonce, sub: 'sub-1' }) } }), 'invalid_id_token'],
      ['another issuer', (nonce) => ({ status: 200, body: { refresh_token: 'rt', id_token: jwt({ iss: 'http://evil.test', aud: 'flux', nonce, sub: 'sub-1' }) } }), 'invalid_id_token'],
      ['no ID token', () => ({ status: 200, body: { refresh_token: 'rt' } }), 'invalid_id_token'],
      ['a refused code', () => ({ status: 400, body: { error: 'invalid_grant' } }), 'token_invalid_grant'],
    ];
    for (const [name, reply, reason] of cases) {
      const context = setup();
      const { location, header } = await hold(context);
      const answer = reply(location.searchParams.get('nonce')!);
      if (answer) context.replies.push(answer);
      const query = answer ? `state=${location.searchParams.get('state')}&code=c2` : `state=${location.searchParams.get('state')}&error=login_required`;
      const action = await context.step.intercept(context.callback(query), header);
      assert.equal(action.kind, 'resume', name);
      if (action.kind !== 'resume') continue;
      assert.equal(action.url.search, '?state=s1&code=c1&iss=x', name);
      assert.deepEqual(action.outcome, { error: reason }, name);
      assert.equal(offlineStepProblem('sub-1', undefined, action.outcome), reason, name);
      assert.equal(context.calls.length, answer ? 1 : 0, `${name}: an error answer is not redeemed`);
    }
  });

  test('only its own sealed, unexpired cookie with the matching state finishes the step; a cancelled sign-in passes through', async () => {
    let clock = Date.now();
    const context = setup('https://flux.test', { now: () => clock });
    const { location, header } = await hold(context);
    const answer = context.callback(`state=${location.searchParams.get('state')}&code=c2`);
    const [name, value] = header.split('=') as [string, string];
    const tampered = `${name}=${value.slice(0, -4)}AAAA`;
    // An answer whose step cannot be read goes to Better Auth, which refuses its unknown state: no loop back to the provider.
    assert.equal((await context.step.intercept(answer, tampered)).kind, 'pass', 'a tampered cookie');
    assert.equal((await context.step.intercept(answer, undefined)).kind, 'pass', 'no cookie (a replayed answer in another browser)');
    const foreign = setup('https://flux.test', { secret: 'b'.repeat(40) });
    assert.equal((await foreign.step.intercept(answer, header)).kind, 'pass', 'a cookie sealed under another secret');
    assert.equal((await context.step.intercept(context.callback('state=another&code=c2'), header)).kind, 'redirect', 'another sign-in callback holds its own step');
    clock += 6 * 60_000;
    assert.equal((await context.step.intercept(answer, header)).kind, 'pass', 'an expired step is not finished');
    assert.equal((await context.step.intercept(context.callback('state=s1&error=access_denied'), undefined)).kind, 'pass', 'a cancelled sign-in goes to Better Auth as it is');
    assert.equal(context.calls.length, 0, 'nothing was redeemed');
  });

  test('the step must name the same person, and the same provider session when both carry one', () => {
    const grant = { refreshToken: 'rt', subject: 'sub-1', sid: 'sid-1' };
    assert.equal(offlineStepProblem('sub-1', 'sid-1', grant), null);
    assert.equal(offlineStepProblem('sub-1', undefined, grant), null);
    assert.equal(offlineStepProblem('sub-1', 'sid-1', { refreshToken: 'rt', subject: 'sub-1' }), null);
    assert.equal(offlineStepProblem('sub-2', 'sid-1', grant), 'another_subject');
    assert.equal(offlineStepProblem('sub-1', 'sid-2', grant), 'another_session');
    assert.equal(offlineStepProblem('sub-1', 'sid-1', undefined), 'no_offline_step', 'a provider callback that skipped the step is refused');
  });
});
