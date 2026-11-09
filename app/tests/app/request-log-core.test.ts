import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestIdGenerator, requestLogSerializer } from '../../apps/server/src/http/log-serializers.js';

// The API's request log (F-030, #655, #827): no query string, and a request's own short id when it sends one.

test('the request id is the caller\'s X-Request-ID when it is a short plain identifier, else a counter', () => {
  const next = createRequestIdGenerator();
  assert.equal(next({ headers: { 'x-request-id': 'perf-a1b2c3-17' } }), 'perf-a1b2c3-17');
  assert.equal(next({ headers: { 'x-request-id': '3f2504e0-4f89-11d3-9a0c-0305e82c3301' } }), '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  assert.equal(next({ headers: {} }), 'req-1');
  assert.equal(next({ headers: {} }), 'req-2');
  // Anything else is not trusted into the log: a long value, a space, a quote, a newline, a repeated header.
  for (const sent of ['x'.repeat(65), 'two words', 'a"b', 'line\nbreak', '', '{"msg":"forged"}']) assert.match(next({ headers: { 'x-request-id': sent } }), /^req-[0-9a-z]+$/, JSON.stringify(sent));
  assert.match(next({ headers: { 'x-request-id': ['a', 'b'] } }), /^req-[0-9a-z]+$/);
});

test('the logged request keeps its path and drops its query string', () => {
  const logged = requestLogSerializer({ method: 'GET', url: '/api/v1/search?q=private%20text&limit=20', host: 'flux.test', ip: '10.0.0.1', socket: { remotePort: 1234 } } as never);
  assert.equal(logged.url, '/api/v1/search');
  assert.ok(!JSON.stringify(logged).includes('private'));
});

test('the token of a link that sits in the path is logged as <token> (#1030)', () => {
  const logged = (url?: string) => requestLogSerializer({ method: 'GET', url, host: 'flux.test', ip: '10.0.0.1', socket: { remotePort: 1234 } } as never).url;
  assert.equal(logged('/api/auth/reset-password/ZkDOYS3I83T9ydUR7p2yDljZ?callbackURL=%2Freset-password'), '/api/auth/reset-password/<token>');
  assert.equal(logged('/api/auth/reset-password/ZkDOYS3I83T9ydUR7p2yDljZ'), '/api/auth/reset-password/<token>');
  // Path tricks that reach the same route are covered, and the query string stays out as before.
  assert.equal(logged('//api/auth/./reset-password/ZkDOYS3I83T9ydUR7p2yDljZ/?x=1'), '//api/auth/./reset-password/<token>/');
  assert.equal(logged('/API/AUTH/Reset-Password/ZkDOYS3I83T9ydUR7p2yDljZ'), '/API/AUTH/Reset-Password/<token>');
  // Other paths are not touched: the reset form's own page and the routes that take the token in the body.
  assert.equal(logged('/reset-password?token=abc'), '/reset-password');
  assert.equal(logged('/api/auth/reset-password'), '/api/auth/reset-password');
  assert.equal(logged('/api/v1/search?q=reset-password/abc'), '/api/v1/search');
  assert.equal(logged(undefined), '');
});

// The router cuts the path at the first `?` or `#` and reads what follows as the query string, so the log does too (#1047).
test('what follows a # is as much a query string as what follows a ?', () => {
  const logged = requestLogSerializer({ method: 'GET', url: '/api/v1/search#q=private%20text&limit=20', host: 'flux.test', ip: '10.0.0.1', socket: { remotePort: 1234 } } as never);
  assert.equal(logged.url, '/api/v1/search');
  assert.ok(!JSON.stringify(logged).includes('private'));
  assert.equal(requestLogSerializer({ method: 'GET', url: '/api/v1/%61x?q=1#y', host: 'h', ip: '10.0.0.1', socket: {} } as never).url, '/api/v1/%61x');
  // Cut at the first `?` or `#`, then the token is hidden: the one does not undo the other (#1030, #1047).
  const hidden = (url?: string) => requestLogSerializer({ method: 'GET', url, host: 'flux.test', ip: '10.0.0.1', socket: { remotePort: 1234 } } as never).url;
  assert.equal(hidden('/api/auth/reset-password/ZkDOYS3I83T9ydUR7p2yDljZ#x?y=1'), '/api/auth/reset-password/<token>');
  assert.equal(hidden('/api/auth/reset-password/ZkDOYS3I83T9ydUR7p2yDljZ?x=1#y'), '/api/auth/reset-password/<token>');
  assert.equal(hidden('//api/auth/./reset-password/ZkDOYS3I83T9ydUR7p2yDljZ/#x'), '//api/auth/./reset-password/<token>/');
});
