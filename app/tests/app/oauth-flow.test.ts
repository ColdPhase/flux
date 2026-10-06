import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { oauthClientIdHost, oauthRedirectTarget } from '@flux/core';
import { oauthFingerprint, oauthFlow, verifiedOauthQuery } from '../../apps/server/src/identity/oauth-query.js';
import { createOauthRequests, oauthRequestContext } from '../../apps/server/src/identity/oauth-flow.js';

const secret = 'oauth-flow-test-secret-with-enough-entropy';
const resource = 'https://flux.example/mcp';
function query() {
  return new URLSearchParams({ client_id: 'same-client', redirect_uri: 'https://client.example/callback',
    response_type: 'code', code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256',
    state: 'request-specific-state', scope: 'flux.context.read offline_access', resource,
    nonce: 'oidc-nonce', prompt: 'consent', max_age: '60', claims: '{"id_token":{}}',
    dpop_jkt: 'public-key-thumbprint', ba_future_semantic: 'kept', exp: String(Math.floor(Date.now() / 1000) + 600),
    ba_iat: String(Date.now()), ba_pl: 'current-session' });
}
function signed(params: URLSearchParams) {
  const canonical = new URLSearchParams([...params.entries()].sort(([a, av], [b, bv]) =>
    a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const signature = createHmac('sha256', secret).update(canonical.toString()).digest('base64');
  const result = new URLSearchParams(params); result.append('sig', signature); return result.toString();
}

test('flow fingerprints bind every semantic parameter and omit only the pinned provider transport markers', async () => {
  const original = query(); const fingerprint = oauthFingerprint(original);
  const transport = new URLSearchParams(original);
  transport.set('exp', '100'); transport.set('ba_iat', '200'); transport.set('ba_pl', 'other-session');
  transport.append('ba_param', 'client_id'); transport.append('ba_param', 'scope'); transport.set('sig', 'other');
  assert.equal(oauthFingerprint(transport), fingerprint);
  assert.equal(oauthFingerprint(new URLSearchParams([...original.entries()].reverse())), fingerprint);
  for (const key of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state',
    'scope', 'resource', 'nonce', 'prompt', 'max_age', 'claims', 'dpop_jkt', 'ba_future_semantic']) {
    const changed = new URLSearchParams(original); changed.set(key, `${original.get(key)} changed`);
    assert.notEqual(oauthFingerprint(changed), fingerprint, key);
    assert.equal(await verifiedOauthQuery(`${signed(original)}&${encodeURIComponent(key)}=substituted`, secret), null, key);
  }
  assert.equal(oauthFlow(original, resource)?.fingerprint, fingerprint);
  assert.equal(oauthFlow(original, resource)?.redirectUri, 'https://client.example/callback', 'consent shows where access goes (#287)');
  const verified = await verifiedOauthQuery(signed(original), secret); assert.ok(verified);
  assert.equal(oauthFlow(verified, resource)?.fingerprint, fingerprint);
});

test('expired, duplicated and unsupported signed authorization requests fail closed', async () => {
  const expired = query(); expired.set('exp', String(Math.floor(Date.now() / 1000) - 1));
  assert.equal(await verifiedOauthQuery(signed(expired), secret), null);
  assert.equal(await verifiedOauthQuery(`${signed(query())}&sig=duplicate`, secret), null);
  for (const [key, value] of [['client_id', 'other'], ['exp', '1'], ['resource', resource]]) {
    const repeated = query(); repeated.append(key, value);
    const verified = await verifiedOauthQuery(signed(repeated), secret);
    assert.equal(verified ? oauthFlow(verified, resource) : null, null, key);
  }
  for (const [key, value] of [['request_uri', 'https://client.example/request'], ['request', 'jwt'],
    ['code_challenge_method', 'plain'], ['resource', 'https://other.example/mcp'], ['scope', 'flux.admin']]) {
    const unsupported = query(); unsupported.set(key, value);
    assert.equal(oauthFlow(unsupported, resource), null, key);
  }
  for (const key of ['client_id', 'redirect_uri']) {
    const missing = query(); missing.delete(key);
    assert.equal(oauthFlow(missing, resource), null, `without ${key}`);
  }
  await assert.rejects(oauthRequestContext(new URL('https://flux.example/api/auth/oauth2/continue'),
    'oauth_query=one&oauth_query=two', secret, resource));
});

test('OAuth callback context is isolated across concurrent requests and auth instances', async () => {
  const requests = createOauthRequests(); const other = createOauthRequests();
  const url = new URL('https://flux.example/api/auth/oauth2/continue');
  const a = await oauthRequestContext(url, { oauth_query: signed(query()) }, secret, resource); assert.ok(a);
  const changed = query(); changed.set('state', 'another-tab');
  const b = await oauthRequestContext(url, { oauth_query: signed(changed) }, secret, resource); assert.ok(b);
  await Promise.all([a, b].map((context) => requests.run(context, async () => {
    await Promise.resolve(); assert.equal(requests.getStore(), context); assert.equal(other.getStore(), undefined);
  })));
  assert.equal(requests.getStore(), undefined);
});

test('consent names where access goes: loopback, web host, app link and the metadata-document client host (#287)', () => {
  for (const [uri, expected] of [
    ['http://127.0.0.1:19737/callback', { kind: 'loopback', host: '127.0.0.1:19737' }],
    ['http://[::1]:8123/cb', { kind: 'loopback', host: '[::1]:8123' }],
    ['http://LOCALHOST:33418/callback', { kind: 'loopback', host: 'localhost:33418' }],
    ['https://localhost/callback', { kind: 'loopback', host: 'localhost' }],
    ['https://collector.example.net/oauth/callback', { kind: 'web', host: 'collector.example.net' }],
    ['http://127.0.0.1.collector.example.net:8080/cb', { kind: 'web', host: '127.0.0.1.collector.example.net:8080' }],
    ['http://localhost.collector.example.net/cb', { kind: 'web', host: 'localhost.collector.example.net' }],
    ['http://10.0.0.7:9000/cb', { kind: 'web', host: '10.0.0.7:9000' }],
    // A look-alike internationalised name is shown in its unambiguous ASCII form.
    ['https://cläude.example/cb', { kind: 'web', host: 'xn--clude-hra.example' }],
    ['com.example.agent:/oauth/callback', { kind: 'app', host: 'com.example.agent:/oauth/callback' }],
    ['not a url', { kind: 'app', host: 'not a url' }],
  ] as const) assert.deepEqual(oauthRedirectTarget(uri), expected, uri);
  assert.equal(oauthClientIdHost('https://agent-tools.example.org/oauth/client.json'), 'agent-tools.example.org');
  assert.equal(oauthClientIdHost('https://agent-tools.example.org:8443/client.json'), 'agent-tools.example.org:8443');
  for (const clientId of ['flux-fixture-1', 'http://agent-tools.example.org/client.json', 'urn:example:client', ''])
    assert.equal(oauthClientIdHost(clientId), null, clientId);
});
