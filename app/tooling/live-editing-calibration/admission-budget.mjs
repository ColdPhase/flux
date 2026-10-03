import { CAPS } from './caps.mjs';
import { Refusal, stateCharge } from './codec.mjs';

/** One budget shared by registry waiters and codec tasks; a lease is charged once. */
export class AdmissionBudget {
  constructor() { this.bytes = 0; this.leases = new Set(); this.closed = false; }
  reserve(state, bytes) {
    if (this.closed) throw new Refusal('POOL_CLOSED');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > CAPS.assemblyBytes) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    const charge = stateCharge(state);
    if (charge > CAPS.roomCacheBytes) throw new Refusal('ROOM_CACHE_LIMIT');
    const amount = 2 * bytes.byteLength + charge + CAPS.roomCacheBytes;
    if (this.bytes + amount > CAPS.assembliesBytesPerApi) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    if (this.leases.size >= CAPS.workers + CAPS.waitingTasks) throw new Refusal('WORK_QUEUE_LIMIT');
    const lease = { budget: this, state, input: bytes, amount };
    this.leases.add(lease); this.bytes += amount; return lease;
  }
  owns(lease, state, bytes) { return this.leases.has(lease) && lease.state === state && lease.input === bytes; }
  release(lease) {
    if (this.leases.delete(lease)) this.bytes -= lease.amount;
  }
}
