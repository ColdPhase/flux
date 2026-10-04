import assert from 'node:assert/strict';
import { once } from 'node:events';
import https from 'node:https';
import { createServer, type AddressInfo, type LookupFunction } from 'node:net';
import { test } from 'node:test';
import type { LookupAddress } from 'node:dns';
import { createPushAgent } from '../../apps/worker/src/push/deliver.js';
import { createPublicOnlyLookup, type PublicLookupResolver } from '../../apps/worker/src/push/public-lookup.js';

const config = { status: 'available' as const, publicKey: 'unused-agent-key', privateKey: 'unused-agent-key',
  subject: 'mailto:lookup@example.test', allowPrivateNetwork: false };
const ipv4 = (address: string): LookupAddress => ({ address, family: 4 });
const ipv6 = (address: string): LookupAddress => ({ address, family: 6 });
function resolver(answers: LookupAddress[], error: NodeJS.ErrnoException | null = null): PublicLookupResolver {
  return (_hostname, options, callback) => {
    assert.equal(options.all, true, 'the entire answer set is checked before choosing a destination');
    queueMicrotask(() => callback(error, answers));
  };
}
function result(lookup: LookupFunction, all: boolean) {
  return new Promise<{ error: NodeJS.ErrnoException | null; answers: LookupAddress[] }>((resolve) => {
    lookup('push-provider.example', { family: 0, hints: 0, all }, ((error, addresses, family) => {
      if (error) resolve({ error, answers: [] });
      else if (Array.isArray(addresses)) resolve({ error, answers: addresses });
      else {
        assert.ok(family === 4 || family === 6, 'a scalar lookup returns its actual address family');
        resolve({ error, answers: [{ address: addresses, family }] });
      }
    }) as Parameters<LookupFunction>[2]);
  });
}
function mappedHex(address: string) {
  const octets = address.split('.').map(Number);
  return `::ffff:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
}

test('production public lookup admits ordinary, mapped and mixed public provider answers in both callback shapes', async () => {
  const cases = [
    [ipv4('216.239.38.57')], [ipv6('::ffff:216.239.38.57')], [ipv6(mappedHex('216.239.38.57'))],
    [ipv6('2001:4860:4802:36::39')],
    [ipv4('216.239.38.57'), ipv4('216.239.36.57'), ipv4('216.239.36.55'), ipv4('216.239.38.55'),
      ipv6('2001:4860:4802:36::39'), ipv6('2001:4860:4802:38::37'),
      ipv6('2001:4860:4802:36::37'), ipv6('2001:4860:4802:38::39')],
  ];
  for (const answers of cases) for (const all of [false, true]) {
    const actual = await result(createPublicOnlyLookup(resolver(answers)), all);
    assert.equal(actual.error, null, JSON.stringify(answers));
    assert.deepEqual(actual.answers, all ? answers : [answers[0]]);
  }
});

test('every existing denied IPv4 range still refuses lower, interior, upper and both mapped forms', async () => {
  const ranges = [
    ['0.0.0.0', '0.12.34.56', '0.255.255.255'], ['10.0.0.0', '10.12.34.56', '10.255.255.255'],
    ['100.64.0.0', '100.100.12.34', '100.127.255.255'], ['127.0.0.0', '127.0.0.1', '127.255.255.255'],
    ['169.254.0.0', '169.254.169.254', '169.254.255.255'], ['172.16.0.0', '172.23.12.34', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.128', '192.0.0.255'], ['192.168.0.0', '192.168.12.34', '192.168.255.255'],
    ['198.18.0.0', '198.19.12.34', '198.19.255.255'], ['224.0.0.0', '230.12.34.56', '239.255.255.255'],
    ['240.0.0.0', '250.12.34.56', '255.255.255.255'],
  ];
  for (const address of ranges.flat()) for (const answer of [ipv4(address), ipv6(`::ffff:${address}`), ipv6(mappedHex(address))]) {
    for (const all of [false, true]) {
      const actual = await result(createPublicOnlyLookup(resolver([answer])), all);
      assert.equal(actual.error?.code, 'EPUSHPRIVATE', JSON.stringify(answer));
      assert.deepEqual(actual.answers, []);
    }
  }
});

test('existing IPv6 denial, mixed-answer rejection and empty/error refusal remain fail closed', async () => {
  const denied = ['::', '::1', '64:ff9b::', '64:ff9b::1234', '64:ff9b::ffff:ffff',
    'fc00::', 'fd12:3456::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::', 'fe90::1234', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'ff00::', 'ff12::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'];
  for (const address of denied) for (const all of [false, true]) {
    assert.equal((await result(createPublicOnlyLookup(resolver([ipv6(address)])), all)).error?.code, 'EPUSHPRIVATE', address);
  }
  for (const deniedAnswer of [ipv4('127.0.0.1'), ipv6('::ffff:169.254.169.254'), ipv6('fd00::1')]) {
    for (const answers of [[ipv4('216.239.38.57'), deniedAnswer], [deniedAnswer, ipv4('216.239.38.57')]]) {
      for (const all of [false, true]) assert.equal((await result(createPublicOnlyLookup(resolver(answers)), all)).error?.code, 'EPUSHPRIVATE');
    }
  }
  for (const all of [false, true]) {
    assert.equal((await result(createPublicOnlyLookup(resolver([])), all)).error?.code, 'EPUSHPRIVATE');
    const error = Object.assign(new Error('temporary resolver failure'), { code: 'EAI_AGAIN' });
    assert.equal((await result(createPublicOnlyLookup(resolver([], error)), all)).error, error);
  }
});

test('normal production HTTPS agent rejects private, mapped and mixed connections before a listener is reached', { timeout: 5000 }, async () => {
  let connections = 0;
  const protectedListener = createServer((socket) => { connections += 1; socket.destroy(); });
  protectedListener.listen(0, '127.0.0.1');
  await once(protectedListener, 'listening');
  const port = (protectedListener.address() as AddressInfo).port;
  try {
    for (const answers of [[ipv4('127.0.0.1')], [ipv6('::ffff:127.0.0.1')], [ipv4('216.239.38.57'), ipv4('127.0.0.1')]]) {
      const agent = createPushAgent(config, resolver(answers));
      try {
        const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
          const request = https.request({ hostname: 'push-provider.example', port, path: '/push', method: 'POST', agent,
            rejectUnauthorized: true, timeout: 1000 }, () => reject(new Error('Protected listener was reached')));
          request.on('error', resolve);
          request.on('timeout', () => request.destroy(new Error('No typed connection refusal')));
          request.end();
        });
        assert.equal(error.code, 'EPUSHPRIVATE');
      } finally { agent.destroy(); }
    }
    assert.equal(connections, 0);
  } finally { await new Promise<void>((resolve) => protectedListener.close(() => resolve())); }
});

test('fresh production-agent lookup rejects rebinding after the same host previously resolved publicly', { timeout: 5000 }, async () => {
  let calls = 0; let connections = 0;
  const protectedListener = createServer((socket) => { connections += 1; socket.destroy(); });
  protectedListener.listen(0, '127.0.0.1');
  await once(protectedListener, 'listening');
  const port = (protectedListener.address() as AddressInfo).port;
  const agent = createPushAgent(config, (hostname, options, callback) => {
    calls += 1;
    resolver(calls === 1 ? [ipv4('216.239.38.57')] : [ipv6('::ffff:127.0.0.1')])(hostname, options, callback);
  });
  try {
    const initial = await result(agent.options.lookup as LookupFunction, true);
    assert.equal(initial.error, null);
    assert.deepEqual(initial.answers, [ipv4('216.239.38.57')]);
    const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const request = https.request({ hostname: 'push-provider.example', port, path: '/push', method: 'POST', agent,
        rejectUnauthorized: true, timeout: 1000 }, () => reject(new Error('Rebound listener was reached')));
      request.on('error', resolve);
      request.on('timeout', () => request.destroy(new Error('No typed rebinding refusal')));
      request.end();
    });
    assert.equal(error.code, 'EPUSHPRIVATE');
    assert.equal(calls, 2);
    assert.equal(connections, 0);
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => protectedListener.close(() => resolve()));
  }
});
