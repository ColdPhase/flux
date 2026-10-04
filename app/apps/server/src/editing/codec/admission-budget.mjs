import { CAPS } from './caps.mjs';
import { Refusal, stateCharge } from './codec.mjs';

/** One budget shared by registry waiters and codec tasks; a lease is charged once. */
export class AdmissionBudget {
  constructor(changed = () => {}) { this.bytes = 0; this.leases = new Set(); this.closed = false; this.capacity = new Set(); this.changed = changed; }
  allocate(state, reservedCharge, bytes, maximumInputBytes = null, metadataBytes = 0, queued = false) {
    if (this.closed) throw new Refusal('POOL_CLOSED');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > CAPS.assemblyBytes) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    // Keeping a view also keeps its entire backing store alive. A resizable/growable
    // store reserves its maximum capacity so a later grow cannot escape this lease.
    const backing = bytes.buffer.maxByteLength ?? bytes.buffer.byteLength;
    if (backing > CAPS.assemblyBytes) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    const charge = reservedCharge ?? stateCharge(state);
    if (charge > CAPS.roomCacheBytes) throw new Refusal('ROOM_CACHE_LIMIT');
    const inputCapacity = maximumInputBytes ?? backing;
    if (!Number.isSafeInteger(inputCapacity) || inputCapacity < backing || inputCapacity > CAPS.assemblyBytes) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes < 0 || metadataBytes > 65536) throw new Refusal('ADMISSION_METADATA_LIMIT');
    const amount = inputCapacity + (maximumInputBytes ?? bytes.byteLength) + metadataBytes + (queued ? 0 : charge + CAPS.roomCacheBytes);
    if (this.bytes + amount > CAPS.assembliesBytesPerApi) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    if (this.leases.size >= CAPS.workers + CAPS.waitingTasks) throw new Refusal('WORK_QUEUE_LIMIT');
    const lease = { budget: this, state, input: bytes, amount, inputCapacity, charge: queued ? 0 : charge, metadataBytes, queued };
    this.leases.add(lease); this.bytes += amount; this.changed(); return lease;
  }
  reserve(state, bytes) { return this.allocate(state, null, bytes); }
  // Current SQL state is not loaded yet. Charge its maximum before any protected
  // read/intent wait, then bind/shrink only after the serialized row is established.
  reservePending(bytes, maximumInputBytes = null) {
    return this.allocate(null, CAPS.roomCacheBytes, bytes, maximumInputBytes);
  }
  reserveQueued(bytes, metadataBytes, maximumInputBytes = null) {
    return this.allocate(null, CAPS.roomCacheBytes, bytes, maximumInputBytes, metadataBytes, true);
  }
  promote(lease) {
    if (!this.leases.has(lease) || !lease.queued || lease.state !== null) throw new Refusal('INVALID_ADMISSION_LEASE');
    const addition = 2 * CAPS.roomCacheBytes;
    if (this.bytes + addition > CAPS.assembliesBytesPerApi) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    this.bytes += addition; lease.amount += addition; lease.charge = CAPS.roomCacheBytes; lease.queued = false; this.changed();
  }
  replaceInput(lease, bytes) {
    if (!this.leases.has(lease) || lease.queued || lease.state !== null) throw new Refusal('INVALID_ADMISSION_LEASE');
    if (!(bytes instanceof Uint8Array) || (bytes.buffer.maxByteLength ?? bytes.buffer.byteLength) > lease.inputCapacity) throw new Refusal('EXTERNAL_BUFFER_LIMIT');
    // The pre-reserved capacity covers this allocation and its transferable copy.
    lease.input = bytes;
  }
  bind(lease, state) {
    if (!this.leases.has(lease) || lease.queued || lease.state !== null) throw new Refusal('INVALID_ADMISSION_LEASE');
    const charge = stateCharge(state);
    if (charge > lease.charge) throw new Refusal('ROOM_CACHE_LIMIT');
    const backing = lease.input.buffer.maxByteLength ?? lease.input.buffer.byteLength;
    const amount = backing + lease.input.byteLength + charge + CAPS.roomCacheBytes + lease.metadataBytes;
    this.bytes -= lease.amount - amount;
    lease.state = state; lease.charge = charge; lease.amount = amount;
    this.changed(); this.notify();
  }
  onCapacity(callback) { this.capacity.add(callback); return () => this.capacity.delete(callback); }
  notify() { for (const callback of this.capacity) callback(); }
  owns(lease, state, bytes) { return this.leases.has(lease) && !lease.queued && lease.state === state && lease.input === bytes; }
  release(lease) {
    if (this.leases.delete(lease)) { this.bytes -= lease.amount; this.changed(); this.notify(); }
  }
}
