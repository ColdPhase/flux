import { CAPS } from './caps.mjs';
import { Buffer } from 'node:buffer';
import { Refusal, canonical } from './codec.mjs';
import { persistentEnvelope } from './envelope.mjs';

// A framing candidate for the next actual dispatch gate; not an application protocol.
export function packet(header, chunk) {
  const metadata = Buffer.from(JSON.stringify(header));
  const frame = Buffer.allocUnsafe(4 + metadata.length + chunk.byteLength);
  frame.writeUInt32BE(metadata.length); metadata.copy(frame, 4); frame.set(chunk, 4 + metadata.length);
  return frame;
}
function decode(frame) {
  if (frame.byteLength > CAPS.frameBytes || frame.byteLength < 4) throw new Refusal('FRAME_LIMIT');
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = bytes.readUInt32BE(0);
  if (length > CAPS.frameBytes - CAPS.chunkBytes - 4 || length + 4 > bytes.length) throw new Refusal('HEADER_LIMIT');
  let header;
  try { header = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length))); }
  catch { throw new Refusal('MALFORMED_HEADER'); }
  const chunk = bytes.subarray(4 + length);
  if (chunk.length > CAPS.chunkBytes) throw new Refusal('CHUNK_LIMIT');
  return { header, chunk, intent: persistentEnvelope(header, true) };
}
export class Assemblies {
  constructor() { this.pending = new Map(); this.bytes = 0; }
  intent(connection) { return this.pending.get(connection)?.intent ?? null; }
  remove(connection) {
    const old = this.pending.get(connection);
    if (old) { this.bytes -= old.size + (old.complete?.byteLength ?? 0); this.pending.delete(connection); }
  }
  expire(now) {
    for (const [connection, assembly] of this.pending) {
      if (now - assembly.started >= CAPS.assemblyTimeoutMs) this.remove(connection);
    }
  }
  receive(connection, frame, trustedContext, now) {
    this.expire(now);
    const { header, chunk, intent } = decode(frame);
    const integer = (n) => Number.isSafeInteger(n) && n >= 0;
    if (!integer(header.count) || header.count < 1 || header.count > CAPS.chunks
      || !integer(header.index) || header.index >= header.count) throw new Refusal('CHUNK_INDEX');
    for (const field of Object.keys(intent)) {
      if (Object.hasOwn(trustedContext, field) && canonical(intent[field]) !== canonical(trustedContext[field])) throw new Refusal('ASSEMBLY_CONTEXT');
    }
    const key = canonical(intent);
    let assembly = this.pending.get(connection);
    if (assembly && assembly.key !== key) throw new Refusal('ASSEMBLY_CONNECTION_LIMIT');
    if (!assembly) {
      if (this.pending.size >= CAPS.assembliesPerApi) throw new Refusal('ASSEMBLY_SERVER_LIMIT');
      assembly = { key, intent, count: header.count, started: now, size: 0, parts: new Map() };
      this.pending.set(connection, assembly);
    }
    if (assembly.count !== header.count) throw new Refusal('ASSEMBLY_ALTERED_COUNT');
    const previous = assembly.parts.get(header.index);
    if (previous) {
      if (!previous.equals(chunk)) throw new Refusal('ASSEMBLY_ALTERED_DUPLICATE');
    } else {
      if (assembly.size + chunk.length > CAPS.assemblyBytes
      || this.bytes + chunk.length > CAPS.assembliesBytesPerApi) throw new Refusal('ASSEMBLY_BYTE_LIMIT');
      // Exact backing stores: pooled tiny Buffers would pin a larger uncharged slab.
      const owned = Buffer.allocUnsafeSlow(chunk.length); owned.set(chunk);
      assembly.parts.set(header.index, owned); assembly.size += chunk.length; this.bytes += chunk.length;
    }
    if (assembly.parts.size !== assembly.count) return null;
    if (assembly.complete) return assembly.complete;
    // Charge the contiguous copy before allocating it; four full assemblies may pause honestly.
    if (this.bytes + assembly.size > CAPS.assembliesBytesPerApi) throw new Refusal('ASSEMBLY_COPY_LIMIT');
    const result = Buffer.allocUnsafeSlow(assembly.size);
    let offset = 0;
    for (let index = 0; index < assembly.count; index++) {
      const part = assembly.parts.get(index); result.set(part, offset); offset += part.byteLength;
    }
    Object.defineProperty(result, 'intent', { value: assembly.intent, enumerable: false });
    // The controller retains this charged assembly until the common job budget
    // accepts it. Capacity waits never retain an uncharged promise-tail input.
    assembly.complete = result; this.bytes += result.byteLength; return result;
  }
}
