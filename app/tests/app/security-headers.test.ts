import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { HSTS, useSecurityHeaders } from '../../apps/server/src/http/security-headers.js';
import { Browser, publicOrigin, register, uniqueEmail } from './support/http.js';
import { password } from './support/people.js';

// #992 (OWASP ASVS V14.4.4 to V14.4.6, V8.2.1): headers on every response of the running API, and the hook itself with and without https.
if (!publicOrigin) throw new Error('FLUX_PUBLIC_ORIGIN is required');

describe('security headers on the running API', () => {
  test('the shell, an API answer with a session, an anonymous 401 and a 404 all carry nosniff and a referrer policy', async () => {
    const { browser } = await register(uniqueEmail('headers'), password);
    const answers = {
      shell: await browser.request('GET', '/'),
      workspaces: await browser.request('GET', '/api/v1/workspaces'),
      me: await browser.request('GET', '/api/v1/me'),
      anonymous: await new Browser().request('GET', '/api/v1/me'),
      missing: await browser.request('GET', '/api/v1/no-such-route'),
      auth: await new Browser().request('GET', '/api/auth/ok'),
    };
    for (const [name, answer] of Object.entries(answers)) {
      assert.equal(answer.headers.get('x-content-type-options'), 'nosniff', `${name}: nosniff`);
      assert.equal(answer.headers.get('referrer-policy'), 'same-origin', `${name}: Referrer-Policy`);
      assert.equal(answer.headers.get('x-frame-options'), 'DENY', `${name}: framing is still refused`);
    }
    assert.equal(answers.anonymous.status, 401);
    assert.equal(answers.missing.status, 404);
    for (const name of ['workspaces', 'me', 'anonymous', 'missing', 'auth'] as const) {
      assert.equal(answers[name].headers.get('cache-control'), 'no-store', `${name}: nothing under /api/ is kept by a cache`);
    }
    assert.notEqual(answers.shell.headers.get('cache-control'), 'no-store', 'the app shell is not an API answer and keeps its own cache rule');
  });

  test('no Strict-Transport-Security over the plain-http loopback origin of the check stack', async () => {
    const { browser } = await register(uniqueEmail('headers-http'), password);
    assert.equal((await browser.request('GET', '/api/v1/me')).headers.get('strict-transport-security'), null);
  });
});

describe('the headers hook', () => {
  async function app(hsts: boolean) {
    const server = Fastify();
    useSecurityHeaders(server, { hsts });
    server.get('/api/plain', async () => ({ ok: true }));
    server.get('/api/own', async (_request, reply) => reply.header('cache-control', 'private, max-age=60').header('x-content-type-options', 'nosniff').send('x'));
    server.get('/asset.js', async (_request, reply) => reply.header('cache-control', 'public, max-age=31536000, immutable').type('text/javascript').send('1'));
    server.get('/page', async (_request, reply) => reply.type('text/html').send('<p>x</p>'));
    server.get('/api/fail', async () => { throw new Error('boom'); });
    await server.ready();
    return server;
  }

  test('no-store on /api/ unless the route chose its own; static files and pages are left alone', async () => {
    const server = await app(false);
    try {
      assert.equal((await server.inject('/api/plain')).headers['cache-control'], 'no-store');
      assert.equal((await server.inject('/api/own')).headers['cache-control'], 'private, max-age=60');
      assert.equal((await server.inject('/api/fail')).headers['cache-control'], 'no-store', 'also an error answer');
      assert.equal((await server.inject('/asset.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal((await server.inject('/page')).headers['cache-control'], undefined);
      for (const url of ['/api/plain', '/api/own', '/asset.js', '/page', '/api/fail', '/missing']) {
        const answer = await server.inject(url);
        assert.equal(answer.headers['x-content-type-options'], 'nosniff', url);
        assert.equal(answer.headers['referrer-policy'], 'same-origin', url);
        assert.equal(answer.headers['strict-transport-security'], undefined, `${url}: not with an http origin`);
      }
    } finally { await server.close(); }
  });

  test('an https origin adds Strict-Transport-Security for a year to every answer', async () => {
    const server = await app(true);
    try {
      assert.equal(HSTS, 'max-age=31536000');
      for (const url of ['/api/plain', '/asset.js', '/page', '/missing']) assert.equal((await server.inject(url)).headers['strict-transport-security'], HSTS, url);
    } finally { await server.close(); }
  });
});
