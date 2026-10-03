import { CAPS } from './caps.mjs';
import { Refusal, canonical, fingerprint } from './codec.mjs';

/** Pure serialized durable-store model, not proof of PostgreSQL transactions/restart. */
export class IntentRegistry {
  constructor(bindings = {}) { this.bindings = bindings; this.tail = Promise.resolve(); }
  async run(pool, state, envelope, bytes, options = {}) {
    // Authoritative caller must resolve current access before looking up protected intent data.
    if (options.canWrite === false) throw new Refusal('CURRENT_WRITE_REQUIRED');
    const key = canonical({ actor: envelope.actor, uuid: envelope.uuid });
    const digest = fingerprint(envelope, bytes);
    const previous = this.tail; let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const binding = this.bindings[key];
      if (binding && binding.fingerprint !== digest) throw new Refusal('EDITING_IDEMPOTENCY_CONFLICT');
      const result = await pool.run(state, envelope, bytes, options);
      if (result.ok && !binding) {
        const next = { ...this.bindings, [key]: { fingerprint: digest, namespace: {
          workspace: envelope.workspace, kind: envelope.kind, room: envelope.room,
          generation: envelope.generation, actor: envelope.actor,
          operation: envelope.operation, uuid: envelope.uuid }, receipt: result.receipt } };
        if (2 * JSON.stringify(next).length > CAPS.intentRegistryBytes) throw new Refusal('INTENT_REGISTRY_LIMIT');
        // In SQL this and the room result must commit atomically under the agreed locks.
        // A rejected provisional result never changes either authoritative fixture input.
        this.bindings = next;
      }
      return result;
    } finally { release(); }
  }
}
