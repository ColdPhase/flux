/** Receiver-side WebRTC diagnostics. All thresholds are provisional #63 test
 * gates until peer calibration on real content, links and devices. */
export const RECEIVER_QUALITY_LIMITS = {
  rttWarningMs: 300,
  rttPoorMs: 600,
  audioJitterWarningMs: 30,
  audioJitterPoorMs: 80,
  packetLossWarningPercent: 3,
  packetLossPoorPercent: 10,
  videoFpsWarning: 10,
  videoFpsPoor: 5,
  stalledTrackAfterMs: 2_000,
} as const;

export interface RtcStatsRecord {
  id: string;
  type: string;
  kind?: string;
  selected?: boolean;
  selectedCandidatePairId?: string;
  currentRoundTripTime?: number;
  packetsReceived?: number;
  packetsLost?: number;
  bytesReceived?: number;
  jitter?: number;
  framesPerSecond?: number;
  framesDecoded?: number;
  frameWidth?: number;
  frameHeight?: number;
}

export interface ReceiverTrackSample {
  id: string;
  kind: 'audio' | 'video';
  packetsReceived?: number;
  packetsDelta?: number;
  lossPercent?: number;
  bitrateKbps?: number;
  jitterMs?: number;
  fps?: number;
  framesDelta?: number;
  width?: number;
  height?: number;
}

export interface ReceiverSample {
  intervalMs: number;
  rttMs?: number;
  tracks: ReceiverTrackSample[];
}

export type ReceiverQuality = {
  status: 'good' | 'warning' | 'poor' | 'unknown';
  warnings: string[];
};

function nonnegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function counterDelta(current: number | undefined, previous: number | undefined): number | undefined {
  const now = nonnegative(current);
  const before = nonnegative(previous);
  return now !== undefined && before !== undefined && now >= before ? now - before : undefined;
}

/** Feed the records from every receiver peer connection at two sample times.
 * Prefix ids with the peer-connection index when combining multiple reports. */
export function readReceiverSample(
  current: RtcStatsRecord[], previous: RtcStatsRecord[], elapsedMs: number,
): ReceiverSample {
  const byPreviousId = new Map(previous.map((record) => [record.id, record]));
  const selectedIds = new Set(current.filter((record) => record.type === 'transport')
    .map((record) => record.selectedCandidatePairId).filter((id): id is string => Boolean(id)));
  const selectedPairs = current.filter((record) => record.type === 'candidate-pair' &&
    (record.selected || selectedIds.has(record.id)));
  const rtts = selectedPairs.map((pair) => nonnegative(pair.currentRoundTripTime))
    .filter((seconds): seconds is number => seconds !== undefined);
  const rttMs = rtts.length ? Math.max(...rtts) * 1000 : undefined;
  const tracks: ReceiverTrackSample[] = [];

  for (const record of current) {
    if (record.type !== 'inbound-rtp' || (record.kind !== 'audio' && record.kind !== 'video')) continue;
    const prior = byPreviousId.get(record.id);
    const received = nonnegative(record.packetsReceived);
    const receivedDelta = counterDelta(record.packetsReceived, prior?.packetsReceived);
    const lostDelta = counterDelta(record.packetsLost, prior?.packetsLost);
    const total = (receivedDelta ?? 0) + (lostDelta ?? 0);
    const lossPercent = receivedDelta !== undefined && lostDelta !== undefined && total > 0
      ? (lostDelta / total) * 100 : undefined;
    const byteDelta = counterDelta(record.bytesReceived, prior?.bytesReceived);
    const bitrateKbps = byteDelta !== undefined && elapsedMs > 0
      ? (byteDelta * 8) / elapsedMs : undefined;
    const frameDelta = counterDelta(record.framesDecoded, prior?.framesDecoded);
    const fps = record.kind === 'video'
      ? (frameDelta !== undefined && elapsedMs > 0
        ? frameDelta * 1000 / elapsedMs : undefined)
      : undefined;
    tracks.push({ id: record.id, kind: record.kind, packetsReceived: received,
      packetsDelta: receivedDelta,
      lossPercent, bitrateKbps,
      jitterMs: record.kind === 'audio' && nonnegative(record.jitter) !== undefined
        ? record.jitter! * 1000 : undefined,
      fps, framesDelta: record.kind === 'video' ? frameDelta : undefined,
      width: record.kind === 'video' ? nonnegative(record.frameWidth) : undefined,
      height: record.kind === 'video' ? nonnegative(record.frameHeight) : undefined });
  }
  return { intervalMs: elapsedMs, rttMs, tracks };
}

/** Numeric reasons are intended for an on-demand diagnostic surface in #62.
 * Missing stats remain unknown; they never become a fabricated green status. */
export function assessReceiverQuality(sample: ReceiverSample, expectedKinds: Array<'audio' | 'video'> = []): ReceiverQuality {
  const warnings: string[] = [];
  let unverified = false;
  let severity: 'good' | 'warning' | 'poor' = 'good';
  const flag = (message: string, level: 'warning' | 'poor') => {
    warnings.push(message);
    if (level === 'poor' || severity === 'good') severity = level;
  };
  for (const kind of expectedKinds) {
    const matching = sample.tracks.filter((track) => track.kind === kind);
    if (matching.length === 0) {
      if (sample.intervalMs >= RECEIVER_QUALITY_LIMITS.stalledTrackAfterMs)
        flag(`${kind} has no received packets`, 'poor');
      else unverified = true;
    }
    for (const track of matching) {
      if (track.packetsDelta === 0 && sample.intervalMs >= RECEIVER_QUALITY_LIMITS.stalledTrackAfterMs)
        flag(`${kind} stopped receiving for ${Math.round(sample.intervalMs / 1000)} s`, 'poor');
      else if (track.packetsDelta === undefined || track.packetsDelta === 0)
        unverified = true;
    }
  }
  if (sample.rttMs !== undefined) {
    if (sample.rttMs > RECEIVER_QUALITY_LIMITS.rttPoorMs)
      flag(`Network round trip ${Math.round(sample.rttMs)} ms`, 'poor');
    else if (sample.rttMs > RECEIVER_QUALITY_LIMITS.rttWarningMs)
      flag(`Network round trip ${Math.round(sample.rttMs)} ms`, 'warning');
  }
  for (const track of sample.tracks) {
    if (track.lossPercent === undefined || (track.kind === 'video' && track.fps === undefined) ||
      (track.kind === 'audio' && track.jitterMs === undefined)) unverified = true;
    if (track.lossPercent !== undefined) {
      if (track.lossPercent > RECEIVER_QUALITY_LIMITS.packetLossPoorPercent)
        flag(`${track.kind} packet loss ${track.lossPercent.toFixed(1)}%`, 'poor');
      else if (track.lossPercent > RECEIVER_QUALITY_LIMITS.packetLossWarningPercent)
        flag(`${track.kind} packet loss ${track.lossPercent.toFixed(1)}%`, 'warning');
    }
    if (track.kind === 'audio' && track.jitterMs !== undefined) {
      if (track.jitterMs > RECEIVER_QUALITY_LIMITS.audioJitterPoorMs)
        flag(`Audio jitter ${Math.round(track.jitterMs)} ms`, 'poor');
      else if (track.jitterMs > RECEIVER_QUALITY_LIMITS.audioJitterWarningMs)
        flag(`Audio jitter ${Math.round(track.jitterMs)} ms`, 'warning');
    }
    if (track.kind === 'video' && track.fps !== undefined && (track.packetsDelta ?? 0) > 0) {
      if (track.fps < RECEIVER_QUALITY_LIMITS.videoFpsPoor)
        flag(`Video receiving ${track.fps.toFixed(1)} fps`, 'poor');
      else if (track.fps < RECEIVER_QUALITY_LIMITS.videoFpsWarning)
        flag(`Video receiving ${track.fps.toFixed(1)} fps`, 'warning');
    }
  }
  if (warnings.length) return { status: severity, warnings };
  if (unverified) return { status: 'unknown', warnings: [] };
  if (sample.rttMs === undefined && sample.tracks.every((track) => (track.packetsDelta ?? 0) === 0))
    return { status: 'unknown', warnings: [] };
  return { status: 'good', warnings: [] };
}
