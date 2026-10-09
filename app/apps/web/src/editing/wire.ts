import { EDITING_LIMITS, EDITING_SOCKET_PATH, type EditingClientMessage, type EditingServerMessage, type LiveMapDelta, type LiveMapDeltaChunk, type LivePreviewChunk, type LiveUpdateChunk, type WikiTextEnvelope } from '@flux/contracts';

export const encode64 = (bytes: Uint8Array): string => {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(result);
};
export const decode64 = (encoded: string): Uint8Array => {
  if (encoded.length > Math.ceil(EDITING_LIMITS.assemblyBytes / 3) * 4 + 4) throw new Error('Live update is too large');
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
};

export type ReceivedEditing = EditingServerMessage | (LiveUpdateChunk & { bytes: Uint8Array });
type Chunk = LiveUpdateChunk | LiveMapDeltaChunk | LivePreviewChunk;
type Assembly = { header: Chunk; chunks: Uint8Array[]; bytes: number; deadline: number };

/** One bounded same-origin connection. Durable pending intents belong to its caller, not a socket. */
export class EditingConnection {
  readonly socket: WebSocket;
  private assemblies = new Map<string, Assembly>();
  private outbound: (ArrayBuffer | string)[] = [];
  private queuedBytes = 0;
  private timer: number;
  private stopped = false;
  constructor(kind: 'wiki' | 'map', id: string, generation: string, afterSequence: number,
    private receive: (message: ReceivedEditing) => void, private disconnected: () => void) {
    const url = new URL(EDITING_SOCKET_PATH, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('kind', kind);
    url.searchParams.set('id', id);
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    // The subscription must precede anything queued while the socket was still connecting (a cursor
    // or a text intent): the server refuses both before it, so it goes to the head of the queue.
    this.socket.onopen = () => {
      const subscribe = JSON.stringify({ type: 'subscribe', generation, afterSequence });
      this.outbound.unshift(subscribe); this.queuedBytes += new TextEncoder().encode(subscribe).length;
      this.pump();
    };
    this.socket.onmessage = (event) => {
      try {
        if (typeof event.data === 'string') {
          if (new TextEncoder().encode(event.data).byteLength > EDITING_LIMITS.frameBytes) throw new Error('Large live frame');
          this.receive(JSON.parse(event.data) as EditingServerMessage);
        } else if (event.data instanceof ArrayBuffer) this.binary(event.data);
        else throw new Error('Unexpected live frame');
      } catch { this.close(); this.disconnected(); }
    };
    this.socket.onclose = () => { if (!this.stopped) { this.close(); this.disconnected(); } };
    this.timer = window.setInterval(() => {
      if ([...this.assemblies.values()].some((assembly) => assembly.deadline < Date.now())) {
        this.close(); this.disconnected(); return;
      }
      this.pump();
    }, 20);
  }
  private binary(frame: ArrayBuffer) {
    if (frame.byteLength < 5 || frame.byteLength > EDITING_LIMITS.frameBytes) throw new Error('Invalid live frame');
    const length = new DataView(frame).getUint32(0);
    if (length > 4096 || length + 4 > frame.byteLength) throw new Error('Invalid live header');
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(frame, 4, length))) as Chunk;
    if ((header.type !== 'update' && header.type !== 'map-delta' && header.type !== 'preview') || !Number.isInteger(header.count) || header.count < 1 || header.count > EDITING_LIMITS.chunks || !Number.isInteger(header.index) || header.index < 0 || header.index >= header.count || typeof header.deliveryId !== 'string') throw new Error('Invalid live chunk');
    const bytes = new Uint8Array(frame.slice(4 + length));
    if (bytes.length > EDITING_LIMITS.chunkBytes) throw new Error('Large live chunk');
    let assembly = this.assemblies.get(header.deliveryId);
    if (!assembly) {
      if (header.index !== 0 || this.assemblies.size >= 4) throw new Error('Unexpected live assembly');
      assembly = { header, chunks: [], bytes: 0, deadline: Date.now() + EDITING_LIMITS.assemblyTimeoutMs };
      this.assemblies.set(header.deliveryId, assembly);
    }
    const immutable = (value: Chunk) => JSON.stringify({ ...value, index: 0 });
    if (immutable(header) !== immutable(assembly.header) || header.index !== assembly.chunks.length) throw new Error('Changed live assembly');
    if ([...this.assemblies.values()].reduce((total, value) => total + value.bytes, 0) + bytes.length > EDITING_LIMITS.assemblyBytes) throw new Error('Live assembly capacity');
    assembly.chunks.push(bytes); assembly.bytes += bytes.length;
    this.send({ type: 'received', deliveryId: header.deliveryId, index: header.index });
    if (assembly.chunks.length !== header.count) return;
    this.assemblies.delete(header.deliveryId);
    const joined = new Uint8Array(assembly.bytes);
    let offset = 0;
    for (const chunk of assembly.chunks) { joined.set(chunk, offset); offset += chunk.length; }
    if (header.type === 'update') this.receive({ ...header, bytes: joined });
    else if (header.type === 'map-delta') {
      const delta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as LiveMapDelta;
      if (delta.generation !== header.generation || delta.sequence !== header.sequence || delta.commandId !== header.commandId) throw new Error('Changed map delivery');
      this.receive({ ...delta, type: 'map-delta' });
    } else {
      const preview = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as { html: string; mentions: Extract<EditingServerMessage, { type: 'preview' }>['mentions'] };
      if (typeof preview.html !== 'string' || !Array.isArray(preview.mentions)) throw new Error('Invalid preview delivery');
      this.receive({ type: 'preview', generation: header.generation, sequence: header.sequence, hash: header.hash, html: preview.html, mentions: preview.mentions });
    }
  }
  send(message: EditingClientMessage) { return this.enqueue(JSON.stringify(message)); }
  text(envelope: WikiTextEnvelope, bytes: Uint8Array) {
    if (this.stopped) return false;
    const count = Math.max(1, Math.ceil(bytes.length / EDITING_LIMITS.chunkBytes));
    if (bytes.length > EDITING_LIMITS.assemblyBytes || count > EDITING_LIMITS.chunks) return false;
    const frames: ArrayBuffer[] = [];
    for (let index = 0; index < count; index++) {
      const header = new TextEncoder().encode(JSON.stringify({ ...envelope, index, count }));
      const chunk = bytes.subarray(index * EDITING_LIMITS.chunkBytes, (index + 1) * EDITING_LIMITS.chunkBytes);
      const frame = new ArrayBuffer(4 + header.length + chunk.length);
      new DataView(frame).setUint32(0, header.length);
      new Uint8Array(frame, 4, header.length).set(header);
      new Uint8Array(frame, 4 + header.length).set(chunk);
      frames.push(frame);
    }
    const size = frames.reduce((total, frame) => total + frame.byteLength, 0);
    if (this.queuedBytes + size > EDITING_LIMITS.outputWindowBytes) return false;
    for (const frame of frames) if (!this.enqueue(frame)) return false;
    return true;
  }
  private enqueue(frame: ArrayBuffer | string) {
    if (this.stopped) return false;
    const size = typeof frame === 'string' ? new TextEncoder().encode(frame).length : frame.byteLength;
    if (size > EDITING_LIMITS.frameBytes || this.queuedBytes + size > EDITING_LIMITS.outputWindowBytes) return false;
    this.outbound.push(frame); this.queuedBytes += size; this.pump(); return !this.stopped;
  }
  private pump() {
    while (this.socket.readyState === WebSocket.OPEN && this.outbound.length) {
      const frame = this.outbound[0]!;
      const size = typeof frame === 'string' ? new TextEncoder().encode(frame).length : frame.byteLength;
      if (this.socket.bufferedAmount + size > EDITING_LIMITS.outputWindowBytes) return;
      this.outbound.shift(); this.queuedBytes -= size;
      try { this.socket.send(frame); }
      catch { this.close(); this.disconnected(); return; }
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true; window.clearInterval(this.timer);
    this.assemblies.clear(); this.outbound = []; this.queuedBytes = 0;
    this.socket.onmessage = null; this.socket.onopen = null; this.socket.onclose = null;
    this.socket.close();
  }
}
