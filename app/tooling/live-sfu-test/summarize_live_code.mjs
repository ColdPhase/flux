import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';

const directory = process.argv[2];
assert.ok(directory);
const report = JSON.parse(readFileSync(join(directory, 'code-1440p-report.json'), 'utf8'));
const raw = readFileSync(join(directory, 'code-1440p-stats.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const delta = (now, before) => Number.isFinite(now) && Number.isFinite(before) && now >= before ? now - before : null;
const summaries = report.stages.map((stage) => {
  const samples = raw.filter((s) => s.peers === stage.peers);
  assert.ok(samples.length >= 2);
  const start = samples[0], end = samples.at(-1);
  const intervalMs = Date.parse(end.timestampUtc) - Date.parse(start.timestampUtc);
  const clients = end.clients.map((stats, client) => stats.filter((s) =>
    ['outbound-rtp', 'inbound-rtp'].includes(s.type) && !s.isRemote).map((s) => {
    const prior = start.clients[client].find((p) => p.id === s.id);
    const inbound = s.type === 'inbound-rtp';
    const frames = delta(inbound ? s.framesDecoded : s.framesSent,
      inbound ? prior?.framesDecoded : prior?.framesSent);
    const encoded = inbound ? null : delta(s.framesEncoded, prior?.framesEncoded);
    const bytes = delta(inbound ? s.bytesReceived : s.bytesSent,
      inbound ? prior?.bytesReceived : prior?.bytesSent);
    const packets = delta(inbound ? s.packetsReceived : s.packetsSent,
      inbound ? prior?.packetsReceived : prior?.packetsSent);
    const lost = delta(s.packetsLost, prior?.packetsLost);
    return { client: client + 1, id: s.id, kind: s.kind, direction: inbound ? 'received' : 'sent',
      width: s.frameWidth ?? null, height: s.frameHeight ?? null, framesDelta: frames,
      intervalFps: frames === null ? null : frames * 1000 / intervalMs,
      frameCounter: inbound ? 'framesDecoded' : 'framesSent', framesEncodedDelta: encoded,
      encodedIntervalFps: encoded === null ? null : encoded * 1000 / intervalMs,
      bitrateKbps: bytes === null ? null : bytes * 8 / intervalMs,
      packetsDelta: packets, packetLossPercent: inbound && packets !== null && lost !== null && packets + lost > 0
        ? lost * 100 / (packets + lost) : null,
      jitterMs: s.jitter === undefined ? null : s.jitter * 1000,
      qualityLimitationReason: s.qualityLimitationReason ?? null };
  }));
  const markers = stage.events.flatMap((events, viewer) => Object.entries(events).map(([name, all]) => {
    const selected = all.filter((e) => e.receivedUtcMs >= stage.windowStartUtcMs && e.receivedUtcMs <= stage.windowEndUtcMs);
    const sourceTimes = stage.sourceTimes[Number(name.split('-')[1]) - 1];
    const ages = selected.map((e) => sourceTimes[e.frame] === undefined ? null : e.receivedUtcMs - sourceTimes[e.frame]).filter((v) => v !== null);
    const gaps = selected.slice(1).map((e, i) => e.receivedUtcMs - selected[i].receivedUtcMs);
    const ordered = [...ages].sort((a, b) => a - b);
    const quantile = (fraction) => ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] : null;
    return { viewer: viewer + 1, name, auditableCallbacks: selected.length,
      distinctSourceFrames: new Set(selected.map((e) => e.frame)).size,
      firstSourceFrame: selected[0]?.frame ?? null, lastSourceFrame: selected.at(-1)?.frame ?? null,
      maximumCallbackGapMs: gaps.length ? Math.max(...gaps) : null,
      localSourceDrawToCallbackMedianMs: quantile(0.5), localSourceDrawToCallbackP95Ms: quantile(0.95),
      ageMethod: 'binary decoded-frame marker matched to source Date.now on the same Docker host; includes capture/encode/relay/decode/compositor/callback scheduling, not physical glass-to-glass',
    };
  }));
  return { peers: stage.peers, intervalMs, clients, markers, images: stage.images,
    receiverSamples: stage.receiverSamples, candidates: stage.candidates };
});
const result = { profile: report.profile, browserVersion: report.browserVersion,
  firstAuditableFrameMs: report.firstAuditableFrameMs,
  firstFrameMethod: 'from initiating isolated capture/publication to first attached receiver callback with decoded binary marker; clarity requires original-pixel peer inspection',
  sources: report.sources, stages: summaries, productDiagnosticPath: report.productDiagnosticPath,
  limits: ['local Docker/Xvfb Chromium calibration', 'second share synthetic', 'no physical device/speech/motion/public network/k3s certification', 'quality thresholds remain provisional'] };
writeFileSync(join(directory, 'code-1440p-summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ profile: result.profile, stages: summaries.map(({ peers, intervalMs, clients, markers }) =>
  ({ peers, intervalMs, clients, markers })) }));
