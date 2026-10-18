import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOAuthDiagnostic, oauthBrowserFailure, oauthCallbackPattern, oauthCallbackTarget, oauthHttpObservation, oauthLoginOnly } from './support/oauth-diagnostics.js';

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


test('frozen callback regex escaping and safe target classes separate matching from transport completion', () => {
  const secret = 'SENSITIVE_CALLBACK_NEVER_EMIT', port = 19831;
  const pattern = oauthCallbackPattern(port);
  assert.ok(pattern.test(`http://127.0.0.1:${port}/callback?code=${secret}`));
  assert.ok(pattern.test(`http://localhost:${port}/callback/native-id?iss=${secret}`));
  assert.equal(pattern.test(`http://127x0x0x1:${port}/callback`), false, 'dots are escaped exactly once in the compiled regex');
  assert.equal(pattern.test(`http://127.0.0.1:${port + 1}/callback`), false);
  assert.throws(() => oauthCallbackPattern(0));
  const target = oauthCallbackTarget(`http://127.0.0.1:${port + 1}/callback/private-id?iss=${secret}&code=${secret}`, port)!;
  assert.deepEqual(target, { loopback: true, expectedPort: false, path: 'suffixed', issuerPresent: true, codePresent: true, errorPresent: false });
  assert.equal(oauthCallbackTarget(`https://outside.invalid/other?error=${secret}`, port)?.path, 'other');
  assert.equal(oauthCallbackTarget(`http://[::1]:${port}/callback?error=${secret}`, port)?.loopback, true);
  assert.equal(pattern.test(`http://[::1]:${port}/callback`), false, 'a regex miss alone is not proof of a failed callback transport');
  const diagnostic = createOAuthDiagnostic();
  diagnostic.browser({ stage: 'callback_wait_failed' });
  diagnostic.callback({ phase: 'request', target, url: secret } as never);
  diagnostic.callback({ phase: 'failure', target, failure: oauthBrowserFailure(`net::ERR_CONNECTION_REFUSED ${secret}`) });
  diagnostic.callback({ phase: 'response', target, status: 404 });
  diagnostic.callback({ phase: secret, target } as never);
  const report = diagnostic.report('', 1);
  assert.deepEqual(report.callbacks.map(row => row.phase), ['request', 'failure', 'response']);
  assert.equal(report.callbacks[1]!.failure, 'connection_refused');
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(report.callbackCompleted, false, 'target and match classification do not manufacture HTTP completion');
  assert.equal(oauthBrowserFailure(`arbitrary private browser failure ${secret}`), 'unknown');
  for (let index = 0; index < 100; index++) diagnostic.callback({ phase: 'request', target });
  assert.equal(diagnostic.report('', 1).callbacks.length, 16);
});
