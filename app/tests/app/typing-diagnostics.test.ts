import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypingDiagnostics } from '../../apps/server/src/typing/diagnostics.js';

function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), release: () => resolve() };
}
test('measurement reset retains actual unfinished work through repeated epochs', async () => {
  const stats = new TypingDiagnostics(); const held = gate();
  const old = stats.measure('sender', () => held.promise);
  stats.reset(); stats.reset();
  assert.equal(stats.snapshot().phases.sender.carryIn, 1);
  assert.equal(stats.snapshot().phases.sender.inFlight, 1);
  await stats.measure('sender', async () => 'current');
  assert.equal(stats.snapshot().phases.sender.peak, 2);
  assert.equal(stats.snapshot().phases.sender.completed, 1);
  held.release(); await old;
  assert.equal(stats.snapshot().phases.sender.inFlight, 0);
  assert.equal(stats.snapshot().phases.sender.completed, 1, 'old latency is not a measured-period sample');
});
test('observer failure cannot reject publication; authorization rejection stays observable', async () => {
  const stats = new TypingDiagnostics(() => { throw new Error('observer failure'); });
  assert.doesNotThrow(() => stats.publication('fixture-person', true));
  assert.equal(stats.snapshot().published, 1);
  const rejected = new Error('authority unavailable');
  await assert.rejects(stats.measure('recipient', async () => { throw rejected; }), (error) => error === rejected);
  assert.equal(stats.snapshot().phases.recipient.failed, 1);
  assert.equal(stats.snapshot().phases.recipient.inFlight, 0);
  stats.recordQueue(performance.now() - 2500);
  assert.equal(stats.snapshot().phases.queue.p95UpperMs, null, 'overflow is not represented as a passing finite percentile');
  assert.equal(stats.snapshot().phases.queue.overflow2048Ms, 1);
});
