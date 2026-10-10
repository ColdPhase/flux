import { Worker } from 'node:worker_threads';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { CAPS } from './caps.mjs';
import { Refusal } from './codec.mjs';
import { AdmissionBudget } from './admission-budget.mjs';

function response(worker, kind, milliseconds, timeoutCode, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.off('message', message); worker.off('error', failed); worker.off('exit', exited);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const message = (value) => { if (value.kind === kind) finish(null, value); };
    const failed = () => finish(new Refusal('WORKER_FAILURE'));
    const exited = () => finish(new Refusal('WORKER_EXIT'));
    const aborted = () => finish(new Refusal('ADMISSION_CANCELLED'));
    const timer = setTimeout(() => finish(new Refusal(timeoutCode)), milliseconds);
    worker.on('message', message); worker.once('error', failed); worker.once('exit', exited);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/**
 * Isolated codec pool: at most CAPS.workers workers, module bootstrap with its own finite readiness
 * deadline, a 100 ms task deadline and termination on timeout. A codec worker that answered within
 * its deadline stays for the next task (each task carries its whole state, so nothing is kept between
 * tasks); a timed-out, failed, exited or aborted one is terminated and a later task starts a fresh one.
 */
const LIMITS = new WeakMap();
export class CodecPool {
  constructor(changed = () => {}) {
    this.changed = changed; this.active = 0; this.waiting = []; this.budget = new AdmissionBudget(changed);
    this.closed = false; this.running = new Set(); this.idle = [];
  }
  get externalBytes() { return this.budget.bytes; }
  acquire() {
    if (this.closed) return Promise.reject(new Refusal('POOL_CLOSED'));
    if (this.active < CAPS.workers) { this.active++; this.changed(); return Promise.resolve(); }
    if (this.waiting.length >= CAPS.waitingTasks) return Promise.reject(new Refusal('WORK_QUEUE_LIMIT'));
    return new Promise((resolve, reject) => { this.waiting.push({ resolve, reject }); this.changed(); });
  }
  release() {
    const next = this.waiting.shift();
    if (next) next.resolve(); // Transfer the held slot without an asynchronous acquisition gap.
    else this.active--;
    this.changed();
  }
  async run(state, envelope, bytes, { stall = false, canWrite = true, control = 'codec', admission, signal } = {}) {
    if (this.closed) throw new Refusal('POOL_CLOSED');
    const lease = admission ?? this.budget.reserve(state, bytes);
    if (!this.budget.owns(lease, state, bytes)) throw new Refusal('INVALID_ADMISSION_LEASE');
    let acquired = false; let worker; let reusable = false;
    try {
      await this.acquire(); acquired = true;
      if (this.closed) throw new Refusal('POOL_CLOSED');
      if (signal?.aborted) throw new Refusal('ADMISSION_CANCELLED');
      const kind = stall ? 'stall' : control;
      const filename = { codec: './codec-worker.mjs', stall: './stall-worker.mjs',
        silent: './silent-worker.mjs', exit: './exit-worker.mjs' }[kind];
      if (!filename) throw new Refusal('INVALID_WORKER_CONTROL');
      // Only the ordinary codec worker is kept; failure controls always start their own.
      worker = kind === 'codec' ? this.idle.pop() : undefined;
      if (worker) { worker.ref(); this.running.add(worker); }
      else {
        const limits = { maxOldGenerationSizeMb: CAPS.workerOldMiB,
          maxYoungGenerationSizeMb: CAPS.workerYoungMiB,
          codeRangeSizeMb: CAPS.workerCodeMiB, stackSizeMb: CAPS.workerStackMiB };
        worker = new Worker(new URL(filename, import.meta.url), { resourceLimits: limits });
        this.running.add(worker);
        const ready = await response(worker, 'ready', CAPS.workerBootstrapMs, 'WORKER_BOOTSTRAP_TIMEOUT', signal);
        for (const [key, value] of Object.entries(limits)) {
          if (ready.resourceLimits?.[key] !== value) throw new Refusal('WORKER_RESOURCE_LIMIT_MISMATCH');
        }
        LIMITS.set(worker, ready.resourceLimits);
        // A kept worker that ends on its own leaves the idle list at once.
        const ended = worker;
        ended.once('exit', () => { const index = this.idle.indexOf(ended); if (index >= 0) this.idle.splice(index, 1); });
      }
      const result = response(worker, 'result', CAPS.workerTimeoutMs, 'WORKER_TIMEOUT', signal);
      const copy = Uint8Array.from(bytes);
      worker.postMessage({ state, envelope, bytes: copy.buffer, canWrite }, [copy.buffer]);
      const value = await result;
      reusable = kind === 'codec';
      return { ...value, workerLimits: LIMITS.get(worker) };
    } finally {
      if (worker) {
        this.running.delete(worker);
        if (reusable && !this.closed && this.idle.length < CAPS.workers) { worker.unref(); this.idle.push(worker); }
        else await worker.terminate();
      }
      if (!admission) this.budget.release(lease);
      if (acquired) this.release();
    }
  }
  async close() {
    this.closed = true;
    this.budget.closed = true;
    const waiting=this.waiting.splice(0);this.changed();
    for (const item of waiting) item.reject(new Refusal('POOL_CLOSED'));
    await Promise.all([...this.running, ...this.idle.splice(0)].map((worker) => worker.terminate()));
  }
}
