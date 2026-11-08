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
