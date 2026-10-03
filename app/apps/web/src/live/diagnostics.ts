import { assessReceiverQuality, readReceiverSample, type RtcStatsRecord } from './receiver-quality.js';

export function measurement(value: number | undefined | null, unit: string, digits = 0): string {
  return value === undefined || value === null || !Number.isFinite(value) || value < 0
    ? `– ${unit}` : `${value.toFixed(digits)} ${unit}`;
}

/** Per-track, on-demand history. Missing reports invalidate the next interval;
 * replacement tracks, resets and unavailable counters never become zero rates. */
export class TrackDiagnostics {
  private previous = new Map<string, { at: number; record?: RtcStatsRecord }>();
  private sent = new Map<string, { at: number; bytes?: number }>();
  private epoch = 0;
  get version(): number { return this.epoch; }

  clear(): void { this.epoch++; this.previous.clear(); this.sent.clear(); }
  forget(sid: string): void { this.epoch++; this.previous.delete(`in:${sid}`); this.sent.delete(`out:${sid}`); }
  retain(keys: Set<string>): void {
    for (const key of this.previous.keys()) if (!keys.has(key)) this.previous.delete(key);
    for (const key of this.sent.keys()) if (!keys.has(key)) this.sent.delete(key);
  }

  sender(key: string, bytes: number | undefined, at: number): number | undefined {
    const before = this.sent.get(key);
    this.sent.set(key, { at, bytes });
    if (!before || bytes === undefined || before.bytes === undefined ||
      !Number.isFinite(bytes) || !Number.isFinite(before.bytes) || bytes < 0 || before.bytes < 0 || bytes < before.bytes || at <= before.at) return;
    return (bytes - before.bytes) * 8 / (at - before.at);
  }

  receiver(key: string, kind: 'audio' | 'video', stats: Partial<RtcStatsRecord> | undefined,
    at: number, expected: boolean, codec?: string, concealmentEvents?: number) {
    const before = this.previous.get(key);
    const record: RtcStatsRecord | undefined = stats ? { ...stats, id: stats.id ?? key, type: 'inbound-rtp', kind } : undefined;
    this.previous.set(key, { at, record });
    const intervalMs = before ? Math.max(0, at - before.at) : 0;
    const sample = readReceiverSample(record ? [record] : [], before?.record ? [before.record] : [], intervalMs);
    const track = sample.tracks[0];
    // Stats absent is unmeasured; only observed, unchanged packet counters can
    // establish a stalled receiver. Paused/muted tracks are not expected flow.
    const quality = assessReceiverQuality(sample, record && expected ? [kind] : []);
    const dimensions = track?.width && track.height ? `${track.width}×${track.height}` : '– ×–';
    const values = kind === 'video'
      ? [dimensions, measurement(track?.fps, 'fps', 1), measurement(track?.bitrateKbps, 'kbit/s'),
        measurement(track?.lossPercent, '% lost', 1), codec ?? ''].filter(Boolean)
      : [measurement(track?.bitrateKbps, 'kbit/s'), measurement(track?.jitterMs, 'ms jitter'),
        measurement(track?.lossPercent, '% lost', 1), measurement(concealmentEvents, 'gaps total')];
    const warning = !expected ? null : quality.warnings.join(' · ') ||
      (quality.status === 'unknown' ? 'Receiver measurements unavailable; waiting for a valid interval' : null);
    return { values, warning, sample, quality };
  }
}

/** Read the actual RTCRtpReceiver report. The locked SDK's audio summary omits
 * packet counters. Choose only this track's inbound stream; ambiguity is unknown. */
export function receiverReport(report: RTCStatsReport | undefined, kind: 'audio' | 'video', trackId: string) {
  if (!report) return;
  const inbound = [...report.values()].filter((s) => s.type === 'inbound-rtp' &&
    (s.kind === kind || s.mediaType === kind));
  const matching = inbound.filter((s) => s.trackIdentifier === trackId);
  const stats = matching.length === 1 ? matching[0] : inbound.length === 1 &&
    (!inbound[0]!.trackIdentifier || inbound[0]!.trackIdentifier === trackId) ? inbound[0] : undefined;
  if (!stats) return;
  const record: RtcStatsRecord = { id: stats.id, type: 'inbound-rtp', kind,
    bytesReceived: stats.bytesReceived, packetsReceived: stats.packetsReceived, packetsLost: stats.packetsLost,
    framesDecoded: stats.framesDecoded, frameWidth: stats.frameWidth, frameHeight: stats.frameHeight,
    jitter: stats.jitter };
  return { record, codec: report.get(stats.codecId)?.mimeType?.replace('video/', ''),
    concealmentEvents: stats.concealmentEvents };
}
