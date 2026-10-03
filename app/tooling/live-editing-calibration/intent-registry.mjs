import { CAPS } from './caps.mjs';
import { Refusal, canonical, fingerprint } from './codec.mjs';
import { setTimeout, clearTimeout } from 'node:timers';
import { AdmissionBudget } from './admission-budget.mjs';
import { persistentEnvelope } from './envelope.mjs';

/** Pure serialized durable-store model, not proof of PostgreSQL transactions/restart. */
export class IntentRegistry {
  constructor(bindings = {}) {
    this.bindings = bindings; this.active = false; this.waiting = [];
    this.budget = new AdmissionBudget(); this.closed = false;
    this.controllers = new Set(); this.operations = new Set();
  }
  acquire(signal) {
    if (this.closed) return Promise.reject(new Refusal('INTENT_REGISTRY_CLOSED'));
    if (signal.aborted) return Promise.reject(new Refusal('ADMISSION_CANCELLED'));
    if (!this.active) { this.active = true; return Promise.resolve(); }
    if (this.waiting.length >= CAPS.waitingTasks) return Promise.reject(new Refusal('INTENT_REGISTRY_QUEUE_LIMIT'));
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(entry.timer); signal.removeEventListener('abort', entry.aborted);
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        if (error) reject(error); else resolve();
      };
      const entry = { finish, timer: null, aborted: null };
      entry.aborted = () => finish(new Refusal('ADMISSION_CANCELLED'));
      entry.timer = setTimeout(() => finish(new Refusal('INTENT_REGISTRY_WAIT_TIMEOUT')), CAPS.admissionWaitMs);
      signal.addEventListener('abort', entry.aborted, { once: true }); this.waiting.push(entry);
    });
  }
  release() {
    const entry = this.waiting[0];
    if (entry) entry.finish(); else this.active = false;
  }
  async run(pool, state, envelope, bytes, options = {}) {
    // Authoritative caller must resolve current access before looking up protected intent data.
    if (options.canWrite === false) throw new Refusal('CURRENT_WRITE_REQUIRED');
    if (this.closed) throw new Refusal('INTENT_REGISTRY_CLOSED');
    // Reserve before hashing or awaiting. The actual pool consumes this same lease,
    // so registry waiters and worker jobs share one count/external-copy budget.
    const budget = pool.budget ?? this.budget;
    const admission = budget.reserve(state, bytes);
    const controller = new globalThis.AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    this.controllers.add(controller);
    let acquired = false;
    try {
      const intent = persistentEnvelope(envelope);
      const key = canonical({ actor: intent.actor, uuid: intent.uuid });
      const digest = fingerprint(intent, bytes);
      await this.acquire(controller.signal); acquired = true;
      if (this.closed) throw new Refusal('INTENT_REGISTRY_CLOSED');
      if (fingerprint(intent, bytes) !== digest) throw new Refusal('ADMISSION_INPUT_CHANGED');
      const binding = this.bindings[key];
      if (binding && binding.fingerprint !== digest) throw new Refusal('EDITING_IDEMPOTENCY_CONFLICT');
      const operation = pool.run(state, intent, bytes, { ...options,
        admission: pool.budget ? admission : undefined, signal: controller.signal });
      this.operations.add(operation);
      let result;
      try { result = await operation; } finally { this.operations.delete(operation); }
      if (result.ok && (result.receipt.fingerprint !== digest || fingerprint(intent, bytes) !== digest)) throw new Refusal('ADMISSION_INPUT_CHANGED');
      if (result.ok && !binding) {
        const next = { ...this.bindings, [key]: { fingerprint: digest, namespace: {
          workspace: intent.workspace, kind: intent.kind, room: intent.room,
          generation: intent.generation, actor: intent.actor,
          operation: intent.operation, uuid: intent.uuid }, receipt: result.receipt } };
        if (2 * JSON.stringify(next).length > CAPS.intentRegistryBytes) throw new Refusal('INTENT_REGISTRY_LIMIT');
        // In SQL this and the room result must commit atomically under the agreed locks.
        // A rejected provisional result never changes either authoritative fixture input.
        this.bindings = next;
      }
      return result;
    } finally {
      if (acquired) this.release();
      options.signal?.removeEventListener('abort', cancel);
      this.controllers.delete(controller); budget.release(admission);
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.operations]);
  }
}
