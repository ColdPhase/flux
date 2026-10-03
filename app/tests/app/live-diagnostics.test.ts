import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { receiverReport, TrackDiagnostics } from '../../apps/web/src/live/diagnostics.js';
import { LiveMediaConnection } from '../../apps/web/src/live/media.js';

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
  for (const bytesReceived of [undefined, 10]) {
    const bytes = new TrackDiagnostics();
    bytes.receiver('screen', 'video', video, 0, true);
    const missing = bytes.receiver('screen', 'video', { ...video, packetsReceived: 200,
      framesDecoded: 60, bytesReceived }, 2000, true);
    assert.equal(missing.quality.status, 'unknown');
    assert.match(missing.warning!, /unavailable/);
  }
  d.forget('screen');
  assert.equal(d.receiver('in:screen', 'video', video, 4000, true).quality.status, 'unknown');
  d.retain(new Set());
  assert.equal(d.receiver('in:screen', 'video', video, 6000, true).sample.tracks[0]!.packetsDelta, undefined);
  d.clear();
  assert.equal(d.receiver('in:screen', 'video', video, 8000, true).sample.tracks[0]!.packetsDelta, undefined);
});

test('actual locked SDK audio raw-report boundary retains RTP counters and stream identity', async () => {
  const require = createRequire(new URL('../../apps/web/src/live/media.ts', import.meta.url));
  const { RemoteAudioTrack } = require('livekit-client') as { RemoteAudioTrack: { prototype: {
    getReceiverStats(): Promise<{ packetsReceived?: number; packetsLost?: number }>;
    getRTCStatsReport(): Promise<RTCStatsReport> } } };
  const raw = (id: string, packets: number, bytes: number) => new Map([['audio', {
    id, type: 'inbound-rtp', kind: 'audio', trackIdentifier: 'voice-track',
    bytesReceived: bytes, packetsReceived: packets, packetsLost: 0, jitter: 0.01,
    concealmentEvents: 0, timestamp: 1000,
  }]]) as unknown as RTCStatsReport;
  let report = raw('ssrc-one', 100, 10_000);
  const actual = { receiver: { getStats: async () => report } };
  const projected = await RemoteAudioTrack.prototype.getReceiverStats.call(actual);
  // Documents why using this SDK projection cannot supply receiver packet loss.
  assert.equal(projected.packetsReceived, undefined);
  const d = new TrackDiagnostics();
  const read = async () => receiverReport(await RemoteAudioTrack.prototype.getRTCStatsReport.call(actual), 'audio', 'voice-track')!;
  d.receiver('in:voice', 'audio', (await read()).record, 0, true);
  report = raw('ssrc-one', 200, 20_000);
  const next = await read();
  const measured = d.receiver('in:voice', 'audio', next.record, 2000, true, undefined, next.concealmentEvents);
  assert.equal(measured.quality.status, 'good');
  assert.deepEqual(measured.values, ['40 kbit/s', '10 ms jitter', '0.0 % lost', '0 gaps total']);
  report = raw('ssrc-two', 300, 30_000);
  assert.equal(d.receiver('in:voice', 'audio', (await read()).record, 4000, true).quality.status, 'unknown',
    'a replacement RTP stream must not borrow the old stream baseline');
  assert.equal(receiverReport(report, 'video', 'voice-track'), undefined);
  assert.equal(receiverReport(report, 'audio', 'different-track'), undefined);
  const ambiguous = new Map([...report, ['second', { ...report.get('audio'), id: 'other-stream' }]]) as unknown as RTCStatsReport;
  assert.equal(receiverReport(ambiguous, 'audio', 'voice-track'), undefined);
});

test('actual production pending diagnostic read cannot resurrect removed or disconnected tracks', async () => {
  // Use the same ESM SDK class as media.ts, so its instanceof branch is real.
  const sdkUrl = new URL('../../apps/web/node_modules/livekit-client/dist/livekit-client.esm.mjs', import.meta.url).href;
  const sdk = await import(sdkUrl) as { RemoteVideoTrack: { prototype: object };
    Track: { Source: { ScreenShare: string } }; ConnectionQuality: { Good: string } };
  for (const disconnect of [false, true]) {
    let resolve!: (report: RTCStatsReport) => void;
    const track = Object.create(sdk.RemoteVideoTrack.prototype) as { getRTCStatsReport(): Promise<RTCStatsReport> };
    Object.defineProperties(track, { streamState: { value: 'active' },
      mediaStreamTrack: { value: { id: 'screen-track' } } });
    track.getRTCStatsReport = () => new Promise((done) => { resolve = done; });
    const publication = { trackSid: 'screen', source: sdk.Track.Source.ScreenShare, isMuted: false, track };
    const pubs = new Map([['screen', publication]]);
    const peers = new Map([['peer', { identity: '', trackPublications: pubs,
      connectionQuality: sdk.ConnectionQuality.Good }]]);
    const history = new TrackDiagnostics();
    const media = Object.assign(Object.create(LiveMediaConnection.prototype) as {
      diagnostics: LiveMediaConnection['diagnostics']; disconnect: LiveMediaConnection['disconnect'];
    }, { room: { localParticipant: { identity: '', trackPublications: new Map() },
      remoteParticipants: peers, disconnect: async () => { pubs.clear(); peers.clear(); } },
    snapshot: { people: [] }, connection: 'connected', trackDiagnostics: history,
    generation: { mic: 0, camera: 0, screen: 0 }, stopPending: () => {},
    release: async () => {}, emit: () => {} });
    const pending = media.diagnostics(() => 'Peer');
    if (disconnect) await media.disconnect();
    else { pubs.clear(); history.forget('screen'); }
    resolve(new Map([['screen', { ...video, id: 'screen-rtp', type: 'inbound-rtp',
      kind: 'video', trackIdentifier: 'screen-track' }]]) as unknown as RTCStatsReport);
    assert.deepEqual(await pending, []);
    const replacement = history.receiver('in:screen', 'video', video, 2000, true);
    assert.equal(replacement.sample.tracks[0]!.packetsDelta, undefined);
  }
});

test('observed idle counters warn for expected flow; intentional pause does not warn', () => {
  const d = new TrackDiagnostics();
  d.receiver('screen', 'video', video, 0, true);
  const idle = d.receiver('screen', 'video', video, 2500, true);
  assert.equal(idle.quality.status, 'poor');
  assert.match(idle.warning!, /stopped receiving/);
  // The panel polls every 2 s; an aligned interval timer can sample slightly early.
  const early = d.receiver('screen', 'video', video, 4495, true);
  assert.equal(early.sample.intervalMs, 1995);
  assert.equal(early.quality.status, 'poor');
  assert.match(early.warning!, /stopped receiving for 2 s/);
  assert.equal(d.receiver('screen', 'video', video, 5000, false).warning, null);
  d.receiver('voice', 'audio', { packetsReceived: 100, packetsLost: 0, bytesReceived: 1000, jitter: 0.01 }, 0, true);
  const audio = d.receiver('voice', 'audio', { packetsReceived: 102, packetsLost: 1,
    bytesReceived: 1200, jitter: 0.09 }, 2000, true);
  assert.equal(audio.quality.status, 'poor');
  assert.match(audio.warning!, /packet loss/);
  assert.match(audio.warning!, /jitter/);
});
