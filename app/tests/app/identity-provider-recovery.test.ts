import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { registerIdentity, loadIdentityConfig, type IdentityConfig } from '../../apps/server/src/identity/index.js';
import { oidcProviderId } from '../../apps/server/src/identity/config.js';
import { db } from './support/db.js';

// F-024 S1 AC-4 (#310): the provider starts answering after Flux has started. The same running Flux
// then offers the provider and starts a sign-in, with no restart. A stub discovery server stands in for
// the provider here; the Keycloak-backed run is tests/app/e2e/oidc-mcp.e2e.ts.
const publicOrigin = 'http://127.0.0.1:18990';
let answering = false;
let discoveryReads = 0;
let failDiscoveryRead = 0;
const stub = http.createServer((request, response) => {
  if (request.url === '/realms/flux/.well-known/openid-configuration') {
    discoveryReads += 1;
    if (!answering || discoveryReads === failDiscoveryRead) { response.writeHead(503).end(); return; }
    const issuer = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/realms/flux`;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      issuer, authorization_endpoint: `${issuer}/protocol/openid-connect/auth`, token_endpoint: `${issuer}/protocol/openid-connect/token`,
      jwks_uri: `${issuer}/protocol/openid-connect/certs`, id_token_signing_alg_values_supported: ['RS256'],
    }));
    return;
  }
  if (request.url === '/realms/flux/protocol/openid-connect/certs') { response.writeHead(200, { 'content-type': 'application/json' }).end('{"keys":[]}'); return; }
  response.writeHead(404).end();
});

before(async () => {
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

test('a provider that answers only after Flux started is offered and can start a sign-in without a restart', async () => {
  const issuer = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/realms/flux`;
  const config: IdentityConfig = {
    ...loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: randomBytes(32).toString('base64url'), FLUX_AUTH_RATE_LIMIT: 'false' }),
    oidc: { providerId: oidcProviderId(issuer), issuer, clientId: 'flux-recovery-test', clientSecret: 'recovery-test-secret', label: 'Recovery provider', standing: 'off', standingIntervalMs: 900_000, confirmationMaxAgeMs: 7 * 24 * 3_600_000 },
  };
  const app = Fastify();
  registerIdentity(app, { db, config, mailer: null });
  await app.ready(); // The provider is still down: startup gives up waiting and reports it as not reachable.

  const capabilities = async () => (await app.inject({ method: 'GET', url: '/api/v1/auth/capabilities' })).json() as { sso: { reachable: boolean } | null };
  assert.equal((await capabilities()).sso?.reachable, false, 'down at startup: reported as not reachable');

  answering = true;
  const deadline = Date.now() + 60_000;
  while ((await capabilities()).sso?.reachable !== true) {
    assert.ok(Date.now() < deadline, 'the provider was not offered within a minute of answering');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const started = await app.inject({ method: 'POST', url: '/api/auth/sign-in/social', headers: { origin: publicOrigin, 'content-type': 'application/json' },
    payload: { provider: config.oidc!.providerId, callbackURL: '/', disableRedirect: true } });
  assert.equal(started.statusCode, 200, started.body);
  assert.ok(String((started.json() as { url?: string }).url).startsWith(`${issuer}/protocol/openid-connect/auth`), 'the sign-in goes to the provider');
  await app.close();
});


test('a successful probe followed by skipped plugin discovery keeps retrying until the provider is registered', async () => {
  answering = true; discoveryReads = 0; failDiscoveryRead = 2;
  const issuer = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/realms/flux`;
  const config: IdentityConfig = {
    ...loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: randomBytes(32).toString('base64url'), FLUX_AUTH_RATE_LIMIT: 'false' }),
    oidc: { providerId: oidcProviderId(issuer), issuer, clientId: 'flux-race-test', clientSecret: 'race-test-secret', label: 'Race provider', standing: 'off', standingIntervalMs: 900_000, confirmationMaxAgeMs: 7 * 24 * 3_600_000 },
  };
  const app = Fastify(); const identity = registerIdentity(app, { db, config, mailer: null });
  try {
    await app.ready();
    assert.equal((await identity.auth.$context).socialProviders.some((p) => p.id === config.oidc!.providerId), false, 'the second discovery read skipped the plugin');
    const deadline = Date.now() + 20_000;
    while (!(await identity.auth.$context).socialProviders.some((p) => p.id === config.oidc!.providerId)) {
      assert.ok(Date.now() < deadline, 'the provider was not reinstalled after the skipped read');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const started = await app.inject({ method: 'POST', url: '/api/auth/sign-in/social', headers: { origin: publicOrigin },
      payload: { provider: config.oidc!.providerId, callbackURL: '/', disableRedirect: true } });
    assert.equal(started.statusCode, 200, started.body);
    assert.ok(discoveryReads >= 4, 'both the recovery probe and plugin discovery ran again');
  } finally { await app.close(); failDiscoveryRead = 0; }
});
