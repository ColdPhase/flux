import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrackDiagnostics } from '../../apps/web/src/live/diagnostics.js';

const video = { bytesReceived: 10_000, packetsReceived: 100, packetsLost: 50,
  framesDecoded: 30, frameWidth: 2560, frameHeight: 1440, framesPerSecond: 15 };

test('on-demand video row uses interval loss and decoded fps, not lifetime loss or configured fps', () => {
  const d = new TrackDiagnostics();
  const first = d.receiver('screen', 'video', video, 0, true);
  assert.ok(first.values.includes('– % lost'));
  assert.ok(first.values.includes('– fps'));
  assert.equal(first.quality.status, 'unknown');
  const next = d.receiver('screen', 'video', { ...video, bytesReceived: 30_000,
    packetsReceived: 200, framesDecoded: 60 }, 2000, true);
  assert.deepEqual(next.values, ['2560×1440', '15.0 fps', '80 kbit/s', '0.0 % lost']);
  assert.equal(next.warning, null);
  assert.equal(next.quality.status, 'good');
});

test('missing, partial and reset reports cannot display invented zero loss/gaps or negative rates', () => {
  const d = new TrackDiagnostics();
  d.receiver('screen', 'video', video, 0, true);
  const missing = d.receiver('screen', 'video', undefined, 2000, true);
  assert.equal(missing.quality.status, 'unknown');
  assert.match(missing.warning!, /unavailable/);
  assert.ok(missing.values.includes('– % lost'));
  assert.ok(missing.values.includes('– kbit/s'));
  const back = d.receiver('screen', 'video', video, 4000, true);
  assert.equal(back.quality.status, 'unknown');
  const reset = d.receiver('screen', 'video', { ...video, packetsReceived: 1,
    packetsLost: 0, bytesReceived: 10, framesDecoded: 1 }, 6000, true);
  assert.equal(reset.quality.status, 'unknown');
  assert.ok(reset.values.includes('– fps'));
  assert.ok(reset.values.includes('– kbit/s'));
  const audio = d.receiver('voice', 'audio', {}, 0, true);
  assert.equal(audio.sample.tracks[0]!.packetsReceived, undefined);
  assert.ok(audio.values.includes('– gaps total'));
  assert.equal(audio.quality.status, 'unknown');
  assert.equal(d.sender('camera', 1000, 0), undefined);
  assert.equal(d.sender('camera', 1, 2000), undefined);
  assert.equal(d.sender('camera', undefined, 4000), undefined);
  assert.equal(d.sender('camera', 2000, 6000), undefined);
  assert.equal(d.sender('camera', -1, 8000), undefined);
  assert.equal(d.sender('camera', 2000, 10_000), undefined);
});

test('partial advancing reports and discarded track histories remain unmeasured', () => {
  const d = new TrackDiagnostics();
  d.receiver('in:screen', 'video', video, 0, true);
  const partial = d.receiver('in:screen', 'video', { packetsReceived: 200, bytesReceived: 20_000,
    frameWidth: 2560, frameHeight: 1440 }, 2000, true);
  assert.equal(partial.quality.status, 'unknown');
  assert.match(partial.warning!, /unavailable/);
  d.forget('screen');
  assert.equal(d.receiver('in:screen', 'video', video, 4000, true).quality.status, 'unknown');
  d.retain(new Set());
  assert.equal(d.receiver('in:screen', 'video', video, 6000, true).sample.tracks[0]!.packetsDelta, undefined);
  d.clear();
  assert.equal(d.receiver('in:screen', 'video', video, 8000, true).sample.tracks[0]!.packetsDelta, undefined);
});

test('observed idle counters warn for expected flow; intentional pause does not warn', () => {
  const d = new TrackDiagnostics();
  d.receiver('screen', 'video', video, 0, true);
  const idle = d.receiver('screen', 'video', video, 2500, true);
  assert.equal(idle.quality.status, 'poor');
  assert.match(idle.warning!, /stopped receiving/);
  assert.equal(d.receiver('screen', 'video', video, 5000, false).warning, null);
  d.receiver('voice', 'audio', { packetsReceived: 100, packetsLost: 0, bytesReceived: 1000, jitter: 0.01 }, 0, true);
  const audio = d.receiver('voice', 'audio', { packetsReceived: 102, packetsLost: 1,
    bytesReceived: 1200, jitter: 0.09 }, 2000, true);
  assert.equal(audio.quality.status, 'poor');
  assert.match(audio.warning!, /packet loss/);
  assert.match(audio.warning!, /jitter/);
});
