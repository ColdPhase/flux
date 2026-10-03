import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiverReport, TrackDiagnostics } from '../../apps/web/src/live/diagnostics.js';
import { LiveMediaConnection } from '../../apps/web/src/live/media.js';
import { ConnectionQuality, RemoteAudioTrack, RemoteVideoTrack, Track } from '../../apps/web/node_modules/livekit-client/dist/livekit-client.esm.mjs';

function raw(kind: 'audio' | 'video', id = 'rtp-one', packets = 100, bytes: number | undefined = 10000) {
  return new Map([[id, { id, type: 'inbound-rtp', kind, trackIdentifier: `${kind}-track`,
    timestamp: 1000, packetsReceived: packets, packetsLost: 0, bytesReceived: bytes,
    jitter: 0.01, framesDecoded: packets * .3, frameWidth: 2560, frameHeight: 1440,
    concealmentEvents: 0 }]]) as unknown as RTCStatsReport;
}
function setup(kind: 'audio' | 'video', read: () => Promise<RTCStatsReport>) {
  const media: any = Object.create(LiveMediaConnection.prototype);
  const track = Object.create(kind === 'audio' ? RemoteAudioTrack.prototype : RemoteVideoTrack.prototype);
  track.receiver = { getStats: read };
  Object.defineProperties(track, { streamState: { value: 'active', configurable: true },
    mediaStreamTrack: { value: { id: `${kind}-track` } } });
  const publication = { trackSid: kind, source: kind === 'audio' ? Track.Source.Microphone : Track.Source.ScreenShare,
    isMuted: false, track };
  const pubs = new Map([[kind, publication]]);
  media.room = { localParticipant: { identity: '', trackPublications: new Map() },
    remoteParticipants: new Map([['peer', { identity: '', trackPublications: pubs,
      connectionQuality: ConnectionQuality.Good }]]),
    disconnect: async () => { pubs.clear(); media.room.remoteParticipants.clear(); } };
  media.snapshot = { people: [] }; media.connection = 'connected'; media.hearing = true;
  media.trackDiagnostics = new TrackDiagnostics(); media.generation = { mic: 0, camera: 0, screen: 0 };
  media.stopPending = () => {}; media.release = async () => {}; media.emit = () => {};
  return { media, track, publication, pubs };
}

test('independent F1: actual SDK raw report and production audio diagnostic expose interval loss', async () => {
  let report = raw('audio');
  const { media, track } = setup('audio', async () => report);
  assert.equal((await track.getReceiverStats()).packetsReceived, undefined, 'still exercises actual pinned projection omission');
  await media.diagnostics(() => 'Peer');
  report = raw('audio', 'rtp-one', 200, 20000);
  const rows = await media.diagnostics(() => 'Peer');
  assert.ok(rows[1].values.includes('0.0 % lost'));
  assert.ok(rows[1].values.includes('0 gaps total'));
  assert.equal(rows[1].warning, null);
  const sample = receiverReport(await track.getRTCStatsReport(), 'audio', 'audio-track')!;
  const d = new TrackDiagnostics();
  d.receiver('in:voice', 'audio', sample.record, 1000, true);
  const swapped = receiverReport(raw('audio', 'rtp-two', 300, 30000), 'audio', 'audio-track')!;
  assert.equal(d.receiver('in:voice', 'audio', swapped.record, 3000, true).quality.status, 'unknown');
  assert.equal(receiverReport(report, 'audio', 'wrong-track'), undefined);
  assert.equal(receiverReport(report, 'video', 'audio-track'), undefined);
  console.log('F1_FIXED', JSON.stringify(rows[1]));
});

test('independent F2: isolated missing/reset bytes are unknown for audio and video', () => {
  for (const kind of ['audio', 'video'] as const) for (const bytes of [undefined, 100]) {
    const d = new TrackDiagnostics();
    d.receiver(`in:${kind}`, kind, receiverReport(raw(kind), kind, `${kind}-track`)!.record, 1000, true);
    const record = receiverReport(raw(kind, 'rtp-one', 200, bytes), kind, `${kind}-track`)!.record;
    // JS default arguments must not turn intentional undefined into a baseline.
    record.bytesReceived = bytes;
    const row = d.receiver(`in:${kind}`, kind, record, 3000, true);
    assert.equal(row.quality.status, 'unknown'); assert.ok(row.values.includes('– kbit/s'));
    assert.match(row.warning!, /unavailable/);
    console.log('F2_FIXED', kind, JSON.stringify(row));
  }
});

test('independent F3: real production/SDK pending raw read stays cancelled after removal and disconnect', async () => {
  for (const disconnect of [false, true]) {
    let resolve!: (value: RTCStatsReport) => void;
    const { media, pubs } = setup('video', () => new Promise((done) => { resolve = done; }));
    const pending = media.diagnostics(() => 'Peer');
    if (disconnect) await media.disconnect();
    else { pubs.clear(); media.trackDiagnostics.forget('video'); }
    resolve(raw('video'));
    assert.deepEqual(await pending, []);
    assert.equal(media.trackDiagnostics.previous.size, 0);
    assert.equal(media.trackDiagnostics.receiver('in:video', 'video', receiverReport(raw('video'), 'video', 'video-track')!.record,
      3000, true).sample.tracks[0].packetsDelta, undefined);
    console.log('F3_FIXED', disconnect ? 'disconnect' : 'remove');
  }
});

test('independent error/pause/ambiguity: no fake loss or warnings while intentionally quiet/muted/paused', async () => {
  for (const kind of ['audio', 'video'] as const) {
    const { media, track, publication } = setup(kind, async () => { throw new Error('stats unavailable'); });
    const rows = await media.diagnostics(() => 'Peer'); assert.match(rows[1].warning, /unavailable/);
    assert.ok(rows[1].values.includes('– % lost'));
    publication.isMuted = true;
    assert.equal((await media.diagnostics(() => 'Peer'))[1].warning, null);
    publication.isMuted = false;
    if (kind === 'audio') media.hearing = false;
    else Object.defineProperty(track, 'streamState', { value: 'paused' });
    assert.equal((await media.diagnostics(() => 'Peer'))[1].warning, null);
    const ambiguous = raw(kind);
    (ambiguous as any).set('other', { ...ambiguous.get('rtp-one'), id: 'other' });
    assert.equal(receiverReport(ambiguous, kind, `${kind}-track`), undefined);
  }
});
