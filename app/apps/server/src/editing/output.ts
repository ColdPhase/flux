import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { EDITING_LIMITS, type LiveMapDeltaChunk, type LivePreviewChunk, type LiveUpdateChunk } from '@flux/contracts';

export class EditingOutputError extends Error {
  constructor(readonly code: 'EDITING_OUTPUT_CAPACITY' | 'EDITING_OUTPUT_CLOSED' | 'EDITING_OUTPUT_FRAME_LIMIT' | 'INVALID_DELIVERY_ACK') { super(code); }
}

/** Payloads plus every outstanding ws-owned frame share this API-wide hard limit. */
export class EditingOutputBudget {
  bytes = 0;
  private capacity = new Set<() => void>();
  onCapacity(callback: () => void) { this.capacity.add(callback); return () => { this.capacity.delete(callback); }; }
  lease(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytes + bytes > 32 * 1024 * 1024) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    this.bytes += bytes; let amount = bytes; let released = false;
    return {
      get bytes() { return amount; },
      resize: (next: number) => {
        if (released) throw new EditingOutputError('EDITING_OUTPUT_CLOSED');
        if (!Number.isSafeInteger(next) || next < 0 || this.bytes + next - amount > 32 * 1024 * 1024) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
        const difference = next - amount; this.bytes += difference; amount = next;
        if (difference < 0) for (const callback of this.capacity) callback();
      },
      release: () => { if (!released) { released = true; this.bytes -= amount; amount = 0; for (const callback of this.capacity) callback(); } },
    };
  }
  reserve(bytes: number) { return this.lease(bytes).release; }
}
type Header = Omit<LiveUpdateChunk, 'deliveryId' | 'index' | 'count'> | Omit<LivePreviewChunk, 'deliveryId' | 'index' | 'count'> | Omit<LiveMapDeltaChunk, 'deliveryId' | 'index' | 'count'>;
interface Delivery {
  id: string; header: Header; payload: Uint8Array; release: () => void; count: number; next: number;
  pending: Map<number, { release: () => void; size: number }>; acknowledged: Set<number>; completed: () => void;
}
/** One bounded delivery per connection, exact chunks and a finite acknowledgment window. No unbounded output queue. */
export class EditingOutput {
  private delivery: Delivery | null = null;
  private frameBytes = 0;
  private wire = new Set<() => void>();
  private closed = false;
  private timeout: NodeJS.Timeout | null = null;
  constructor(private socket: WebSocket, private budget: EditingOutputBudget) {}
  get busy() { return this.delivery !== null; }
  get canPump() { const d = this.delivery; return !!d && d.next < d.count && this.frameBytes + this.socket.bufferedAmount + EDITING_LIMITS.frameBytes <= EDITING_LIMITS.outputWindowBytes; }
  sendJSON(value: unknown) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new EditingOutputError('EDITING_OUTPUT_CLOSED');
    const text = JSON.stringify(value); const size = Buffer.byteLength(text);
    if (size > EDITING_LIMITS.frameBytes || this.socket.bufferedAmount + this.frameBytes + size > EDITING_LIMITS.outputWindowBytes) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    const release = this.budget.reserve(2 * text.length + size);
    try { this.socket.send(text, { compress: false }, () => release()); }
    catch (error) { release(); throw error; }
  }
  send(header: Header, payload: Uint8Array, completed: () => void) {
    const backing = (payload.buffer as ArrayBuffer & { maxByteLength?: number }).maxByteLength ?? payload.buffer.byteLength;
    if (payload.byteLength > EDITING_LIMITS.assemblyBytes || backing > EDITING_LIMITS.assemblyBytes) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    this.begin(header,payload,this.budget.reserve(backing),completed);
  }
  /** The caller charges its source objects/JSON text; Output reserves owned bytes BEFORE allocation. */
  sendJSONPayload(header: Header, text: string, completed: () => void) {
    const bytes = Buffer.byteLength(text);
    if (bytes > EDITING_LIMITS.assemblyBytes) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
    const release = this.budget.reserve(bytes); let payload: Buffer;
    try { payload = Buffer.allocUnsafeSlow(bytes); payload.write(text); }
    catch (error) { release(); throw error; }
    this.begin(header,payload,release,completed);
  }
  private begin(header: Header, payload: Uint8Array, releasePayload: () => void, completed: () => void) {
    let releaseMetadata = () => {};
    try {
      if (this.closed || this.busy || this.socket.readyState !== WebSocket.OPEN) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
      const count = Math.max(1, Math.ceil(payload.byteLength / EDITING_LIMITS.chunkBytes));
      if (count > EDITING_LIMITS.chunks) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
      releaseMetadata = this.budget.reserve(2 * JSON.stringify(header).length + 256 + count * 128);
      const release = () => { releasePayload(); releaseMetadata(); };
      this.delivery = { id: randomUUID(), header, payload, release, count, next: 0, pending: new Map(), acknowledged: new Set(), completed };
      this.timeout = setTimeout(() => { this.close(); this.socket.terminate(); }, 10_000); this.timeout.unref();
      try { this.pump(); } catch (error) { this.close(); throw error; }
    } catch (error) { releasePayload(); releaseMetadata(); throw error; }
  }
  /** Validation is synchronous; chunk acknowledgment alone never hands protected bytes to a socket. */
  received(deliveryId: string, index: number) {
    const d = this.delivery;
    if (!d || d.id !== deliveryId || !Number.isSafeInteger(index) || index < 0 || index >= d.count) throw new EditingOutputError('INVALID_DELIVERY_ACK');
    const frame = d.pending.get(index);
    if (!frame) { if (d.acknowledged.has(index)) return; throw new EditingOutputError('INVALID_DELIVERY_ACK'); }
    frame.release(); this.frameBytes -= frame.size; d.pending.delete(index); d.acknowledged.add(index);
    if (d.acknowledged.size === d.count) {
      d.release(); this.delivery = null;
      if (this.timeout) clearTimeout(this.timeout); this.timeout = null;
      d.completed();
    }
  }
  /** Must be called only by an authority-protected synchronous handoff, including after an ACK frees capacity. */
  pump() {
    const d = this.delivery;
    if (!d || this.closed) return false;
    if (d.next < d.count) {
      const index = d.next; const chunk = d.payload.subarray(index * EDITING_LIMITS.chunkBytes, (index + 1) * EDITING_LIMITS.chunkBytes);
      const text = JSON.stringify({ ...d.header, deliveryId: d.id, index, count: d.count });
      const length = 4 + Buffer.byteLength(text) + chunk.byteLength;
      if (length > EDITING_LIMITS.frameBytes) throw new EditingOutputError('EDITING_OUTPUT_FRAME_LIMIT');
      if (this.frameBytes + this.socket.bufferedAmount + length > EDITING_LIMITS.outputWindowBytes) return false;
      let releaseWire = () => {}; let releaseText = () => {}; let releaseAck = () => {};
      const wireDone = () => { releaseWire(); this.wire.delete(wireDone); };
      try {
        releaseWire = this.budget.reserve(length); releaseText = this.budget.reserve(2 * text.length); releaseAck = this.budget.reserve(128);
        this.wire.add(wireDone);
        const frame = Buffer.allocUnsafeSlow(length);
        const metadataLength = Buffer.byteLength(text); frame.writeUInt32BE(metadataLength); frame.write(text, 4, metadataLength); frame.set(chunk, 4 + metadataLength);
        d.pending.set(index, { release: releaseAck, size: length }); this.frameBytes += length; d.next++;
        this.socket.send(frame, { binary: true, compress: false }, (error) => { wireDone(); if (error) this.close(); });
      } catch (error) { wireDone(); releaseAck(); this.close(); throw error; }
      finally { releaseText(); }
      return true;
    }
    return false;
  }
  close() {
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout); this.timeout = null;
    const d = this.delivery; this.delivery = null;
    if (d) { d.release(); for (const frame of d.pending.values()) frame.release(); }
    this.frameBytes = 0;
    // Outstanding wire copies remain charged until their actual send callbacks, including after close/termination.
  }
}

/** One process hosts one API; all its live protocols and native live journals share this hard budget. */
export const apiEditingOutputBudget = new EditingOutputBudget();
