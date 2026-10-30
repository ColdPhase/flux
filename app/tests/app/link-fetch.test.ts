import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { messageLinkUrls } from '@flux/contracts';
import { parsePagePreview, plainText } from '../../apps/server/src/link-previews/html.js';
import { caresResolver } from '../../apps/server/src/link-previews/resolver.js';
import { fetchPage, FETCH_LIMITS, literalRefusal, PRODUCTION_RULES, USER_AGENT, type FetchRules } from '../../apps/server/src/link-previews/safe-fetch.js';
import { linkPreviews } from '../../apps/server/src/link-previews/service.js';

// The fetcher behind link cards (#469) with real sockets and scripted DNS: the address check, redirects, the single resolution,
// size and time bounds, the request's headers, and the parser of what a page says about itself. No network beyond this process:
// names answer with 127.0.0.2 (which this suite classes as public, to be allowed) or 127.0.0.1 (loopback: the production class).

const requests: { host: string | undefined; path: string; local: string | undefined; headers: http.IncomingHttpHeaders }[] = [];
let connections = 0;
let port = 0;
const send = (response: http.ServerResponse, body: string | Buffer, type = 'text/html', status = 200) => { response.writeHead(status, { 'content-type': type }); response.end(body); };
const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;

const server = http.createServer((request, response) => {
  const path = request.url ?? '/';
  requests.push({ host: request.headers.host, path, local: request.socket.localAddress, headers: request.headers });
  if (path === '/ok') return send(response, page('<title>Fine</title><meta name="description" content="All well.">'));
  if (path === '/ok-too') return send(response, page('<title>Too</title>'));
  if (path === '/latin2') return send(response, Buffer.concat([Buffer.from('<html><head><title>'), Buffer.from([0xb3, 0xf3, 0x64, 0xbc]), Buffer.from('</title></head>')]), 'text/html; charset=iso-8859-2');
  if (path === '/png') return send(response, 'png', 'image/png');
  if (path === '/boom') return send(response, 'x', 'text/html', 500);
  if (path === '/stall') return void response.writeHead(200, { 'content-type': 'text/html' });
  if (path === '/drip') {
    response.writeHead(200, { 'content-type': 'text/html' });
    const timer = setInterval(() => response.write('<!-- -->'), 20);
    response.on('close', () => clearInterval(timer));
    return;
  }
  if (path === '/huge') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<html><head><title>Start</title>');
    let sent = 0;
    const pump = () => { while (sent < 4_000_000) { sent += 64 * 1024; if (!response.write(' '.repeat(64 * 1024))) return void response.once('drain', pump); } response.end(); };
    response.on('close', () => { hugeAborted = !response.writableFinished; });
    return pump();
  }
  if (path.startsWith('/r/')) {
    const left = Number(path.slice(3));
    response.writeHead(left > 0 ? 302 : 200, left > 0 ? { location: `/r/${left - 1}` } : { 'content-type': 'text/html' });
    return response.end(left > 0 ? undefined : page('<title>Arrived</title>'));
  }
  if (path.startsWith('/to/')) {
    const target = decodeURIComponent(path.slice(4));
    response.writeHead(302, { location: target.replace('{PORT}', String(port)) });
    return response.end();
  }
  send(response, 'missing', 'text/plain', 404);
});
let hugeAborted = false;
before(async () => { await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve)); port = (server.address() as AddressInfo).port; server.on('connection', () => { connections++; }); });
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

const resolved: string[] = [];
const answers: Record<string, string[]> = {
  'ok.test': ['127.0.0.2'], 'internal.test': ['127.0.0.1'], 'mixed.test': ['127.0.0.2', '127.0.0.1'], 'meta.test': ['169.254.169.254'],
  'mapped.test': ['::ffff:127.0.0.1'],
};
let rebind = 0;
const rules = (limits: Partial<FetchRules['limits']> = {}, overrides: Partial<FetchRules> = {}): FetchRules => ({
  resolve: async (host) => {
    resolved.push(host);
    // A name that answers a public address once and a private one afterwards (DNS rebinding).
    const list = host === 'rebind.test' ? [rebind++ === 0 ? '127.0.0.2' : '127.0.0.1'] : answers[host];
    if (!list) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
  classify: (address) => (address === '127.0.0.2' ? 'public' : PRODUCTION_RULES.classify(address)),
  port: (url) => Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
  limits: { ...FETCH_LIMITS, ...limits },
  ...overrides,
});
const at = (host: string, path: string) => `http://${host}:${port}${path}`;
const reached = () => requests.length;

describe('the address check', () => {
  test('addresses that are not public, in every notation', () => {
    const blocked = ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '127.255.255.254', '0.0.0.0', '169.254.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::', '::8.8.8.8'];
    for (const address of blocked) assert.notEqual(PRODUCTION_RULES.classify(address), 'public', address);
    for (const address of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700::6810:84e5', '::ffff:93.184.216.34']) assert.equal(PRODUCTION_RULES.classify(address), 'public', address);
  });

  test('addresses refused before any lookup: scheme, credentials, port, local names and IP literals', () => {
    const refused = ['ftp://example.org/', 'file:///etc/passwd', 'gopher://example.org/', 'javascript:alert(1)', 'http://user@example.org/', 'http://user:pw@example.org/', 'http://example.org:8080/', 'https://example.org:444/', 'http://example.org:81/',
      'http://localhost/', 'http://LOCALHOST./', 'http://app.localhost/', 'http://printer.local/', 'http://wiki.internal/', 'http://router.lan/', 'http://x.home.arpa/', 'http://x.localdomain/',
      'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/',
      'http://169.254.169.254/latest/', 'http://[fd00:ec2::254]/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://100.64.0.1/', 'http://192.168.0.1/', 'http://10.1.2.3/', 'http://[fe80::1]/', 'http://[::]/'];
    for (const address of refused) assert.equal(literalRefusal(new URL(address), PRODUCTION_RULES), true, address);
    for (const address of ['http://example.org/', 'https://example.org/a?b=1#c', 'http://example.org:80/', 'https://example.org:443/', 'http://93.184.216.34/', 'https://[2606:4700::6810:84e5]/'])
      assert.equal(literalRefusal(new URL(address), PRODUCTION_RULES), false, address);
  });

  test('a name that resolves to a private address, alone or among public ones, is refused before any connection', async () => {
    const before = connections;
    for (const host of ['internal.test', 'mixed.test', 'meta.test', 'mapped.test']) assert.deepEqual(await fetchPage(at(host, '/ok'), rules()), { ok: false, reason: 'blocked' }, host);
    assert.deepEqual(await fetchPage(at('nowhere.test', '/ok'), rules()), { ok: false, reason: 'unreachable' });
    assert.equal(connections, before, 'no socket was opened');
    assert.equal(requests.filter((request) => request.host?.startsWith('internal.test') || request.host?.startsWith('mixed.test')).length, 0);
  });

  test('the host is resolved once and the socket connects to that very answer (DNS rebinding)', async () => {
    resolved.length = 0; rebind = 0;
    const result = await fetchPage(at('rebind.test', '/ok'), rules());
    assert.equal(result.ok, true);
    assert.deepEqual(resolved, ['rebind.test'], 'one resolution');
    const request = requests.at(-1)!;
    assert.equal(request.host, `rebind.test:${port}`);
    assert.equal(request.local, '127.0.0.2', 'connected to the checked address, not the one a second lookup would give');
    // The next fetch's lookup answers the private address: refused, no connection.
    const sockets = connections;
    assert.deepEqual(await fetchPage(at('rebind.test', '/ok'), rules()), { ok: false, reason: 'blocked' });
    assert.equal(connections, sockets);
  });

  test('the default-port rule of production: another port is refused without a connection', async () => {
    const sockets = connections;
    const production: FetchRules = { ...rules(), port: PRODUCTION_RULES.port };
    assert.deepEqual(await fetchPage(at('ok.test', '/ok'), production), { ok: false, reason: 'blocked' });
    assert.equal(connections, sockets);
  });
});

// A name server of our own on loopback: it answers from a zone, or (hung) never answers.
function ipv6Bytes(address: string): Buffer {
  const [head, tail = ''] = address.split('::');
  const groups = (text: string) => (text ? text.split(':').map((group) => parseInt(group, 16)) : []);
  const fill = address.includes('::') ? 8 - groups(head!).length - groups(tail).length : 0;
  return Buffer.from([...groups(head!), ...Array<number>(fill).fill(0), ...groups(tail)].flatMap((group) => [group >> 8, group & 255]));
}
async function nameServer(zone: Record<string, { a?: string[]; aaaa?: string[] }> | null) {
  const socket = dgram.createSocket('udp4');
  const asked: string[] = [];
  socket.on('message', (query, remote) => {
    if (!zone) return;
    let end = 12;
    const labels: string[] = [];
    while (query[end] !== 0) { labels.push(query.subarray(end + 1, end + 1 + query[end]!).toString()); end += query[end]! + 1; }
    const type = query.readUInt16BE(end + 1);
    const name = labels.join('.').toLowerCase();
    asked.push(`${type === 28 ? 'AAAA' : 'A'} ${name}`);
    const entry = zone[name];
    const addresses = (type === 28 ? entry?.aaaa : entry?.a) ?? [];
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180 | (entry ? 0 : 3), 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(addresses.length, 6);
    const answers = addresses.map((address) => {
      const data = type === 28 ? ipv6Bytes(address) : Buffer.from(address.split('.').map(Number));
      const record = Buffer.alloc(12);
      record.writeUInt16BE(0xc00c, 0); record.writeUInt16BE(type, 2); record.writeUInt16BE(1, 4); record.writeUInt32BE(60, 6); record.writeUInt16BE(data.length, 10);
      return Buffer.concat([record, data]);
    });
    socket.send(Buffer.concat([header, query.subarray(12, end + 5), ...answers]), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { server: `127.0.0.1:${socket.address().port}`, asked, close: () => socket.close() };
}

describe('the resolver (c-ares, off the shared thread pool)', () => {
  test('it asks the name server for both families; every answer is classified and the socket connects to the checked one', async () => {
    const dnsServer = await nameServer({ 'ok.test': { a: ['127.0.0.2'] }, 'loop.test': { a: ['127.0.0.1'] }, 'six.test': { aaaa: ['::1'] }, 'mixed.test': { a: ['127.0.0.2'], aaaa: ['::1'] }, 'meta.test': { a: ['169.254.169.254'] } });
    after(() => dnsServer.close());
    const viaDns = rules({}, { resolve: caresResolver({ servers: [dnsServer.server] }) });
    const sockets = connections;
    const ok = await fetchPage(at('ok.test', '/ok'), viaDns);
    assert.equal(ok.ok, true);
    assert.equal(requests.at(-1)!.local, '127.0.0.2', 'connected to the answer that was checked');
    assert.deepEqual(dnsServer.asked.filter((question) => question.endsWith('ok.test')).sort(), ['A ok.test', 'AAAA ok.test']);
    const during = connections;
    for (const host of ['loop.test', 'six.test', 'mixed.test', 'meta.test'])
      assert.deepEqual(await fetchPage(at(host, '/ok'), viaDns), { ok: false, reason: 'blocked' }, host);
    assert.equal(connections, during, 'a loopback, IPv6, metadata or mixed answer opened no socket');
    assert.deepEqual(await fetchPage(at('gone.test', '/ok'), viaDns), { ok: false, reason: 'unreachable' });
    assert.ok(connections - sockets >= 1);
  });

  test('names that never answer take no thread of the shared pool: another lookup is not delayed, and the fetches end', async () => {
    const hung = await nameServer(null);
    after(() => hung.close());
    const viaHung = { ...rules({}, { resolve: caresResolver({ servers: [hung.server], timeoutMs: 500 }) }), port: PRODUCTION_RULES.port };
    const started = Date.now();
    const fetches = Array.from({ length: 24 }, (_, i) => fetchPage(`http://burst-${i}.test/`, viaHung));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lookupStarted = Date.now();
    await new Promise<void>((resolve, reject) => dns.lookup('localhost', (error) => (error ? reject(error) : resolve())));
    const took = Date.now() - lookupStarted;
    assert.ok(took < 250, `dns.lookup('localhost') waited ${took} ms behind hung lookups`);
    const results = await Promise.all(fetches);
    assert.ok(results.every((result) => !result.ok && result.reason === 'unreachable'), JSON.stringify(results));
    assert.ok(Date.now() - started < FETCH_LIMITS.totalMs + 500, `took ${Date.now() - started} ms`);
  });

  test('queries in flight are bounded', async () => {
    const hung = await nameServer(null);
    after(() => hung.close());
    const limited = caresResolver({ servers: [hung.server], timeoutMs: 300, maxPending: 2 });
    const outcomes = await Promise.allSettled([limited('a.test'), limited('b.test'), limited('c.test')]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code), ['ENOTFOUND', 'ENOTFOUND', 'EBUSY']);
    await assert.rejects(limited('d.test'), { code: 'ENOTFOUND' }, 'the slots are free again once the queries settle');
  });
});

describe('redirects', () => {
  test('up to three are followed, a fourth is not', async () => {
    assert.deepEqual(await fetchPage(at('ok.test', '/r/3'), rules()), { ok: true, url: at('ok.test', '/r/0'), html: page('<title>Arrived</title>') });
    assert.deepEqual(await fetchPage(at('ok.test', '/r/4'), rules()), { ok: false, reason: 'redirects' });
  });

  test('every hop is judged: a redirect to a private name, mixed answers, metadata, a non-http scheme or credentials is refused and never requested', async () => {
    const before = reached();
    const sockets = connections;
    const targets = [at('internal.test', '/ok'), at('mixed.test', '/ok'), at('meta.test', '/ok'), 'http://127.0.0.1:{PORT}/ok', 'http://[::1]:{PORT}/ok', 'http://localhost:{PORT}/ok',
      'ftp://ok.test/ok', 'file:///etc/passwd', `http://user:pw@ok.test:{PORT}/ok`, 'http://169.254.169.254/'];
    for (const target of targets) {
      const result = await fetchPage(at('ok.test', `/to/${encodeURIComponent(target)}`), rules());
      assert.deepEqual(result, { ok: false, reason: 'blocked' }, target);
    }
    // Only the redirecting requests reached the server; no target was requested, and the only new sockets are theirs.
    assert.equal(reached() - before, targets.length);
    assert.ok(requests.slice(before).every((request) => request.path.startsWith('/to/')));
    assert.equal(connections - sockets, targets.length);
  });

  test('a redirect to a public name is followed with a fresh request, carrying nothing of the first', async () => {
    const result = await fetchPage(at('ok.test', `/to/${encodeURIComponent(at('ok.test', '/ok-too'))}`), rules());
    assert.equal(result.ok && parsePagePreview(result.html).title, 'Too');
  });
});

describe('the request and its bounds', () => {
  test('a fixed User-Agent, no cookie, referer, credentials, language or compression', async () => {
    await fetchPage(at('ok.test', '/ok'), rules());
    const { headers } = requests.at(-1)!;
    assert.equal(headers['user-agent'], USER_AGENT);
    for (const name of ['cookie', 'referer', 'authorization', 'accept-language', 'origin', 'x-forwarded-for']) assert.equal(headers[name], undefined, name);
    assert.equal(headers['accept-encoding'], 'identity');
    assert.equal(headers.connection, 'close');
  });

  test('only text/html with a 200 is read', async () => {
    assert.deepEqual(await fetchPage(at('ok.test', '/png'), rules()), { ok: false, reason: 'type' });
    assert.deepEqual(await fetchPage(at('ok.test', '/boom'), rules()), { ok: false, reason: 'status' });
    assert.deepEqual(await fetchPage(at('ok.test', '/missing'), rules()), { ok: false, reason: 'status' });
  });

  test('the page is decoded with its declared charset', async () => {
    const result = await fetchPage(at('ok.test', '/latin2'), rules());
    assert.equal(result.ok && parsePagePreview(result.html).title, 'łódź');
  });

  test('a server that never answers, and one that drips forever, are given up on at the total limit', async () => {
    for (const path of ['/stall', '/drip']) {
      const started = Date.now();
      assert.deepEqual(await fetchPage(at('ok.test', path), rules({ totalMs: 500 })), { ok: false, reason: 'timeout' }, path);
      assert.ok(Date.now() - started < 1_500, `${path} took ${Date.now() - started} ms`);
    }
  });

  test('at most 256 KiB are read, and the rest is never downloaded', async () => {
    hugeAborted = false;
    const result = await fetchPage(at('ok.test', '/huge'), rules());
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.html.length <= FETCH_LIMITS.maxBytes && result.html.includes('<title>Start</title>'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(hugeAborted, true, 'the client dropped the connection before the 4 MB were sent');
  });
});

describe('what a page says about itself', () => {
  test('title, og:title, og:description and the description meta; Open Graph wins', () => {
    assert.deepEqual(parsePagePreview(page('<title>T</title><meta name="description" content="D">')), { title: 'T', description: 'D' });
    assert.deepEqual(parsePagePreview(page('<title>T</title><meta property="og:title" content="OT"><meta property="og:description" content="OD"><meta name="description" content="D">')), { title: 'OT', description: 'OD' });
    assert.deepEqual(parsePagePreview(page('<META NAME=Description CONTENT=\'single "quoted"\'><TITLE>Upper</TITLE>')), { title: 'Upper', description: 'single "quoted"' });
    assert.deepEqual(parsePagePreview(page('<meta content="before" name="description">')), { title: null, description: 'before' });
    assert.deepEqual(parsePagePreview(page('<meta property="og:title" content="a > b">')), { title: 'a > b', description: null });
  });

  test('nothing else is read: not a script, a style, a comment, a template, the body or other tags', () => {
    const html = '<html><head><!-- <title>comment</title> --><script>document.write("<title>script</title>")</script><style>title{}</style><template><title>tpl</title></template>'
      + '<meta property="twitter:title" content="no"><meta name="keywords" content="no"><link rel="canonical" href="http://x/"><meta property="og:image" content="http://x/i.png"></head><body><title>body</title><meta name="description" content="body"></body></html>';
    assert.deepEqual(parsePagePreview(html), { title: null, description: null });
  });

  test('values are plain text: entities decoded once, markup dropped, white space collapsed, controls and bidi overrides removed, length capped', () => {
    const RLO = String.fromCodePoint(0x202e); const NUL = String.fromCodePoint(0);
    assert.equal(plainText('Tom &amp; Jerry &#8212; &#x1F600; &nbsp;&lt;script&gt;alert(1)&lt;/script&gt;ok', 100), 'Tom & Jerry — 😀 alert(1) ok');
    assert.equal(plainText(`a${RLO}b${NUL}c\n\t d`, 100), 'a b c d');
    assert.equal(plainText('&amp;lt;b&amp;gt;', 100), '&lt;b&gt;', 'decoded once');
    assert.equal(plainText('   ', 10), null);
    assert.equal(plainText('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
    assert.equal(plainText('&#0; &#xD800; &#x110000;', 10), null);
    assert.equal(parsePagePreview(page(`<title>${'é'.repeat(500)}</title>`)).title!.length, 200);
  });

  test('a hostile page cannot make parsing slow', () => {
    const size = FETCH_LIMITS.maxBytes;
    for (const unit of ['<meta "', '<title ', '<script ', '<!-- ', '<a', '<meta content="', "<meta content='", '<title>', '<meta name=description content=']) {
      const started = Date.now();
      parsePagePreview(unit.repeat(Math.ceil(size / unit.length)));
      assert.ok(Date.now() - started < 1_000, `${JSON.stringify(unit)} took ${Date.now() - started} ms`);
    }
    const started = Date.now();
    plainText('<a '.repeat(100_000), 300);
    assert.ok(Date.now() - started < 200);
  });
});

describe('addresses taken from a message', () => {
  test('the first three distinct http(s) addresses, without trailing punctuation', () => {
    assert.deepEqual(messageLinkUrls('See (https://a.example/x), http://b.example/y. Again https://a.example/x and ftp://c.example/z then http://d.example http://e.example'),
      ['https://a.example/x', 'http://b.example/y', 'http://d.example']);
    assert.deepEqual(messageLinkUrls(`${'https://long.example/'}${'a'.repeat(2100)}`), [], 'longer than 2048 characters');
    assert.deepEqual(messageLinkUrls('no addresses, just example.org and mailto:a@b.c'), []);
  });
});

describe('the cache and the rate', () => {
  test('a page is fetched once while it is believed, a miss is remembered for less, and the rate counts fetches, not hits', async () => {
    let clock = 1_000_000;
    let fetched = 0;
    const service = linkPreviews({ now: () => clock, fetch: async (address) => {
      fetched++;
      return address.endsWith('/gone') ? { ok: false, reason: 'status' } : { ok: true, url: address, html: page('<title>Cached</title>') };
    } });
    for (let i = 0; i < 5; i++) assert.equal((await service.cards('u1', ['http://a.example/page#frag'])).cards.length, 1);
    assert.equal(fetched, 1, 'the fragment is not part of the key');
    await service.cards('u1', ['http://a.example/gone']); await service.cards('u1', ['http://a.example/gone']);
    assert.equal(fetched, 2, 'a miss is remembered');
    clock += 16 * 60_000;
    await service.cards('u1', ['http://a.example/gone']);
    assert.equal(fetched, 3, 'a miss expires after 15 minutes');
    await service.cards('u1', ['http://a.example/page']);
    assert.equal(fetched, 3, 'a found page is believed for hours');
    clock += 7 * 60 * 60_000;
    await service.cards('u1', ['http://a.example/page']);
    assert.equal(fetched, 4);
  });

  test('concurrent readers share one fetch; a person over the rate gets busy; another person does not', async () => {
    let fetched = 0;
    const service = linkPreviews({ fetch: async (address) => { fetched++; await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true, url: address, html: page('<title>Slow</title>') }; } });
    await Promise.all([service.cards('u1', ['http://s.example/1']), service.cards('u2', ['http://s.example/1']), service.cards('u3', ['http://s.example/1'])]);
    assert.equal(fetched, 1);
    // Addresses refused from the address alone use no network and spend no rate.
    for (let i = 0; i < 30; i++) assert.deepEqual(await service.cards('u8', [`http://127.0.0.1/${i}`, 'http://x.example:8080/', 'ftp://x.example/']), { busy: false, cards: [] });
    assert.equal(fetched, 1);
    const busy: boolean[] = [];
    for (let i = 0; i < 30; i++) busy.push((await service.cards('u9', [`http://s.example/rate/${i}`])).busy);
    assert.equal(busy.filter((flag) => !flag).length, 20);
    assert.equal((await service.cards('u10', ['http://s.example/rate/0'])).busy, false);
    assert.equal((await service.cards('u10', ['http://s.example/rate/new'])).busy, false);
  });
});
