import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReceiverQuality, readReceiverSample, RECEIVER_QUALITY_LIMITS,
  type RtcStatsRecord } from '../../apps/web/src/live/receiver-quality.js';

const before: RtcStatsRecord[] = [
  { id: '0:transport', type: 'transport', selectedCandidatePairId: '0:pair' },
  { id: '0:pair', type: 'candidate-pair', currentRoundTripTime: 0.04 },
  { id: '0:audio', type: 'inbound-rtp', kind: 'audio', packetsReceived: 100,
    packetsLost: 2, bytesReceived: 10_000, jitter: 0.012 },
  { id: '0:video', type: 'inbound-rtp', kind: 'video', packetsReceived: 150,
    packetsLost: 0, bytesReceived: 500_000, framesDecoded: 80,
    frameWidth: 640, frameHeight: 360, framesPerSecond: 15 },
];

test('receiver sample derives actual interval bitrate, loss, fps, jitter and selected ICE RTT', () => {
  const after: RtcStatsRecord[] = [
    before[0]!, { ...before[1]!, currentRoundTripTime: 0.05 },
    { ...before[2]!, packetsReceived: 200, packetsLost: 3, bytesReceived: 20_000 },
    { ...before[3]!, packetsReceived: 300, bytesReceived: 700_000, framesDecoded: 110 },
  ];
  const sample = readReceiverSample(after, before, 2000);
  assert.equal(sample.intervalMs, 2000);
  assert.equal(sample.rttMs, 50);
  assert.deepEqual(sample.tracks.map((track) => track.kind), ['audio', 'video']);
  assert.equal(sample.tracks[0]!.bitrateKbps, 40);
  assert.equal(sample.tracks[0]!.packetsDelta, 100);
  assert.ok(Math.abs(sample.tracks[0]!.lossPercent! - 100 / 101) < 0.001);
  assert.equal(sample.tracks[0]!.jitterMs, 12);
  assert.equal(sample.tracks[1]!.bitrateKbps, 800);
  assert.equal(sample.tracks[1]!.fps, 15);
  assert.equal(sample.tracks[1]!.width, 640);
  assert.equal(assessReceiverQuality(sample, ['audio', 'video']).status, 'good');
});

test('fixed delay yields an explicit network warning; high loss and jitter become poor', () => {
  const weak = readReceiverSample([
    before[0]!, { ...before[1]!, currentRoundTripTime: 0.45 },
    { ...before[2]!, packetsReceived: 110, packetsLost: 2, bytesReceived: 11_000 },
  ], before, 1000);
  assert.ok(weak.rttMs! > RECEIVER_QUALITY_LIMITS.rttWarningMs);
  assert.equal(assessReceiverQuality(weak, ['audio']).status, 'warning');
  assert.match(assessReceiverQuality(weak, ['audio']).warnings[0]!, /round trip 450 ms/);

  const poor = readReceiverSample([
    before[0]!, { ...before[1]!, currentRoundTripTime: 0.65 },
    { ...before[2]!, packetsReceived: 110, packetsLost: 5, jitter: 0.09,
      bytesReceived: 11_000 },
  ], before, 1000);
  const result = assessReceiverQuality(poor, ['audio']);
  assert.equal(result.status, 'poor');
  assert.ok(result.warnings.some((warning) => warning.includes('packet loss')));
  assert.ok(result.warnings.some((warning) => warning.includes('Audio jitter')));
});

test('counter reset or absent receiver stats cannot fabricate healthy throughput', () => {
  const reset = readReceiverSample([
    { ...before[2]!, packetsReceived: 2, packetsLost: 0, bytesReceived: 30 },
  ], before, 1000);
  assert.equal(reset.tracks[0]!.bitrateKbps, undefined);
  assert.equal(reset.tracks[0]!.lossPercent, undefined);
  assert.equal(assessReceiverQuality(reset, ['audio']).status, 'unknown');
  assert.equal(assessReceiverQuality({ intervalMs: 1000, tracks: [] }).status, 'unknown');
  assert.equal(assessReceiverQuality({ intervalMs: 1000, tracks: [] }, ['audio']).status, 'unknown');
  assert.equal(assessReceiverQuality({ intervalMs: 2500, tracks: [] }, ['audio']).status, 'poor');
});

test('cumulative packets and healthy RTT cannot hide a stalled expected receiver', () => {
  const stalled = readReceiverSample(before, before, 2500);
  assert.equal(stalled.rttMs, 40);
  assert.equal(stalled.tracks[0]!.packetsReceived, 100);
  assert.equal(stalled.tracks[0]!.packetsDelta, 0);
  assert.equal(stalled.tracks[0]!.bitrateKbps, 0);
  const result = assessReceiverQuality(stalled, ['audio']);
  assert.equal(result.status, 'poor');
  assert.ok(result.warnings.some((warning) => warning.includes('audio stopped receiving')));
  const shortSample = readReceiverSample(before, before, 1000);
  assert.equal(assessReceiverQuality(shortSample, ['audio']).status, 'unknown');
});
