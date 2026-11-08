import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { decodedPath, isRouted, originFormTarget, routedPaths, upgradePath } from '../../apps/server/src/http/routed-path.js';

// What decides which part of the API a request belongs to (#1047). The router percent-decodes the path before it matches a route, so a check
// made on the raw URL never saw `/%61pi/v1/me`, `/%6dcp` or `/health#x`. No database or process: Fastify on a loopback socket, because
// `inject` parses the URL first (it resolves dot segments and drops a fragment) and a client's bytes are not parsed like that.

describe('the path as the router reads it', () => {
  test('letters, dots and hyphens written as escapes are themselves, in either case of the hex digits', () => {
    assert.equal(decodedPath('/%61pi/v1/me'), '/api/v1/me');
    assert.equal(decodedPath('/%61%70%69/v1/%6De'), '/api/v1/me');
    assert.equal(decodedPath('/%6dcp'), '/mcp');
    assert.equal(decodedPath('/%6Dcp'), '/mcp');
    assert.equal(decodedPath('/%2ewell-known/x'), '/.well-known/x');
    assert.equal(decodedPath('/%2Ewell%2Dknown/x'), '/.well-known/x');
    assert.equal(decodedPath('/caf%C3%A9'), '/café');
  });

  test('the characters that mean something in a URL, and %25 itself, stay as written: decoded once, never twice', () => {
    assert.equal(decodedPath('/api%2Fv1/me'), '/api%2Fv1/me');
    assert.equal(decodedPath('/api%2fv1/me'), '/api%2fv1/me');
    for (const escaped of ['%23', '%24', '%26', '%2B', '%2C', '%3A', '%3B', '%3D', '%3F', '%40']) assert.equal(decodedPath(`/a${escaped}b`), `/a${escaped}b`, escaped);
    assert.equal(decodedPath('/%2561pi/v1/me'), '/%2561pi/v1/me', 'a double-encoded letter is not the letter');
    assert.equal(decodedPath('/%252561pi'), '/%252561pi');
    assert.equal(decodedPath('/a%25b'), '/a%25b');
  });

  test('the path ends at the first ? or #, and dot segments, //, a trailing slash and case are left alone', () => {
    assert.equal(decodedPath('/health#x'), '/health');
    assert.equal(decodedPath('/mcp?x=1#y'), '/mcp');
    assert.equal(decodedPath('/mcp#x?y=1'), '/mcp');
    assert.equal(decodedPath('/m%63p?x=%61'), '/mcp');
    assert.equal(decodedPath('/api/v1/./me'), '/api/v1/./me');
    assert.equal(decodedPath('/api/v1/%2e%2e/me'), '/api/v1/../me');
    assert.equal(decodedPath('//api/v1/me'), '//api/v1/me');
    assert.equal(decodedPath('/api/v1/me/'), '/api/v1/me/');
    assert.equal(decodedPath('/API/v1/me'), '/API/v1/me');
  });

  test('a target that is not origin-form is read the way the router reads it: absolute-form by its path, a first character that is not / skipped', () => {
    assert.equal(originFormTarget('/api/v1/me?x'), '/api/v1/me?x');
    assert.equal(originFormTarget('http://host/api/v1/me?x=1'), '/api/v1/me?x=1');
    assert.equal(originFormTarget('HTTPS://Host:8443/%61pi/v1/me'), '/%61pi/v1/me');
    assert.equal(originFormTarget('http://host'), '/');
    assert.equal(originFormTarget('http://host?x=1'), '/?x=1');
    for (const unchanged of ['ftp://host/api', '*api/v1/me', 'api/v1/me', '*', 'http://', 'http:///api', 'http://host#/api', 'http://[/api', 'http://a%zz/api', 'http://a:99999/api']) {
      assert.equal(originFormTarget(unchanged), unchanged, unchanged);
    }
    assert.equal(decodedPath('http://host/api/v1/me'), '/api/v1/me');
    assert.equal(decodedPath('HTTP://host/%61pi/v1/m%65?x'), '/api/v1/me');
    assert.equal(decodedPath('*api/v1/me'), '/api/v1/me');
    assert.equal(decodedPath('*%61pi/v1/me'), '/api/v1/me');
    assert.equal(decodedPath('api/v1/me'), '/pi/v1/me');
    assert.equal(decodedPath(''), '/');
    assert.equal(upgradePath('*media/rtc'), '/*media/rtc', 'a gate reads a target as a URL, and the dispatcher refuses it before');
  });

  test('a path that does not decode is a 400 before any route, so it stays as written', () => {
    assert.equal(decodedPath('/%E0%A4%A'), '/%E0%A4%A');
    assert.equal(decodedPath('/%C0%AF'), '/%C0%AF');
    assert.equal(decodedPath('/%%2525'), '/%%2525');
  });

  test('an upgrade path is read as the router reads it, after a URL is parsed: dot segments resolve and escapes decode', () => {
    assert.equal(upgradePath('/api/v1/%65diting?kind=map&id=1'), '/api/v1/editing');
    assert.equal(upgradePath('/%61pi/v1/editing'), '/api/v1/editing');
    assert.equal(upgradePath('/api/v1/./editing'), '/api/v1/editing');
    assert.equal(upgradePath('/api/v1/%2e/editing'), '/api/v1/editing');
    assert.equal(upgradePath('/%6dedia/rtc?access_token=x'), '/media/rtc');
    assert.equal(upgradePath('/api%2Fv1/editing'), '/api%2Fv1/editing');
    assert.equal(upgradePath('/%2561pi/v1/editing'), '/%2561pi/v1/editing');
    assert.equal(upgradePath(undefined), '/');
    assert.equal(upgradePath('http://['), null);
  });
});

describe('what a request is judged by', () => {
  test('the route that answers it and its decoded path, either of them', () => {
    assert.deepEqual(routedPaths({ url: '/%61pi/v1/me', routeOptions: { url: '/api/v1/me' } }), ['/api/v1/me'], 'the route and the path agree');
    assert.deepEqual(routedPaths({ url: '/%61pi/v1/files/a%2Fb', routeOptions: { url: '/api/v1/files/:id' } }), ['/api/v1/files/:id', '/api/v1/files/a%2Fb']);
    assert.deepEqual(routedPaths({ url: '/%61pi/v1/nope', routeOptions: { url: undefined } }), ['/api/v1/nope'], 'nothing matched: the path alone');
    assert.deepEqual(routedPaths({ url: '/x' }), ['/x']);
    assert.equal(isRouted({ url: '/.well-known/x#y', routeOptions: { url: '/*' } }, '/api/'), false);
    assert.equal(isRouted({ url: '/.well-known/x#y', routeOptions: { url: '/*' } }, /^\/\.well-known\//), true, 'a file the static handler answers is judged by its path');
    assert.equal(isRouted({ url: '/%61pi/v1/me', routeOptions: { url: '/api/v1/me' } }, '/api/'), true);
    assert.equal(isRouted({ url: '/anything', routeOptions: { url: '/api/v1/me' } }, '/api/'), true, 'the route that ran wins over a path that does not look like it');
    assert.equal(isRouted({ url: '/%2561pi/v1/me' }, '/api/'), false);
  });
});

// The decoding above is a copy of find-my-way's. Everything that matters is decided by the route that ran, but the path covers requests no
// route answers, so a router that starts reading paths differently has to fail here and not in production.
describe('the router and this decoding agree', () => {
  test('a URL reaches a route exactly when its decoded path is that route\'s path', async () => {
    const app = Fastify({ logger: false });
    const seen: { route: string | undefined; url: string }[] = [];
    app.addHook('onRequest', async (request) => { seen.push({ route: request.routeOptions.url, url: request.url }); });
    const routes = ['/api/v1/me', '/mcp', '/health', '/.well-known/oauth-protected-resource', '/café'];
    for (const route of routes) app.get(route, async () => ({ ok: true }));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const wire = (path: string) => new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
      outgoing.on('error', reject);
      outgoing.end();
    });
    try {
      const urls = [
        '/api/v1/me', '/%61pi/v1/me', '/%61%70%69/v1/%6De', '/api/v1/me?x=1', '/api/v1/me#x', '/api/v1/me?x=1#y', '/api/v1/me#x?y=1', '/api/v1/me/', '/api/v1/me//',
        '//api/v1/me', '/api//v1/me', '/./api/v1/me', '/api/v1/./me', '/api/v1/../v1/me', '/api/v1/%2e%2e/v1/me', '/api/v1/%2E/me', '/%2e%2e/api/v1/me',
        '/api%2Fv1/me', '/api%2fv1%2fme', '/api/v1%2Fme', '/api/v1/me%2F', '/api/v1/me%3F', '/api/v1/me%23', '/api/v1/me%00', '/api/v1/me%20', '/api/v1/m%65%',
        '/%2561pi/v1/me', '/%252561pi/v1/me', '/api/v1/m%2565', '/API/v1/me', '/Api/v1/me', '/%41pi/v1/me', '/api/v1/ME',
        '/mcp', '/%6dcp', '/%6Dcp', '/MCP', '/m%63p', '/mcp#x', '/mcp/', '/mcp%2F', '/mcpx', '/%6dcp/x',
        '/health', '/%68ealth', '/health#x', '/health?x', '/h%65alth/',
        '/.well-known/oauth-protected-resource', '/%2ewell-known/oauth-protected-resource', '/%2Ewell-known/oauth-protected-resource', '/.well-known/oauth-protected-resource#x',
        '/caf%C3%A9', '/caf%c3%a9', '/caf%C3',
        // Targets that are not origin-form: absolute-form is read by its path, a first character that is not `/` is skipped, and what does not parse is a 400.
        'http://x/api/v1/me', 'HTTP://x/%61pi/v1/me?y', 'https://x:8443/mcp', 'http://x', 'http://x?y', 'http://x/health#z', 'http://x/.well-known/oauth-protected-resource',
        'http://[/api/v1/me', 'http://a%zz/api/v1/me', 'http://a:99999/api/v1/me', 'http://x#/api/v1/me', 'ftp://x/api/v1/me',
        '*api/v1/me', '*%61pi/v1/me', '*mcp', '*%6dcp/', 'xhealth', 'api/v1/me',
      ];
      for (const url of urls) {
        seen.length = 0;
        const status = await wire(url);
        const decoded = decodedPath(url);
        const answered = seen[0]?.route;
        const expected = routes.includes(decoded) ? decoded : undefined;
        // A target the router cannot read is a 400 before any hook: nothing is seen at all, and nothing here may throw on it.
        if (seen.length === 0) { assert.equal(status, 400, `${url} is refused`); continue; }
        assert.equal(answered, expected, `${url}: the router ${answered ? `ran ${answered}` : 'matched no route'}, the decoded path ${decoded} says ${expected ?? 'no route'}`);
      }
    } finally { await app.close(); }
  });
});
