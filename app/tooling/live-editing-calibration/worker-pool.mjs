import { Worker } from 'node:worker_threads';
import { setTimeout, clearTimeout } from 'node:timers';
import { CAPS } from './caps.mjs';
import { Refusal, stateCharge } from './codec.mjs';

function response(worker, kind, milliseconds, timeoutCode) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.off('message', message); worker.off('error', failed); worker.off('exit', exited);
      if (error) reject(error); else resolve(value);
    };
    const message = (value) => { if (value.kind === kind) finish(null, value); };
    const failed = () => finish(new Refusal('WORKER_FAILURE'));
    const exited = () => finish(new Refusal('WORKER_EXIT'));
    const timer = setTimeout(() => finish(new Refusal(timeoutCode)), milliseconds);
    worker.on('message', message); worker.once('error', failed); worker.once('exit', exited);
  });
}

/** Isolated calibration pool; module bootstrap has its own finite readiness deadline. */
export class CodecPool {
  constructor() {
    this.active = 0; this.waiting = []; this.externalBytes = 0;
    this.closed = false; this.running = new Set();
  }
  acquire() {
    if (this.closed) return Promise.reject(new Refusal('POOL_CLOSED'));
    if (this.active < CAPS.workers) { this.active++; return Promise.resolve(); }
    if (this.waiting.length >= CAPS.waitingTasks) return Promise.reject(new Refusal('WORK_QUEUE_LIMIT'));
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next.resolve(); // Transfer the held slot without an asynchronous acquisition gap.
    else this.active--;
  }
  async run(state, envelope, bytes, { stall = false, canWrite = true, control = 'codec' } = {}) {
    if (this.closed) throw new Refusal('POOL_CLOSED');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > CAPS.assemblyBytes) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    // Charge retry bytes, transferable copy and an upper UTF-16 serialized-state copy.
    // Confirmed object/cache accounting and worker heap remain separate budgets.
    // Input transfer plus the full bounded result transfer are reserved while queued.
    const charge = stateCharge(state);
    if (charge > CAPS.roomCacheBytes) throw new Refusal('ROOM_CACHE_LIMIT');
    const reservation = 2 * bytes.byteLength + charge + CAPS.roomCacheBytes;
    if (this.externalBytes + reservation > CAPS.assembliesBytesPerApi) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    this.externalBytes += reservation;
    let acquired = false; let worker;
    try {
      await this.acquire(); acquired = true;
      if (this.closed) throw new Refusal('POOL_CLOSED');
      const filename = { codec: './codec-worker.mjs', stall: './stall-worker.mjs',
        silent: './silent-worker.mjs', exit: './exit-worker.mjs' }[stall ? 'stall' : control];
      if (!filename) throw new Refusal('INVALID_WORKER_CONTROL');
      const limits = { maxOldGenerationSizeMb: CAPS.workerOldMiB,
        maxYoungGenerationSizeMb: CAPS.workerYoungMiB,
        codeRangeSizeMb: CAPS.workerCodeMiB, stackSizeMb: CAPS.workerStackMiB };
      worker = new Worker(new URL(filename, import.meta.url), { resourceLimits: limits });
      this.running.add(worker);
      const ready = await response(worker, 'ready', CAPS.workerBootstrapMs, 'WORKER_BOOTSTRAP_TIMEOUT');
      for (const [key, value] of Object.entries(limits)) {
        if (ready.resourceLimits?.[key] !== value) throw new Refusal('WORKER_RESOURCE_LIMIT_MISMATCH');
      }
      const result = response(worker, 'result', CAPS.workerTimeoutMs, 'WORKER_TIMEOUT');
      const copy = Uint8Array.from(bytes);
      worker.postMessage({ state, envelope, bytes: copy.buffer, canWrite }, [copy.buffer]);
      return { ...await result, workerLimits: ready.resourceLimits };
    } finally {
      if (worker) { await worker.terminate(); this.running.delete(worker); }
      this.externalBytes -= reservation;
      if (acquired) this.release();
    }
  }
  async close() {
    this.closed = true;
    for (const item of this.waiting.splice(0)) item.reject(new Refusal('POOL_CLOSED'));
    await Promise.all([...this.running].map((worker) => worker.terminate()));
  }
}
