import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOAuthDiagnostic, oauthHttpObservation, oauthLoginOnly } from './support/oauth-diagnostics.js';

test('OAuth diagnostics expose only bounded fixed codes/stages/status and callback completion', () => {
  const secret = 'SENSITIVE_NEVER_EMIT';
  const diagnostic = createOAuthDiagnostic();
  diagnostic.browser({ stage: 'native_login_started' });
  const token = oauthHttpObservation(`/api/auth/oauth2/token?code=${secret}&state=${secret}`, 400);
  assert.deepEqual(token, { stage: 'token_endpoint', status: 400 }); diagnostic.response(token!);
  diagnostic.browser({ stage: 'callback_response', status: 500 });
  assert.equal(diagnostic.report('', 1).callbackCompleted, false);
  diagnostic.browser({ stage: 'callback_response', status: 200 });
  // Runtime callers cannot smuggle additional fields, an unknown stage or invalid status into output.
  diagnostic.browser({ stage: secret, status: 200 } as never);
  diagnostic.response({ stage: secret, status: 200 } as never);
  diagnostic.response({ stage: 'token_endpoint', status: 999, url: secret } as never);
  const report = diagnostic.report(`stderr https://outside.invalid/callback?code=${secret}\n{"error":"invalid_grant","access_token":"${secret}"}\nunknown_failure`, 1);
  assert.deepEqual(report.observedCodes, ['invalid_grant']); assert.equal(report.callbackCompleted, true);
  assert.equal(report.nativeExitCode, 1); assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes('unknown_failure')); assert.ok(!JSON.stringify(report).includes('https:'));
  assert.equal(oauthHttpObservation(`/not-an-oauth-endpoint?access_token=${secret}`, 200), null);
  assert.equal(oauthHttpObservation('/api/auth/oauth2/token', 99), null);
  for (let index = 0; index < 1000; index++) {
    diagnostic.browser({ stage: 'callback_response', status: 200 }); diagnostic.response(token!);
  }
  const bounded = diagnostic.report(secret, -1);
  assert.equal(bounded.stages.length, 32); assert.equal(bounded.http.length, 64); assert.equal(bounded.nativeExitCode, null);
});

test('login-only is an explicit Codex-only mode and refuses a missing workflow opt-in', () => {
  assert.equal(oauthLoginOnly({}), false);
  const env = { FLUX_TEST_MCP_OAUTH_ONLY: '1', FLUX_TEST_MCP_LIVE_WORKFLOW: '1', FLUX_TEST_MCP_LIVE_CLIENT: 'codex' };
  assert.equal(oauthLoginOnly(env), true);
  assert.throws(() => oauthLoginOnly({ ...env, FLUX_TEST_MCP_LIVE_CLIENT: 'claude' }));
  assert.throws(() => oauthLoginOnly({ ...env, FLUX_TEST_MCP_LIVE_WORKFLOW: '0' }));
});
