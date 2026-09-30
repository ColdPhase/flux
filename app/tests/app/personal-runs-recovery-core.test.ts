import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPersonalRunRecovery } from '../../apps/worker/src/personal-runs/recovery.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('recovery starts immediately, never overlaps, and stop drains the active pass', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const loop = startPersonalRunRecovery({ intervalMs: 5, recover: async () => { calls++; await gate; return 0; } });
  assert.equal(calls, 1);
  await delay(20);
  assert.equal(calls, 1, 'no overlapping pass while the first awaits its transaction');
  let stopped = false;
  const stopping = loop.stop().then(() => { stopped = true; });
  await delay(10);
  assert.equal(stopped, false, 'stop must wait for the transaction');
  release();
  await stopping;
  await delay(15);
  assert.equal(calls, 1, 'no rescheduling after stop');
});

test('a failed pass is observed and retried without overlapping or spinning', async () => {
  let calls = 0;
  const errors: unknown[] = [];
  let succeed!: () => void;
  const success = new Promise<void>((resolve) => { succeed = resolve; });
  const loop = startPersonalRunRecovery({ intervalMs: 5, log: (error) => errors.push(error), recover: async () => {
    if (++calls === 1) throw new Error('Synthetic database outage');
    succeed();
    return 0;
  } });
  try { await success; } finally { await loop.stop(); }
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
});
