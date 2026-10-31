import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installIceServerNormalizer, normalizeIceServers, withoutDefaultTransport } from '../../apps/web/src/live/ice-servers.js';

test('TURN URLs drop only the transport their scheme already implies', () => {
  assert.equal(withoutDefaultTransport('turn:203.0.113.20:3478?transport=udp'), 'turn:203.0.113.20:3478');
  assert.equal(withoutDefaultTransport('turns:turn.example.org:443?transport=tcp'), 'turns:turn.example.org:443');
  assert.equal(withoutDefaultTransport('TURNS:turn.example.org:443?transport=TCP'), 'TURNS:turn.example.org:443');
  // TURN over plain TCP and TLS over UDP have no query-free spelling: kept as they are.
  assert.equal(withoutDefaultTransport('turn:turn.example.org:443?transport=tcp'), 'turn:turn.example.org:443?transport=tcp');
  assert.equal(withoutDefaultTransport('turns:turn.example.org:443?transport=udp'), 'turns:turn.example.org:443?transport=udp');
  assert.equal(withoutDefaultTransport('stun:turn.example.org:3478'), 'stun:turn.example.org:3478');
});

test('LiveKit join servers keep credentials and order', () => {
  const config = normalizeIceServers({
    iceServers: [
      { urls: ['turn:203.0.113.20:3478?transport=udp', 'turns:turn.sim.test:443?transport=tcp'], username: 'u', credential: 'c' },
      { urls: 'stun:turn.sim.test:3478' },
    ],
    iceTransportPolicy: 'all',
  });
  assert.deepEqual(config, {
    iceServers: [
      { urls: ['turn:203.0.113.20:3478', 'turns:turn.sim.test:443'], username: 'u', credential: 'c' },
      { urls: 'stun:turn.sim.test:3478' },
    ],
    iceTransportPolicy: 'all',
  });
  assert.equal(normalizeIceServers(undefined), undefined);
});

test('the page peer connection receives normalized servers on construction and update, once', () => {
  const seen: (RTCConfiguration | undefined)[] = [];
  class Fake {
    constructor(config?: RTCConfiguration) { seen.push(config); }
    setConfiguration(config?: RTCConfiguration) { seen.push(config); }
  }
  const scope = { RTCPeerConnection: Fake as unknown as typeof RTCPeerConnection };
  installIceServerNormalizer(scope);
  const installed = scope.RTCPeerConnection;
  installIceServerNormalizer(scope);
  assert.equal(scope.RTCPeerConnection, installed, 'a second install changes nothing');
  const pc = new scope.RTCPeerConnection({ iceServers: [{ urls: 'turns:t.example:443?transport=tcp' }] });
  pc.setConfiguration({ iceServers: [{ urls: ['turn:t.example:3478?transport=udp'] }] });
  assert.ok(pc instanceof Fake);
  assert.deepEqual(seen, [
    { iceServers: [{ urls: 'turns:t.example:443' }] },
    { iceServers: [{ urls: ['turn:t.example:3478'] }] },
  ]);
  installIceServerNormalizer({});
});
