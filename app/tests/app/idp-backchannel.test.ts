import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { schema } from '@flux/db';
import { BACKCHANNEL_EVENT, createJwks, registerBackchannelLogout, verifyLogoutToken } from '../../apps/server/src/identity/backchannel.js';
import type { OidcConfig } from '../../apps/server/src/identity/config.js';
import { createIdpStanding } from '../../apps/server/src/identity/standing.js';
import { db, insertedHuman, pool } from './support/db.js';

// OIDC back-channel logout (F-024 S3, #314): the receiver against the Compose database, with a signing key
// the test owns. The Keycloak-backed run is tests/app/e2e/oidc-mcp.e2e.ts (scripts/check_oidc.sh).
const issuer = 'http://idp.test/realms/flux';
const oidc = (providerId: string): OidcConfig => ({ providerId, issuer, clientId: 'flux', clientSecret: 's', label: 'Acme', standing: 'refresh', standingIntervalMs: 900_000 });
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (key: KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig' });
const keys = [{ ...jwk(pair.publicKey, 'k1'), alg: 'RS256' }, { ...jwk(ec.publicKey, 'k-ec'), alg: 'ES256' }];
const fetcher = async (url: string) => ({ ok: true, json: async () => url.endsWith('openid-configuration') ? { jwks_uri: 'http://idp.test/jwks' } : { keys } });
const jwks = createJwks({ issuer }, fetcher as never);
const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);

function logoutToken(claims: Record<string, unknown> = {}, options: { key?: KeyObject; alg?: string; kid?: string } = {}) {
  const alg = options.alg ?? 'RS256';
  const body = { iss: issuer, aud: 'flux', iat: now, exp: now + 120, jti: randomUUID(), events: { [BACKCHANNEL_EVENT]: {} }, sid: 'sid-1', ...claims };
  const input = `${b64({ alg, kid: options.kid ?? 'k1', typ: 'logout+jwt' })}.${b64(body)}`;
  if (alg === 'none') return `${input}.`;
  const signature = alg === 'ES256' ? sign('sha256', Buffer.from(input), { key: options.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' })
    : sign('sha256', Buffer.from(input), options.key ?? pair.privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

describe('the logout token is verified as OpenID Connect Back-Channel Logout 1.0 §2.6 requires', () => {
  const verify = (token: string) => verifyLogoutToken({ issuer, clientId: 'flux' }, token, jwks, now);
  test('a correct token is accepted (RS256 and ES256), with the revoke_offline_access flag read', async () => {
    const ok = await verify(logoutToken());
    assert.ok(ok.ok && ok.claims.sid === 'sid-1' && !ok.claims.revokeOffline);
    assert.ok((await verify(logoutToken({}, { alg: 'ES256', kid: 'k-ec' }))).ok);
    const revoke = await verify(logoutToken({ events: { [BACKCHANNEL_EVENT]: {}, revoke_offline_access: true } }));
    assert.ok(revoke.ok && revoke.claims.revokeOffline);
    assert.ok((await verify(logoutToken({ sid: undefined, sub: 'abc' }))).ok, 'sub alone');
    assert.ok((await verify(logoutToken({ aud: ['other', 'flux'] }))).ok, 'aud may be a list');
  });
  test('each defect is refused', async () => {
    const refused: [string, string][] = [
      ['a signature by another key', logoutToken({}, { key: rogue.privateKey })],
      ['alg none', logoutToken({}, { alg: 'none' })],
      ['alg HS256', logoutToken({}, { alg: 'HS256' })],
      ['an unknown key id', logoutToken({}, { kid: 'nope' })],
      ['a wrong audience', logoutToken({ aud: 'another-client' })],
      ['a wrong issuer', logoutToken({ iss: 'http://evil.test' })],
      ['a nonce', logoutToken({ nonce: 'n' })],
      ['no logout event', logoutToken({ events: {} })],
      ['an events value that is not an object', logoutToken({ events: { [BACKCHANNEL_EVENT]: true } })],
      ['neither sub nor sid', logoutToken({ sid: undefined })],
      ['no jti', logoutToken({ jti: undefined })],
      ['an expired token', logoutToken({ exp: now - 300 })],
      ['an iat in the future', logoutToken({ iat: now + 300 })],
      ['no iat', logoutToken({ iat: undefined })],
      ['not a jwt', 'abc'],
      ['empty', ''],
    ];
    for (const [name, token] of refused) assert.equal((await verify(token)).ok, false, name);
  });
  test('clock tolerance is 60 seconds either way', async () => {
    assert.ok((await verify(logoutToken({ iat: now + 50 }))).ok);
    assert.ok((await verify(logoutToken({ exp: now - 50 }))).ok);
  });
});

describe('the route', () => {
  async function receiver(standingSpy?: { checks: string[][]; revokes: string[][] }) {
    const providerId = `oidc-${randomUUID().slice(0, 12)}`;
    const app = Fastify();
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    const standing = standingSpy ? { checkSoon: async (ids: string[]) => { standingSpy.checks.push(ids); }, revokeOffline: async (ids: string[]) => { standingSpy.revokes.push(ids); } } as never : null;
    registerBackchannelLogout(app, { db, oidc: oidc(providerId), standing, jwks, log: { info() {}, warn() {} } });
    const post = (token: string, id = providerId) => app.inject({ method: 'POST', url: `/api/v1/identity/oidc/${id}/backchannel-logout`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `logout_token=${encodeURIComponent(token)}` });
    return { providerId, post, app };
  }
  async function person(providerId: string, subject: string, sids: string[]) {
    const human = await insertedHuman('bcl');
    await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: human.id, accountId: subject, providerId });
    const sessionIds: string[] = [];
    for (const sid of sids) {
      const id = randomUUID(); sessionIds.push(id);
      await db.insert(schema.authSessions).values({ id, userId: human.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
      await pool.query('INSERT INTO auth_session_identities (session_id, method, idp_sid) VALUES ($1, $2, $3)', [id, providerId, sid]);
    }
    return { userId: human.id, sessionIds };
  }
  const live = async (userId: string) => (await pool.query('SELECT id FROM auth_sessions WHERE user_id = $1', [userId])).rows.map((row) => row.id as string);

  test('a sid ends only the sessions created from that provider session, and the immediate check is queued', async () => {
    const spy = { checks: [] as string[][], revokes: [] as string[][] };
    const { providerId, post, app } = await receiver(spy);
    const sid = `sid-${randomUUID()}`;
    const alice = await person(providerId, 'sub-a', [sid, `${sid}-other`]);
    const bob = await person(providerId, 'sub-b', [sid + '-b']);
    const response = await post(logoutToken({ sid }));
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(await live(alice.userId), [alice.sessionIds[1]], 'the other session of the same person stays');
    assert.equal((await live(bob.userId)).length, 1, 'another person is untouched');
    assert.deepEqual(spy.checks, [[alice.userId]]);
    assert.deepEqual(spy.revokes, []);
    await app.close();
  });

  test('only a sub ends every session of that identity', async () => {
    const spy = { checks: [] as string[][], revokes: [] as string[][] };
    const { providerId, post } = await receiver(spy);
    const alice = await person(providerId, 'sub-a', ['s1', 's2']);
    const bob = await person(providerId, 'sub-b', ['s3']);
    assert.equal((await post(logoutToken({ sid: undefined, sub: 'sub-a' }))).statusCode, 200);
    assert.deepEqual(await live(alice.userId), []);
    assert.equal((await live(bob.userId)).length, 1);
  });

  test('revoke_offline_access revokes the MCP refresh tokens and drops the provider token', async () => {
    const spy = { checks: [] as string[][], revokes: [] as string[][] };
    const { providerId, post } = await receiver(spy);
    const alice = await person(providerId, 'sub-a', ['s1']);
    const bob = await person(providerId, 'sub-b', ['s2']);
    const client = `client-${randomUUID()}`;
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, created_at, updated_at)
      VALUES ($1, $2, 'c', $3, 'none', '{authorization_code}', '{code}', '{offline_access}', true, now(), now())`, [randomUUID(), client, ['http://127.0.0.1/cb']]);
    for (const userId of [alice.userId, bob.userId]) {
      await pool.query(`INSERT INTO oauth_refresh_token (id, token, client_id, user_id, expires_at, created_at, scopes) VALUES ($1, $2, $3, $4, now() + interval '1 day', now(), '{offline_access}')`,
        [randomUUID(), randomUUID(), client, userId]);
    }
    const response = await post(logoutToken({ sid: 's1', events: { [BACKCHANNEL_EVENT]: {}, revoke_offline_access: true } }));
    assert.equal(response.statusCode, 200);
    const revoked = async (userId: string) => (await pool.query('SELECT revoked FROM oauth_refresh_token WHERE user_id = $1', [userId])).rows[0].revoked;
    assert.ok(await revoked(alice.userId));
    assert.equal(await revoked(bob.userId), null, 'negative control: another person keeps theirs');
    assert.deepEqual(spy.revokes, [[alice.userId]]);
    assert.deepEqual(spy.checks, [], 'a revocation is not a check');
  });

  test('refusals: replay, bad signature, wrong aud, nonce, unknown sid and unknown provider', async () => {
    const { providerId, post } = await receiver({ checks: [], revokes: [] });
    const alice = await person(providerId, 'sub-a', ['s1']);
    const token = logoutToken({ sid: 'unknown-sid' });
    const unknown = await post(token);
    assert.equal(unknown.statusCode, 200, 'an unknown sid is not an error (§2.8) ...');
    assert.equal((await live(alice.userId)).length, 1, '... and ends nothing');
    const replay = await post(token);
    assert.equal(replay.statusCode, 400, 'the same jti again');
    assert.equal(replay.headers['cache-control'], 'no-store');
    for (const [name, bad] of [['signature', logoutToken({ sid: 's1' }, { key: rogue.privateKey })], ['aud', logoutToken({ sid: 's1', aud: 'x' })],
      ['nonce', logoutToken({ sid: 's1', nonce: 'n' })], ['alg none', logoutToken({ sid: 's1' }, { alg: 'none' })]] as const) {
      const refused = await post(bad);
      assert.equal(refused.statusCode, 400, name);
      assert.equal(refused.headers['cache-control'], 'no-store', name);
    }
    assert.equal((await live(alice.userId)).length, 1, 'no refused token ended a session');
    assert.equal((await post(logoutToken({ sid: 's1' }), 'oidc-000000000000')).statusCode, 404);
    // A refused token does not consume its jti: the corrected token with the same jti still works.
    const jti = randomUUID();
    assert.equal((await post(logoutToken({ sid: 's1', jti, aud: 'x' }))).statusCode, 400);
    assert.equal((await post(logoutToken({ sid: 's1', jti }))).statusCode, 200);
    assert.equal((await live(alice.userId)).length, 0);
  });

  test('a replayed id is forgotten once it has expired', async () => {
    const { providerId } = await receiver();
    const { idpLogoutRepository } = await import('@flux/db');
    const rows = idpLogoutRepository(db);
    const t0 = new Date();
    assert.equal(await rows.consumeJti(providerId, 'j1', new Date(t0.getTime() + 1000), t0), true);
    assert.equal(await rows.consumeJti(providerId, 'j1', new Date(t0.getTime() + 1000), t0), false);
    assert.equal(await rows.consumeJti(providerId, 'j1', new Date(t0.getTime() + 9000), new Date(t0.getTime() + 5000)), true, 'pruned after its expiry');
  });
});

describe('revoking offline access with the real standing service', () => {
  test('the stored token is deleted, revoked at the provider, and the person is in sign-in required', async () => {
    const providerId = `oidc-${randomUUID().slice(0, 12)}`;
    const calls: string[] = [];
    const fetcher = async (url: string, init: { body?: string }) => {
      calls.push(`${url} ${init?.body ?? ''}`);
      return { ok: true, status: 200, json: async () => url.endsWith('openid-configuration') ? { token_endpoint: 'http://idp.test/token', revocation_endpoint: 'http://idp.test/revoke' } : {} };
    };
    const service = createIdpStanding({ db, oidc: oidc(providerId), authSecret: 'a'.repeat(40), log: { info() {}, warn() {}, error() {} }, fetcher: fetcher as never });
    const human = await insertedHuman('bcl-real');
    await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: human.id, accountId: 'sub-real', providerId });
    await service.recordSignIn(human.id, 'stored-offline-token', 'sid-real');
    await service.revokeOffline([human.id]);
    const row = (await pool.query('SELECT state, reason, refresh_token_enc, refresh_token_sid FROM auth_idp_standing WHERE user_id = $1', [human.id])).rows[0];
    assert.deepEqual(row, { state: 'sign_in_required', reason: 'offline_access_revoked', refresh_token_enc: null, refresh_token_sid: null });
    assert.ok(calls.some((call) => call.startsWith('http://idp.test/revoke') && call.includes('token=stored-offline-token')));
    assert.equal(await service.stands(human.id), false);
  });
});
