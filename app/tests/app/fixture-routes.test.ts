import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_OAUTH_CLIENT_PATH, SAMPLE_COMMAND_PATH } from '@flux/contracts';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';

// The integration fixture exists only in test deployments (#88): an API built without
// FLUX_FIXTURE_TOKEN answers its routes like any unknown API path, even with failure injection on.
test('without FLUX_FIXTURE_TOKEN the sample command and the test-only routes answer 404', async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLUX_FIXTURE_TOKEN: '',
    FLUX_TEST_FAILURE_INJECTION: 'true',
    // In-process instances share the API container's secret (compose.source.yaml); no token is created here anyway.
    FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `fixture-routes-${'x'.repeat(40)}`,
    FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080',
  };
  const config = loadServerConfig(env, '/nonexistent/flux_background_key');
  assert.equal(config.fixture.token, null);
  const app = await buildApp(config);
  try {
    const requests = [
      { method: 'POST' as const, url: SAMPLE_COMMAND_PATH, payload: { title: 'not here' } },
      { method: 'GET' as const, url: '/api/v1/stream/work' },
      { method: 'GET' as const, url: '/api/v1/search/explain?q=lamp' },
      { method: 'POST' as const, url: FIXTURE_OAUTH_CLIENT_PATH, payload: { name: 'Not here', redirectUris: ['http://127.0.0.1:1/cb'] } },
    ];
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: { authorization: 'Bearer anything', accept: 'application/json' } });
      assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
      assert.deepEqual(response.json(), { error: 'Not Found' });
    }
    // The rest of the API is there.
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/live-sessions/capabilities' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

// OAuth clients come only from metadata documents in a real deployment (#287). `./flux up` sets a
// fixture token for local smoke checks, so the test-only client registration also needs failure
// injection, which only the isolated test deployments turn on.
test('with a fixture token but without failure injection there is no OAuth client registration route', async () => {
  const token = 'fixture-routes-token';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLUX_FIXTURE_TOKEN: token,
    FLUX_TEST_FAILURE_INJECTION: 'false',
    FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `fixture-routes-${'x'.repeat(40)}`,
    FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080',
  };
  const app = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'));
  try {
    const registration = await app.inject({ method: 'POST', url: FIXTURE_OAUTH_CLIENT_PATH, headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Not here', redirectUris: ['http://127.0.0.1:1/cb'] } });
    assert.equal(registration.statusCode, 404);
    assert.deepEqual(registration.json(), { error: 'Not Found' });
    // The sample command is there and still checks its token.
    const sample = await app.inject({ method: 'POST', url: SAMPLE_COMMAND_PATH, headers: { authorization: 'Bearer wrong' }, payload: { title: 'x' } });
    assert.equal(sample.statusCode, 401);
  } finally {
    await app.close();
  }
});
