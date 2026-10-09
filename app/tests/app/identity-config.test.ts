import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { loadIdentityConfig, registerIdentity, type IdentityConfig } from '../../apps/server/src/identity/index.js';
import { originViolation } from '../../apps/server/src/identity/origin.js';
import { loadOidcConfig, oidcProviderId } from '../../apps/server/src/identity/config.js';
import { oidcUser } from '../../apps/server/src/identity/auth.js';
import { verifiedOauthQuery } from '../../apps/server/src/identity/oauth-query.js';
import { registerMcpRoute } from '../../apps/server/src/agent-connection/mcp-route.js';
import { database } from './support/db.js';

// In-process identity configuration checks with Fastify inject and the Compose database.
const base = { FLUX_PUBLIC_ORIGIN: 'https://flux.example.org', FLUX_AUTH_SECRET: randomBytes(32).toString('hex') };

function config(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return { ...loadIdentityConfig({ ...base, FLUX_AUTH_RATE_LIMIT: 'false' }), ...overrides };
}

async function app(identity: IdentityConfig, trustProxy: string[] | false = false) {
  const instance = Fastify({ trustProxy });
  registerIdentity(instance, { db: database.db, config: identity, mailer: null });
  await instance.ready();
  return instance;
}

describe('identity configuration', () => {
  test('consent display rejects modified or expired signed OAuth queries', async () => {
    const secret = base.FLUX_AUTH_SECRET;
    const valid = new URLSearchParams({ client_id: 'cli_1', exp: String(Math.floor(Date.now() / 1000) + 120), scope: 'flux.context.read' });
    valid.set('sig', createHmac('sha256', secret).update(valid.toString()).digest('base64'));
    assert.equal((await verifiedOauthQuery(valid.toString(), secret))?.get('client_id'), 'cli_1');
    valid.set('scope', 'flux.proposal.write');
    assert.equal(await verifiedOauthQuery(valid.toString(), secret), null);
    const expired = new URLSearchParams({ client_id: 'cli_1', exp: String(Math.floor(Date.now() / 1000) - 1) });
    expired.set('sig', createHmac('sha256', secret).update(expired.toString()).digest('base64'));
    assert.equal(await verifiedOauthQuery(expired.toString(), secret), null);
  });

  test('requires an explicit public origin, a long secret and valid proxy ranges', () => {
    assert.throws(() => loadIdentityConfig({ FLUX_AUTH_SECRET: base.FLUX_AUTH_SECRET }), /FLUX_PUBLIC_ORIGIN is required/);
    assert.throws(() => loadIdentityConfig({ ...base, FLUX_PUBLIC_ORIGIN: 'https://flux.example.org/app' }), /without path/);
    assert.throws(() => loadIdentityConfig({ ...base, FLUX_PUBLIC_ORIGIN: 'ftp://flux.example.org' }), /http or https/);
    // Plain http would send session cookies without Secure; only loopback development may use it.
    for (const origin of ['http://flux.example.org', 'http://10.0.0.5:8080', 'http://192.168.1.20', 'http://127.example.org', 'http://localhost.example.org']) {
      assert.throws(() => loadIdentityConfig({ ...base, FLUX_PUBLIC_ORIGIN: origin }), /must use https unless it is a loopback/, origin);
    }
    for (const origin of ['http://127.0.0.1:8081', 'http://localhost:8081', 'http://[::1]:8081', 'http://127.1.2.3']) {
      assert.equal(loadIdentityConfig({ ...base, FLUX_PUBLIC_ORIGIN: origin }).publicOrigin, origin, origin);
    }
    assert.throws(() => loadIdentityConfig({ ...base, FLUX_AUTH_SECRET: 'short' }), /at least 32/);
    assert.throws(() => loadIdentityConfig({ ...base, FLUX_TRUSTED_PROXIES: '10.0.0.0/33' }), /not an IP address/);
    assert.throws(() => loadIdentityConfig({ ...base, FLUX_TRUSTED_PROXIES: 'proxy.internal' }), /not an IP address/);
    assert.throws(() => loadIdentityConfig({ ...base, FLUX_SMTP_URL: 'smtp://mail:25' }), /FLUX_MAIL_FROM/);
    const loaded = loadIdentityConfig({ ...base, FLUX_PUBLIC_ORIGIN: 'https://flux.example.org/', FLUX_TRUSTED_PROXIES: '10.0.0.1, 172.16.0.0/12,::1' });
    assert.equal(loaded.publicOrigin, 'https://flux.example.org');
    assert.deepEqual(loaded.trustedProxies, ['10.0.0.1', '172.16.0.0/12', '::1']);
    assert.equal(loaded.smtp, null);
    assert.equal(loaded.rateLimit, true, 'rate limiting is on unless explicitly disabled');
  });

  test('single sign-on is all or nothing, https, secret from a file and bound to its issuer (#113)', () => {
    const secret = () => 'client-secret-value\n';
    const oidc = { FLUX_OIDC_ISSUER: 'https://id.example.org/realms/flux/', FLUX_OIDC_CLIENT_ID: 'flux', FLUX_OIDC_CLIENT_SECRET_FILE: '/run/secrets/oidc' };
    assert.equal(loadOidcConfig({}, secret), null, 'unset keeps email/password sign-in only');
    assert.equal(loadIdentityConfig(base).oidc, null);
    for (const missing of ['FLUX_OIDC_ISSUER', 'FLUX_OIDC_CLIENT_ID'] as const) {
      const partial: Record<string, string> = { ...oidc }; delete partial[missing];
      assert.throws(() => loadOidcConfig(partial, secret), /together, or neither/, missing);
    }
    assert.equal(loadOidcConfig({ FLUX_OIDC_CLIENT_SECRET_FILE: '/run/secrets/x' }, secret), null, 'the always-set secret path alone keeps sign-on off');
    assert.throws(() => loadOidcConfig({ FLUX_OIDC_ISSUER: oidc.FLUX_OIDC_ISSUER, FLUX_OIDC_CLIENT_ID: 'flux' }, secret), /SECRET_FILE is required/);
    const loaded = loadOidcConfig(oidc, secret)!;
    assert.deepEqual(loaded, { providerId: oidcProviderId('https://id.example.org/realms/flux'), issuer: 'https://id.example.org/realms/flux',
      clientId: 'flux', clientSecret: 'client-secret-value', label: 'single sign-on', confirmationMaxAgeMs: 7 * 24 * 3_600_000,
      standing: 'refresh', standingIntervalMs: 900_000 });
    assert.match(loaded.providerId, /^oidc-[0-9a-f]{12}$/);
    assert.notEqual(oidcProviderId('https://id.example.org/realms/other'), loaded.providerId, 'another issuer is another identity namespace');
    assert.equal(loadOidcConfig({ ...oidc, FLUX_OIDC_LABEL: 'Acme login' }, secret)!.label, 'Acme login');
    assert.throws(() => loadOidcConfig({ ...oidc, FLUX_OIDC_ISSUER: 'http://id.example.org/realms/flux' }, secret), /must use https/);
    assert.equal(loadOidcConfig({ ...oidc, FLUX_OIDC_ISSUER: 'http://127.0.0.1:8080/realms/flux' }, secret)!.issuer, 'http://127.0.0.1:8080/realms/flux');
    assert.equal(loadOidcConfig({ ...oidc, FLUX_OIDC_ISSUER: 'http://keycloak:8080/realms/flux', FLUX_OIDC_ALLOW_HTTP_ISSUER: 'true' }, secret)!.issuer,
      'http://keycloak:8080/realms/flux', 'an isolated test IdP can be explicitly allowed');
    assert.throws(() => loadOidcConfig({ ...oidc, FLUX_OIDC_ISSUER: 'https://id.example.org/?x=1' }, secret), /query, fragment or credentials/);
    assert.throws(() => loadOidcConfig({ ...oidc, FLUX_OIDC_ISSUER: 'not a url' }, secret), /absolute URL/);
    assert.throws(() => loadOidcConfig(oidc, () => '  \n'), /is empty/);
    assert.throws(() => loadOidcConfig(oidc, () => { throw new Error('ENOENT'); }), /cannot be read/);
    assert.throws(() => loadOidcConfig({ ...oidc, FLUX_OIDC_LABEL: 'x'.repeat(61) }, secret), /at most 60/);
    assert.equal(loadOidcConfig({ ...oidc, FLUX_OIDC_STANDING: 'off' }, secret)!.standing, 'off');
    assert.throws(() => loadOidcConfig({ ...oidc, FLUX_OIDC_STANDING: 'sometimes' }, secret), /refresh or off/);
    assert.equal(loadOidcConfig({ ...oidc, FLUX_OIDC_STANDING_INTERVAL_SECONDS: '60' }, secret)!.standingIntervalMs, 60_000);
    for (const bad of ['4', '86401', 'x', '1.5']) assert.throws(() => loadOidcConfig({ ...oidc, FLUX_OIDC_STANDING_INTERVAL_SECONDS: bad }, secret), /from 5 to 86400/, bad);
  });

  test('only a verified email from the configured issuer signs in; groups and roles are ignored (#113)', () => {
    const issuer = { issuer: 'https://id.example.org/realms/flux' };
    const claims = { iss: 'https://id.example.org/realms/flux', sub: 'abc', email: ' Ada@Example.ORG ', email_verified: true,
      name: 'Ada Kowalska', groups: ['flux-admins'], realm_access: { roles: ['admin'] } };
    assert.deepEqual(oidcUser(issuer, claims), { id: 'abc', sub: 'abc', email: 'ada@example.org', emailVerified: true, name: 'Ada Kowalska' });
    assert.equal(oidcUser(issuer, { ...claims, name: undefined, preferred_username: 'ada' })!.name, 'ada');
    assert.equal(oidcUser(issuer, { ...claims, iss: 'https://id.example.org/realms/flux/' })!.email, 'ada@example.org');
    for (const [label, change] of [['unverified', { email_verified: false }], ['string flag', { email_verified: 'true' }], ['no email', { email: '' }],
      ['no subject', { sub: '' }], ['other issuer', { iss: 'https://evil.example.org/realms/flux' }], ['no issuer', { iss: undefined }]] as const) {
      assert.equal(oidcUser(issuer, { ...claims, ...change }), null, label);
    }
    assert.equal(oidcUser(issuer, null), null, 'no ID token');
  });

  test('origin policy accepts only the configured origin for state changes', () => {
    const origin = 'https://flux.example.org';
    assert.equal(originViolation('GET', { origin: 'https://evil.example' }, origin), null);
    assert.equal(originViolation('POST', { origin }, origin), null);
    assert.equal(originViolation('POST', { origin: 'https://evil.example', host: 'flux.example.org' }, origin), 'foreign_origin');
    assert.equal(originViolation('POST', { origin: 'http://flux.example.org' }, origin), 'foreign_origin');
    assert.equal(originViolation('DELETE', { cookie: 'a=b' }, origin), 'missing_origin');
    assert.equal(originViolation('POST', { cookie: 'a=b', referer: `${origin}/settings` }, origin), null);
    assert.equal(originViolation('POST', { 'sec-fetch-site': 'same-site' }, origin), 'cross_site_request');
    assert.equal(originViolation('POST', { authorization: 'Bearer token' }, origin), null, 'non-browser clients without cookies pass');
  });
});

describe('identity server behaviour', () => {
  test('unauthenticated MCP calls advertise the protected resource', async () => {
    const identity = config();
    const server = Fastify();
    const registered = registerIdentity(server, { db: database.db, config: identity, mailer: null });
    registerMcpRoute(server, database.db, registered.auth, identity.publicOrigin);
    await server.ready();
    try {
      const response = await server.inject({ method: 'POST', url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } },
      });
      assert.equal(response.statusCode, 401);
      assert.match(response.headers['www-authenticate'] as string, /oauth-protected-resource/);
    } finally { await server.close(); }
  });

  test('OAuth token endpoint accepts form encoding and rejects an invalid grant itself', async () => {
    const server = await app(config());
    try {
      const response = await server.inject({ method: 'POST', url: '/api/auth/oauth2/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://flux.example.org' },
        payload: 'grant_type=authorization_code&code=invalid',
      });
      assert.notEqual(response.statusCode, 415);
      assert.ok(response.statusCode >= 400 && response.statusCode < 500);
    } finally { await server.close(); }
  });

  test('publishes OAuth and MCP discovery only at the expected paths', async () => {
    const server = await app(config());
    try {
      const resource = await server.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
      assert.equal(resource.statusCode, 200);
      assert.equal(resource.json().resource, 'https://flux.example.org/mcp');
      const issuer = await server.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server/api/auth' });
      assert.equal(issuer.statusCode, 200);
      assert.equal(issuer.json().issuer, 'https://flux.example.org/api/auth');
      assert.equal((await server.inject({ method: 'GET', url: '/.well-known/unrelated' })).statusCode, 404);
    } finally { await server.close(); }
  });

  test('password reset reports unavailable when SMTP is not configured', async () => {
    const server = await app(config());
    try {
      assert.deepEqual((await server.inject({ method: 'GET', url: '/api/v1/auth/capabilities' })).json(), { passwordReset: 'unavailable', sso: null });
      const response = await server.inject({
        method: 'POST', url: '/api/auth/request-password-reset',
        headers: { origin: 'https://flux.example.org' },
        payload: { email: 'someone@example.test', redirectTo: 'https://flux.example.org/reset-password' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, 'PASSWORD_RESET_UNAVAILABLE');
    } finally {
      await server.close();
    }
  });

  test('an https public origin issues Secure, HttpOnly, SameSite cookies', async () => {
    const server = await app(config());
    try {
      const response = await server.inject({
        method: 'POST', url: '/api/auth/sign-up/email',
        headers: { origin: 'https://flux.example.org' },
        payload: { email: `secure-${randomUUID()}@example.test`, password: 'correct horse battery staple', name: 'Secure Person' },
      });
      assert.equal(response.statusCode, 200);
      const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      const session = cookies.find((cookie) => cookie.startsWith('__Secure-flux.session_token='));
      assert.ok(session, `secure-prefixed session cookie in ${cookies.join(' | ')}`);
      assert.match(session, /;\s*Secure/i);
      assert.match(session, /;\s*HttpOnly/i);
      assert.match(session, /;\s*SameSite=Lax/i);
    } finally {
      await server.close();
    }
  });

  test('X-Forwarded-For is believed only from a configured trusted proxy', async () => {
    const server = await app(config({ trustedProxies: ['10.9.9.9'] }), ['10.9.9.9']);
    try {
      async function signUpFrom(remoteAddress: string) {
        const email = `proxy-${randomUUID()}@example.test`;
        await server.inject({
          method: 'POST', url: '/api/auth/sign-up/email', remoteAddress,
          headers: { origin: 'https://flux.example.org', 'x-forwarded-for': '198.51.100.4' },
          payload: { email, password: 'correct horse battery staple', name: 'Proxy Person' },
        });
        const { rows } = await database.pool.query<{ ip_address: string }>(
          'SELECT s.ip_address FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE u.email = $1', [email]);
        return rows[0]?.ip_address;
      }
      assert.equal(await signUpFrom('10.9.9.9'), '198.51.100.4', 'trusted proxy forwards the client address');
      assert.equal(await signUpFrom('192.0.2.50'), '192.0.2.50', 'an untrusted sender cannot forward an address');
    } finally {
      await server.close();
    }
  });
});
