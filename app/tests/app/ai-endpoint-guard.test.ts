import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { checkEndpoint, classifyAddress, EndpointRefusedError, guardedFetch, parsePrivateTargets, PUBLIC_ONLY, ResponseTooLargeError,
  type Resolver } from '../../packages/agent-runtime/src/index.js';
import { baseUrlSyntaxProblem, boundedInputTokens, conservativeTokenEstimate, validAiKey, validModelId } from '@flux/core';

// The SSRF guard of owner AI endpoints (F-020 PROV-4) and the pure connection rules. DNS answers
// come from a scripted resolver; redirects, size and time bounds use local HTTP servers that this
// test's policy allows by address. Nothing here calls a provider.

const resolver = (answers: Record<string, string[]>): Resolver => async (host) => {
  const list = answers[host];
  if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const dns = resolver({
  'llm.example.org': ['93.184.216.34'], 'v6.example.org': ['2606:4700::6810:84e5'],
  'ollama': ['172.18.0.5'], 'gpu.lan': ['10.1.2.3'], 'mixed.example.org': ['93.184.216.34', '10.0.0.8'],
  'metadata.example.org': ['169.254.169.254'], 'cgnat.example.org': ['100.64.1.1'], 'ula.example.org': ['fd12:3456::1'],
  'linklocal.example.org': ['fe80::1'], 'mapped.example.org': ['::ffff:127.0.0.1'], 'mappedhex.example.org': ['::ffff:7f00:1'],
  'localhost': ['127.0.0.1'],
});

describe('endpoint policy (PROV-4)', () => {
  test('address classes: private, loopback, link-local, ULA, CGNAT, mapped and metadata are not public', () => {
    for (const address of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '0.0.0.0', '169.254.1.1', '100.64.0.1', '198.18.0.1',
      '224.0.0.1', '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1'])
      assert.equal(classifyAddress(address), 'private', address);
    for (const address of ['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254', '::ffff:169.254.169.254'])
      assert.equal(classifyAddress(address), 'metadata', address);
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700::6810:84e5', '::ffff:93.184.216.34'])
      assert.equal(classifyAddress(address), 'public', address);
  });

  test('public HTTPS only by default; the host is resolved and every address checked', async () => {
    assert.equal(await checkEndpoint('https://llm.example.org/v1', PUBLIC_ONLY, dns), null);
    assert.equal(await checkEndpoint('https://v6.example.org/v1', PUBLIC_ONLY, dns), null);
    assert.equal(await checkEndpoint('https://93.184.216.34/v1', PUBLIC_ONLY, dns), null);
    const refusals: [string, RegExp][] = [
      ['http://llm.example.org/v1', /plain http/],
      ['https://gpu.lan/v1', /private, loopback or link-local/],
      ['https://mixed.example.org/v1', /private/],
      ['https://cgnat.example.org/v1', /private/],
      ['https://ula.example.org/v1', /private/],
      ['https://linklocal.example.org/v1', /private/],
      ['https://mapped.example.org/v1', /private/],
      ['https://mappedhex.example.org/v1', /private/],
      ['https://metadata.example.org/latest', /metadata/],
      ['https://127.0.0.1/v1', /private/],
      ['https://[::1]/v1', /private/],
      ['https://10.1.2.3/v1', /private/],
      ['https://169.254.169.254/', /metadata/],
      ['https://localhost/v1', /private/],
      ['https://api.localhost/v1', /private/],
      ['https://user:secret@llm.example.org/v1', /credentials/],
      ['ftp://llm.example.org/v1', /only https/],
      ['https://unknown.example.org/v1', /could not be resolved/],
    ];
    for (const [url, reason] of refusals) assert.match(await checkEndpoint(url, PUBLIC_ONLY, dns) ?? 'allowed', reason, url);
  });

  test('only the operator allowlist opens private targets, by host or by range; metadata stays closed', async () => {
    const policy = parsePrivateTargets('ollama, 10.0.0.0/8 fd12::/16,localhost');
    assert.equal(await checkEndpoint('http://ollama:11434/v1', policy, dns), null, 'an allowlisted host, plain http on the private network');
    assert.equal(await checkEndpoint('http://gpu.lan:8000/v1', policy, dns), null, 'a host inside an allowlisted range');
    assert.equal(await checkEndpoint('https://ula.example.org/v1', policy, dns), null);
    assert.equal(await checkEndpoint('http://localhost:1234/v1', policy, dns), null);
    assert.match(await checkEndpoint('https://192.168.1.1/v1', policy, dns) ?? '', /not allowed/);
    assert.match(await checkEndpoint('http://llm.example.org/v1', policy, dns) ?? '', /plain http/, 'public targets still need https');
    const open = parsePrivateTargets('169.254.0.0/16,metadata.example.org');
    assert.match(await checkEndpoint('https://metadata.example.org/', open, dns) ?? '', /metadata/);
    assert.match(await checkEndpoint('https://169.254.169.254/', open, dns) ?? '', /metadata/);
    for (const bad of ['10.0.0.0/33', 'http://ollama', '*', 'ollama:11434', 'fd00::/129'])
      assert.throws(() => parsePrivateTargets(bad), /FLUX_AI_PRIVATE_TARGETS/, bad);
  });

  test('DNS rebinding: a host checked when saved is checked again by the connection that would use it', async () => {
    let calls = 0;
    const rebinding: Resolver = async () => [{ address: ++calls === 1 ? '93.184.216.34' : '10.0.0.9', family: 4 }];
    assert.equal(await checkEndpoint('https://rebind.example.org/v1', PUBLIC_ONLY, rebinding), null, 'public when saved');
    await assert.rejects(guardedFetch(PUBLIC_ONLY, { timeoutMs: 2_000, maxResponseBytes: 1_000 }, rebinding)('https://rebind.example.org/v1/models'),
      (error: unknown) => error instanceof EndpointRefusedError && /private/.test(error.reason));
    assert.equal(calls, 2);
  });
});

describe('guarded transport: no redirects, bounded size and time', () => {
  let server: Server;
  let origin = '';
  let targetHits = 0;
  const local = parsePrivateTargets('127.0.0.1');
  before(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: `${origin}/target` }); return response.end(); }
      if (request.url === '/target') { targetHits++; return response.end('reached'); }
      if (request.url === '/declared') { response.writeHead(200, { 'content-length': '5000' }); return response.end('x'.repeat(5000)); }
      if (request.url === '/streamed') { response.writeHead(200); response.write('x'.repeat(3000)); return response.end('x'.repeat(3000)); }
      if (request.url === '/hang') return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

  test('a redirect is returned as it is and never followed', async () => {
    const response = await guardedFetch(local, { timeoutMs: 2_000, maxResponseBytes: 10_000 })(`${origin}/redirect`);
    assert.equal(response.status, 302);
    assert.equal(targetHits, 0);
  });

  test('a response over the size bound is dropped, declared or streamed', async () => {
    const fetch = guardedFetch(local, { timeoutMs: 2_000, maxResponseBytes: 1_000 });
    await assert.rejects(fetch(`${origin}/declared`), ResponseTooLargeError);
    await assert.rejects(fetch(`${origin}/streamed`), ResponseTooLargeError);
    assert.deepEqual(await (await fetch(`${origin}/ok`)).json(), { ok: true });
  });

  test('a response over the time bound is a timeout; a caller abort is an abort', async () => {
    await assert.rejects(guardedFetch(local, { timeoutMs: 200, maxResponseBytes: 1_000 })(`${origin}/hang`),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError');
    const controller = new AbortController();
    const pending = guardedFetch(local, { timeoutMs: 5_000, maxResponseBytes: 1_000 })(`${origin}/hang`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  });

  test('without the allowlist the same loopback server is refused before connecting', async () => {
    await assert.rejects(guardedFetch(PUBLIC_ONLY)(`${origin}/ok`), EndpointRefusedError);
  });
});

describe('connection rules (F-020 PROV-1/PROV-3)', () => {
  test('keys are checked in each provider\'s own format; an admin key is refused', () => {
    assert.ok(validAiKey('anthropic', 'sk-ant-api03-abcdefghijklmnop1234'));
    assert.ok(!validAiKey('anthropic', 'sk-proj-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(validAiKey('openai', 'sk-proj-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(validAiKey('openai', 'sk-svcacct-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(!validAiKey('openai', 'sk-admin-abcdefghijklmnopqrstuvwxyz'), 'no shared administrator key');
    assert.ok(!validAiKey('openai', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(validAiKey('openrouter', 'sk-or-v1-0123456789abcdef0123456789abcdef'));
    assert.ok(!validAiKey('openrouter', 'sk-proj-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(validAiKey('gemini', `AIza${'A1b2C3d4E5'.repeat(3)}12345`));
    assert.ok(!validAiKey('gemini', 'sk-proj-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(validAiKey('openai_compatible', 'no-key-needed'));
    assert.ok(!validAiKey('openai_compatible', 'short'));
    assert.ok(!validAiKey('openai_compatible', 'has a space in it'));
  });

  test('model ids are bounded free text; provider-hosted tool variants are refused', () => {
    for (const model of ['claude-sonnet-5', 'gpt-model', 'llama3.1:8b', 'meta-llama/Llama-3.1-8B-Instruct', 'vendor/model:free', 'models/gemini-x'])
      assert.ok(validModelId('openrouter', model), model);
    for (const model of ['', 'two words', '-leading', 'x'.repeat(201), 'a"b', 'vendor/model:online']) assert.ok(!validModelId('openrouter', model), model);
    assert.ok(validModelId('openai_compatible', 'vendor/model:online'), 'only OpenRouter gives :online a hosted search');
  });

  test('base URL syntax: absolute http(s) without credentials, query or fragment', () => {
    assert.equal(baseUrlSyntaxProblem('https://llm.example.org/v1'), null);
    assert.equal(baseUrlSyntaxProblem('http://ollama:11434/v1'), null);
    for (const value of ['', 'llm.example.org/v1', 'https://user:pw@llm.example.org', 'https://llm.example.org/v1?x=1', 'https://llm.example.org/#a',
      'file:///etc/passwd', 'https://llm.example.org/ v1', `https://x.org/${'a'.repeat(2048)}`])
      assert.notEqual(baseUrlSyntaxProblem(value), null, value);
  });

  test('the conservative estimate bounds every provider the same way; a count may only raise it', () => {
    const english = 'The camera fails below five lux in the low-light test. '.repeat(40);
    const polish = 'Kamera nie działa poniżej pięciu luksów w teście przy słabym świetle. '.repeat(40);
    const cjk = '摄像头在低光测试中低于五勒克斯时失效。'.repeat(40);
    for (const text of [english, polish, cjk]) {
      const estimate = conservativeTokenEstimate([text]);
      assert.ok(estimate >= Buffer.byteLength(text) / 2, 'at least one token per two UTF-8 bytes');
      // A deliberately generous upper bound of real tokenizers: about one token per 3 characters of prose, one per CJK character.
      assert.ok(estimate >= Math.ceil(text.length / (text === cjk ? 1 : 3)), 'above common tokenizer counts');
    }
    assert.ok(conservativeTokenEstimate(['a', 'b']) > conservativeTokenEstimate(['ab']), 'each part has framing');
    assert.equal(boundedInputTokens(500, null), 500);
    assert.equal(boundedInputTokens(500, 300), 500, 'a lower count never loosens the bound');
    assert.equal(boundedInputTokens(500, 900), 900, 'a higher count tightens it');
  });
});
