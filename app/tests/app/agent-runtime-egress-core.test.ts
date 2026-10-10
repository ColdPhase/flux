import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { allowedHosts, INSTALL_HOSTS, isMcpRequest, isPublicAddress, parseConnectTarget, VENDOR_HOSTS } from '../../apps/runtime/src/egress/policy.js';
import { capConnectionsPerSource, createMcpForwarder, createProxyServer, EGRESS_LIMITS } from '../../apps/runtime/src/egress/server.js';

// F-022 T3: runtime-egress, the one way out of a slot. Its parsers see bytes a compromised slot
// controls, so they are checked case by case and fuzzed, and the live listeners are fed garbage and
// must keep refusing while still serving a valid request afterwards. Loopback only; the vendor host is
// a local TCP server reached through an injected resolver and connector.

const port = (server: Server | import('node:net').Server) => (server.address() as AddressInfo).port;
const listen = (server: Server | import('node:net').Server) => new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));

/** Sends raw bytes and returns what came back before the connection closed (or after `ms`). */
function rawExchange(target: number, bytes: Buffer | string, ms = 1_500): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(target, '127.0.0.1');
    let out = '';
    const done = () => { socket.destroy(); resolve(out); };
    const timer = setTimeout(done, ms);
    socket.on('data', (chunk) => { out += chunk.toString('latin1'); });
    socket.on('close', () => { clearTimeout(timer); resolve(out); });
    socket.on('error', () => { clearTimeout(timer); resolve(out); });
    socket.write(bytes);
  });
}

describe('egress policy', () => {
  test('CONNECT targets: lower-case DNS names on 443 only', () => {
    assert.deepEqual(parseConnectTarget('api.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 });
    for (const bad of ['api.anthropic.com:80', 'api.anthropic.com', 'API.anthropic.com:443', 'api.anthropic.com.:443', 'user@api.anthropic.com:443',
      'api.anthropic.com:443/x', '1.2.3.4:443', '169.254.169.254:443', '[::1]:443', 'localhost:443', 'db:443', 'api:443', 'runtime-2:443',
      'api.anthropic.com:0443', ' api.anthropic.com:443', 'api.anthropic.com:443 ', 'api..anthropic.com:443', '-x.com:443', `${'a'.repeat(64)}.com:443`,
      'api.anthropic.com%2f:443', 'api.anthropic.com\r\n:443', '', null, 443]) {
      assert.equal(parseConnectTarget(bad), null, String(bad));
    }
  });

  test('allowed hosts follow the enabled clients; the installer host is never a slot host', () => {
    assert.deepEqual([...allowedHosts(['claude_code'])], ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com']);
    assert.deepEqual([...allowedHosts(['codex'])], [], 'Codex hosts are recorded in T6; until then nothing');
    assert.deepEqual([...allowedHosts([])], []);
    for (const hosts of Object.values(VENDOR_HOSTS)) for (const host of INSTALL_HOSTS) assert.ok(!hosts.includes(host));
  });

  test('switching a client off keeps sign-out hosts without opening the installer or other hosts', async () => {
    const vendor = createTcpServer((socket) => { socket.on('data', (data) => socket.write(data)); });
    await listen(vendor);
    const proxy = createProxyServer({ allow: allowedHosts([], { includeSignOut: true }),
      resolve: async () => ['8.8.8.8'], connect: () => connect(port(vendor), '127.0.0.1'), log: () => undefined });
    await listen(proxy);
    try {
      assert.match(await rawExchange(port(proxy), 'CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\nsign-out', 500), /200 Connection Established[\s\S]*sign-out$/);
      for (const host of ['downloads.claude.ai', 'example.com', 'api.openai.com']) {
        assert.match(await rawExchange(port(proxy), `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/, host);
      }
    } finally { proxy.closeAllConnections(); proxy.close(); vendor.close(); }
  });

  test('fuzz: a random target is accepted only in the exact shape', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABC0123456789.-:@/[]% _é';
    for (let i = 0; i < 20_000; i += 1) {
      const length = 1 + (i % 40);
      const target = Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('') + (i % 3 ? ':443' : '');
      const parsed = parseConnectTarget(target);
      if (parsed) assert.match(target, /^[a-z0-9.-]+:443$/);
    }
  });

  test('only public addresses', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700::1111', '::ffff:93.184.216.34']) assert.equal(isPublicAddress(address), true, address);
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '255.255.255.255', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
      '64:ff9b::a00:1', '2001:db8::1', 'ff02::1', 'not-an-ip', '010.0.0.1']) {
      assert.equal(isPublicAddress(address), false, address);
    }
  });

  test('the MCP route is exactly /mcp', () => {
    for (const method of ['POST', 'GET', 'DELETE']) assert.equal(isMcpRequest(method, '/mcp'), true);
    for (const [method, url] of [['PUT', '/mcp'], ['POST', '/mcp/'], ['POST', '/mcp?x=1'], ['POST', '/MCP'], ['POST', '/mcp/../api/v1/me'], ['POST', '/api/v1/me'],
      ['GET', 'http://api:8080/mcp'], ['POST', '//mcp'], ['POST', '/mcp%2f..'], ['CONNECT', 'api:8080']]) {
      assert.equal(isMcpRequest(method, url), false, `${method} ${url}`);
    }
  });
});

describe('the CONNECT proxy', () => {
  let vendor: import('node:net').Server;
  let proxy: Server;
  const resolved: Record<string, string[]> = { 'api.anthropic.com': ['93.184.216.34'], 'claude.ai': ['10.0.0.7'], 'claude.com': ['93.184.216.34', '127.0.0.1'] };
  before(async () => {
    vendor = createTcpServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk]))));
    await listen(vendor);
    proxy = createProxyServer({
      allow: allowedHosts(['claude_code']),
      resolve: async (host) => resolved[host] ?? ['93.184.216.34'],
      // The "public" address is the local vendor; a real slot reaches the vendor's real address.
      connect: () => connect(port(vendor), '127.0.0.1'),
    });
    await listen(proxy);
  });
  after(() => { proxy.close(); vendor.close(); });

  test('tunnels to an allowed vendor host and relays bytes both ways', async () => {
    const out = await rawExchange(port(proxy), 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\nhello', 500);
    assert.match(out, /^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    assert.ok(out.endsWith('echo:hello'), out);
  });

  test('refuses other hosts, non-public answers, plain proxying and oversized heads', async () => {
    for (const target of ['example.com:443', 'downloads.claude.ai:443', 'db:5432', 'api:8080', '169.254.169.254:80', 'runtime-2:7700', 'api.anthropic.com:22']) {
      assert.match(await rawExchange(port(proxy), `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), /^HTTP\/1\.1 403/, target);
    }
    assert.match(await rawExchange(port(proxy), 'CONNECT claude.ai:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/, 'resolves into the LAN');
    assert.match(await rawExchange(port(proxy), 'CONNECT claude.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/, 'one answer is loopback');
    assert.match(await rawExchange(port(proxy), 'GET http://api:8080/api/v1/me HTTP/1.1\r\nHost: api:8080\r\n\r\n'), /^HTTP\/1\.1 405/);
    assert.match(await rawExchange(port(proxy), `CONNECT api.anthropic.com:443 HTTP/1.1\r\nX-Pad: ${'a'.repeat(EGRESS_LIMITS.headerBytes + 100)}\r\n\r\n`), /^HTTP\/1\.1 (431|400)/);
  });

  test('fuzz: garbage on the proxy port is refused and the proxy keeps serving', async () => {
    for (let round = 0; round < 150; round += 1) {
      const bytes = round % 3 === 0 ? randomBytes(1 + round * 11)
        : Buffer.from(`CONNECT ${randomBytes(1 + (round % 30)).toString(round % 2 ? 'hex' : 'latin1')}:443 HTTP/1.1\r\n${round % 5 ? '' : 'Host: x\r\n'}\r\n`, 'latin1');
      const out = await rawExchange(port(proxy), bytes, 300);
      assert.ok(out === '' || /^HTTP\/1\.1 (400|403|405|431)/.test(out), `round ${round}: ${out.slice(0, 40)}`);
    }
    assert.match(await rawExchange(port(proxy), 'CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\nping', 500), /200 Connection Established[\s\S]*echo:ping$/);
  });
});

describe('the /mcp forwarder', () => {
  let api: Server;
  let forwarder: Server;
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  before(async () => {
    api = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer', 'set-cookie': 'session=leak', 'x-internal': 'yes' });
        res.end('{"error":"unauthorized"}');
      });
    });
    await listen(api);
    forwarder = createMcpForwarder({ upstream: { host: '127.0.0.1', port: port(api) } });
    await listen(forwarder);
  });
  after(() => { forwarder.close(); api.close(); });

  test('forwards /mcp with a fixed set of headers, and answers with a fixed set', async () => {
    const response = await fetch(`http://127.0.0.1:${port(forwarder)}/mcp`, { method: 'POST', body: '{"jsonrpc":"2.0"}',
      headers: { authorization: 'Bearer run.token.here', 'content-type': 'application/json', cookie: 'flux=session', 'x-forwarded-for': '10.0.0.1', 'mcp-session-id': 's1' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('x-internal'), null);
    const last = seen.at(-1)!;
    assert.equal(last.url, '/mcp');
    assert.equal(last.body, '{"jsonrpc":"2.0"}');
    assert.equal(last.headers.authorization, 'Bearer run.token.here');
    assert.equal(last.headers.cookie, undefined);
    assert.equal(last.headers['x-forwarded-for'], undefined);
    assert.equal(last.headers['mcp-session-id'], 's1');
  });

  test('refuses every other path, method, CONNECT and an oversized body without reaching the API', async () => {
    const before = seen.length;
    for (const request of ['GET /api/v1/me HTTP/1.1', 'GET /api/v1/health HTTP/1.1', 'POST /mcp/../api/v1/me HTTP/1.1', 'GET http://api:8080/api/v1/me HTTP/1.1',
      'GET http://127.0.0.1/mcp HTTP/1.1', 'PUT /mcp HTTP/1.1', 'POST /MCP HTTP/1.1', 'GET /.well-known/oauth-authorization-server HTTP/1.1', 'GET / HTTP/1.1']) {
      assert.match(await rawExchange(port(forwarder), `${request}\r\nHost: runtime-egress\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 404/, request);
    }
    assert.match(await rawExchange(port(forwarder), 'CONNECT api:8080 HTTP/1.1\r\nHost: api:8080\r\n\r\n'), /^HTTP\/1\.1 405/);
    assert.match(await rawExchange(port(forwarder), `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: ${EGRESS_LIMITS.mcpBodyBytes + 1}\r\n\r\n`), /^HTTP\/1\.1 413/);
    assert.equal(seen.length, before);
  });

  test('fuzz: garbage on the MCP port never reaches the API and the forwarder keeps serving', async () => {
    const before = seen.length;
    for (let round = 0; round < 150; round += 1) {
      const bytes = round % 2 ? randomBytes(1 + round * 9) : Buffer.from(`GET /${randomBytes(1 + (round % 50)).toString('latin1')} HTTP/1.1\r\n\r\n`, 'latin1');
      const out = await rawExchange(port(forwarder), bytes, 300);
      assert.ok(out === '' || /^HTTP\/1\.1 (400|404|405|413|431)/.test(out), `round ${round}: ${out.slice(0, 40)}`);
    }
    assert.equal(seen.length, before);
    assert.equal((await fetch(`http://127.0.0.1:${port(forwarder)}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
  });
});

describe('the per-source connection cap', () => {
  test('one source address cannot hold more than its share and gets it back on close', async () => {
    const server = createHttpServer((_req, res) => res.end('ok'));
    server.maxConnections = EGRESS_LIMITS.connections;
    capConnectionsPerSource(server, 2);
    await listen(server);
    const open: ReturnType<typeof connect>[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        const socket = connect(port(server), '127.0.0.1');
        await new Promise<void>((done) => socket.once('connect', () => done()));
        open.push(socket);
      }
      const third = connect(port(server), '127.0.0.1');
      third.on('error', () => undefined);
      await new Promise<void>((done) => third.once('close', () => done()));
      assert.ok(third.destroyed, 'the third connection from the same source is closed');
      open[0]!.destroy();
      await new Promise((done) => setTimeout(done, 50));
      assert.match(await rawExchange(port(server), 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200/);
    } finally { for (const socket of open) socket.destroy(); server.closeAllConnections(); server.close(); }
  });

  test('the proxy and the forwarder carry a per-source cap below the global one', () => {
    assert.ok(EGRESS_LIMITS.connectionsPerSource < EGRESS_LIMITS.connections);
  });
});

describe('the per-source cap on the real listeners', () => {
  // Opens the cap's worth of idle connections from this one address, then one more; true when the server closes that one.
  async function closesTheExtraConnection(target: number): Promise<boolean> {
    const open: ReturnType<typeof connect>[] = [];
    try {
      for (let i = 0; i < EGRESS_LIMITS.connectionsPerSource; i += 1) {
        const socket = connect(target, '127.0.0.1');
        socket.on('error', () => undefined);
        await new Promise<void>((done) => socket.once('connect', () => done()));
        open.push(socket);
      }
      const extra = connect(target, '127.0.0.1');
      extra.on('error', () => undefined);
      return await new Promise<boolean>((done) => {
        const timer = setTimeout(() => done(false), 2_000);
        extra.once('close', () => { clearTimeout(timer); done(true); });
      });
    } finally {
      for (const socket of open) socket.destroy();
    }
  }

  test('the proxy listener refuses the connection past the cap', async () => {
    const proxy = createProxyServer({ allow: new Set() });
    await listen(proxy);
    try {
      assert.equal(await closesTheExtraConnection(port(proxy)), true);
    } finally { proxy.closeAllConnections(); proxy.close(); }
  });

  test('the /mcp forwarder listener refuses the connection past the cap', async () => {
    const forwarder = createMcpForwarder({ upstream: { host: '127.0.0.1', port: 9 } });
    await listen(forwarder);
    try {
      assert.equal(await closesTheExtraConnection(port(forwarder)), true);
    } finally { forwarder.closeAllConnections(); forwarder.close(); }
  });
});

describe('the global cap on the real listeners', () => {
  async function checkGlobalCap(server: Server) {
    const open: ReturnType<typeof connect>[] = [];
    let extra: ReturnType<typeof connect> | undefined;
    await listen(server);
    try {
      // Nine loopback sources keep every source below its own cap, so only the
      // listener's global bound can refuse connection 257.
      for (let index = 0; index < EGRESS_LIMITS.connections; index++) {
        const socket = connect({ port: port(server), host: '127.0.0.1',
          localAddress: `127.0.0.${2 + Math.floor(index / EGRESS_LIMITS.connectionsPerSource)}` });
        open.push(socket);
        await new Promise<void>((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
      }
      assert.equal(await new Promise<number>((done, reject) => server.getConnections((error, count) => error ? reject(error) : done(count))),
        EGRESS_LIMITS.connections, 'all allowed connections are held by the actual listener');
      extra = connect({ port: port(server), host: '127.0.0.1', localAddress: '127.0.0.10' });
      extra.on('error', () => undefined);
      const closed = await new Promise<boolean>((done) => {
        const timer = setTimeout(() => done(false), 2_000);
        extra!.once('close', () => { clearTimeout(timer); done(true); });
      });
      assert.equal(closed, true, 'the global bound closes the extra connection from an unsaturated source');
      open[0]!.destroy();
      await new Promise((done) => setTimeout(done, 50));
      assert.match(await rawExchange(port(server), 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
        /^HTTP\/1\.1 (404|405)/, 'closing an allowed connection makes capacity available again');
    } finally {
      extra?.destroy(); for (const socket of open) socket.destroy(); server.closeAllConnections(); server.close();
    }
  }

  test('the proxy listener enforces the global bound across independent sources', { timeout: 15_000 }, async () => {
    await checkGlobalCap(createProxyServer({ allow: new Set() }));
  });

  test('the /mcp forwarder enforces the global bound across independent sources', { timeout: 15_000 }, async () => {
    await checkGlobalCap(createMcpForwarder({ upstream: { host: '127.0.0.1', port: 9 } }));
  });
});
