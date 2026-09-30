import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';

const directory = process.argv[2];
assert.ok(directory, 'pass the live TURN artifact directory');

function lines(name) {
  return readFileSync(join(directory, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function bytes(value) {
  const match = value.trim().match(/^([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/);
  assert.ok(match, `unrecognized Docker byte value: ${value}`);
  const powers = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
    KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return Number(match[1]) * powers[match[2]];
}

function io(value) {
  const [receive, transmit] = value.split(' / ');
  assert.ok(receive && transmit, `unrecognized Docker NetIO value: ${value}`);
  return { receive: bytes(receive), transmit: bytes(transmit) };
}

const phases = lines('livekit-phases.jsonl');
const summaries = [];
for (const active of phases.filter((entry) => /(?:four_media|code_[24])_active$/.test(entry.phase))) {
  const verified = phases.find((entry) => entry.phase === active.phase.replace(/_active$/, '_verified'));
  assert.ok(verified, `verified marker missing for ${active.phase}`);
  const startMs = Date.parse(active.timestampUtc), endMs = Date.parse(verified.timestampUtc);
  assert.ok(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs);
  const samples = lines('livekit-container-stats.jsonl').filter((entry) =>
    Date.parse(entry.timestampUtc) >= startMs && Date.parse(entry.timestampUtc) <= endMs);
  assert.ok(samples.length >= 2, `need two resource samples for ${active.phase}; got ${samples.length}`);
  const cpu = samples.map((entry) => Number.parseFloat(entry.stats.CPUPerc));
  const memory = samples.map((entry) => bytes(entry.stats.MemUsage.split(' / ')[0]));
  const first = io(samples[0].stats.NetIO), last = io(samples.at(-1).stats.NetIO);
  assert.ok(cpu.every(Number.isFinite) && memory.every(Number.isFinite));
  assert.ok(last.transmit > first.transmit, 'SFU must transmit during the interval');
  const summary = {
    profile: active.phase === 'four_media_active' ? 'four-person-two-synthetic-screens-local-TURN-TLS' : active.phase,
    phaseStartUtc: active.timestampUtc, phaseEndUtc: verified.timestampUtc, durationMs: endMs - startMs,
    sampleCount: samples.length,
    cpuMeanPercent: Math.round(cpu.reduce((sum, value) => sum + value, 0) / cpu.length * 10) / 10,
    cpuPeakPercent: Math.max(...cpu), memoryPeakMiB: Math.round(Math.max(...memory) / 1024 ** 2 * 10) / 10,
    networkReceiveBytes: Math.round(last.receive - first.receive), networkTransmitBytes: Math.round(last.transmit - first.transmit),
  };
  summaries.push(summary); console.log(JSON.stringify(summary));
}
assert.ok(summaries.length > 0, 'at least one measured media interval required');
writeFileSync(join(directory, 'livekit-resource-summary.json'), JSON.stringify(summaries, null, 2));
