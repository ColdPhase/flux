import { createHash } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { DomainError, ServiceUnavailableError, type MapCancel, type MapMove, type MapPresence, type MapTransient } from '@flux/core';
import { EditingTransactionError } from '@flux/db';
import { EDITING_LIMITS, SKETCH_LIMITS } from '@flux/contracts';
import type { EditingContext } from './gate.js';
import { editingMapContextCharge } from './context-charge.js';
import { EditingOutput, EditingOutputBudget } from './output.js';
import type { MapAuthority } from './map-authority.js';
import { editingResourcesChanged } from './resource-observation.js';
import type { EditingQueueTelemetry } from './telemetry.js';

type Command = { type: 'map-move'; command: MapMove } | { type: 'map-cancel'; command: MapCancel } | { type: 'map-presence'; command: MapPresence };
interface Retained { value: Command; release: () => void; expiresAt: number; rawBytes: number }
interface Connection {
  context: EditingContext; socket: WebSocket; output: EditingOutput; generation: string | null;
  sequence: number; subscribed: boolean; closed: boolean; reading: boolean; pendingRead: boolean;
  working: boolean; movement: Retained | null; presence: Retained | null; releaseBase: () => void;
  lastHead: string; transient: Map<string, { hash: string; release: () => void }>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const signature = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = (error: unknown) => error instanceof DomainError ? error.code : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'EDITING_UNAVAILABLE';
const capacity = (error: unknown) => ['EDITING_OUTPUT_CAPACITY', 'EDITING_OUTPUT_CLOSED', 'EDITING_MAP_CAPACITY', 'EDITING_PRESENCE_CAPACITY'].includes(code(error));
const invalid = (message: string) => new DomainError(400, 'EDITING_MESSAGE_INVALID', message);
function closed(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !fields.includes(key))) throw invalid('Closed map message required');
}
const id = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const integer = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
function movement(value: Record<string, unknown>): MapMove {
  closed(value, ['type','generation','gestureId','leaseId','sequence','positions']);
  if (!id(value.generation) || !id(value.gestureId) || !id(value.leaseId) || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) || !Array.isArray(value.positions) || !value.positions.length || value.positions.length > EDITING_LIMITS.movedThoughts) throw invalid('Invalid movement');
  const seen = new Set<string>();
  for (const position of value.positions) {
    closed(position, ['id','x','y','width','height']);
    if (!id(position.id) || seen.has(position.id) || !integer(position.x, -SKETCH_LIMITS.coordinate, SKETCH_LIMITS.coordinate) || !integer(position.y, -SKETCH_LIMITS.coordinate, SKETCH_LIMITS.coordinate)
      || position.width !== undefined && !integer(position.width, SKETCH_LIMITS.minWidth, SKETCH_LIMITS.maxWidth) || position.height !== undefined && !integer(position.height, SKETCH_LIMITS.minHeight, SKETCH_LIMITS.maxHeight)) throw invalid('Invalid movement position');
    seen.add(position.id);
  }
  return { generation: value.generation, gestureId: value.gestureId, leaseId: value.leaseId, sequence: value.sequence, positions: value.positions as MapMove['positions'] };
}
function presence(value: Record<string, unknown>): MapPresence {
  closed(value, ['type','generation','selected','cursor']);
  if (!id(value.generation) || !Array.isArray(value.selected) || value.selected.length > EDITING_LIMITS.selectedThoughts || value.selected.some((item) => !id(item)) || new Set(value.selected).size !== value.selected.length) throw invalid('Invalid map presence');
  if (value.cursor !== null) { closed(value.cursor, ['x','y']); if (!integer(value.cursor.x, -SKETCH_LIMITS.coordinate, SKETCH_LIMITS.coordinate) || !integer(value.cursor.y, -SKETCH_LIMITS.coordinate, SKETCH_LIMITS.coordinate)) throw invalid('Invalid presence cursor'); }
  return { generation: value.generation, selected: value.selected as string[], cursor: value.cursor as MapPresence['cursor'] };
}
const transientKey = (value: MapTransient) => value.type === 'map-presence' ? `presence:${value.connectionId}` : `lease:${value.leaseId}`;

/** Every protected frame uses the current SQL fence; only replaceable transient intents coalesce. */
export function mapController(authority: MapAuthority, outputBudget: EditingOutputBudget,telemetry?:()=>EditingQueueTelemetry|null) {
  const connections = new Map<string, Connection>();
  /** Per room, the connection whose movement, cancel or presence committed last here. */
  const lastProducer = new Map<string, Connection>();
  const operations=new Set<Promise<void>>();let pendingMovement=0,pendingPresence=0;
  function operation(){let finish=()=>{};const done=new Promise<void>(resolve=>{finish=resolve;});operations.add(done);editingResourcesChanged();return()=>{operations.delete(done);editingResourcesChanged();finish();};}
  let closing = false;
  function close(c: Connection) {
    if (c.closed) return;
    c.closed = true; c.releaseBase(); c.movement?.release(); c.presence?.release();if(c.movement)pendingMovement--;if(c.presence)pendingPresence--; c.movement = null; c.presence = null;
    for (const entry of c.transient.values()) entry.release(); c.transient.clear(); c.output.close(); connections.delete(c.context.connectionId);if(lastProducer.get(c.context.target.id)===c)lastProducer.delete(c.context.target.id);editingResourcesChanged();
    const completed=operation();void authority.disconnect(c.context.session, c.context.target.id, c.context.connectionId).catch(() => { /* SQL expiry independently removes abandoned previews. */ }).finally(completed);
  }
  function fail(c: Connection, error: unknown) {
    if (c.closed) return;
    if (code(error) === 'UNAUTHENTICATED' || error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      try { c.output.sendJSON({ type: 'revoked' }); } catch { /* Nothing protected follows denial. */ }
      c.socket.close(1008, 'Access ended'); close(c); return;
    }
    const unknown = error instanceof EditingTransactionError && error.outcome === 'unknown';
    try { c.output.sendJSON({ type: 'error', code: code(error), outcome: unknown ? 'unknown' : 'refused', retryable: unknown || capacity(error) }); }
    catch { c.socket.terminate(); close(c); }
  }
  /**
   * A room's reads after its NOTIFY. Every map operation locks the room's head row, so reads take
   * turns: the people who do not have the change yet go first, and the connection whose movement
   * or presence it is goes last, since its read only carries back its own echo (#228 Gate 4).
   * Its operation is still running, or it is the room's latest local producer.
   */
  function notify(sketchId: string) {
    const room = [...connections.values()].filter((c) => c.context.target.id === sketchId);
    const producer = (c: Connection) => c.working || lastProducer.get(sketchId) === c;
    for (const c of room) if (!producer(c)) void catchup(c);
    for (const c of room) if (producer(c)) void catchup(c);
  }
  async function catchup(c: Connection) {
    if (c.closed || !c.subscribed || !c.generation) return;
    if (c.reading) { c.pendingRead = true; return; }
    c.reading = true;const completed=operation();
    try {
      do {
        c.pendingRead = false;
        if (c.output.busy) {
          // A retained large payload must not need a second 24MiB result reservation
          // to make progress. Each next chunk only needs the fresh native read fence.
          await authority.authorize(c.context.session, c.context.target.id, () => {
            if (!c.closed) c.pendingRead = c.output.pump() && c.output.canPump;
          });
          continue;
        }
        await authority.deliver(c.context.session, c.context.target.id, c.generation, c.sequence, (result, preparation) => {
          if (c.closed) return;
          const head = { type: 'head', kind: 'map', generation: result.generation, sequence: result.sequence, hash: result.hash,
            workspaceId: result.workspaceId, resourceId: result.resourceId, actor: result.actor, canWrite: result.canWrite };
          const current = signature({ generation: result.generation, actor: result.actor, canWrite: result.canWrite });
          if (current !== c.lastHead) { c.output.sendJSON(head); c.lastHead = current; c.pendingRead = true; return; }
          // Ordered durable changes cannot wait for continuously renewed previews
          // to become quiet. Their own clearedLeaseIds remove affected overlays.
          if (result.delta) {
            if (result.delta.sequence !== c.sequence + 1) throw new DomainError(409, 'EDITING_SEQUENCE_GAP', 'A current map snapshot is required');
            const sequence = result.delta.sequence;
            telemetry?.()?.schedule('map',{resourceId:result.resourceId,generation:result.generation,commandId:result.delta.commandId,confirmedSequence:sequence});
            const payload = preparation.encode(result.delta);
            c.output.sendJSONPayload({ type: 'map-delta', generation: result.generation, sequence, commandId: result.delta.commandId }, payload,
              () => { c.sequence = sequence; void catchup(c); });
            c.pendingRead = c.output.canPump; return;
          }
          // Every transient change this protected read observed goes out from it: cleared leases
          // first, then changed previews and presence. A later change arrives as a new read (its
          // NOTIFY, or the 250 ms timer); a full output window ends this read and the timer retries.
          const active = new Set(result.transient.map(transientKey));
          for (const key of [...c.transient.keys()]) if (!active.has(key)) {
            if (key.startsWith('lease:')) c.output.sendJSON({ type: 'map-clear', generation: result.generation, leaseId: key.slice(6) });
            c.transient.get(key)!.release(); c.transient.delete(key);
          }
          for (const item of result.transient) {
            const key = transientKey(item), hash = signature(item);
            const old = c.transient.get(key);
            if (old?.hash === hash) continue;
            const release = old?.release ?? outputBudget.reserve(512);
            try { c.output.sendJSON(item); c.transient.set(key, { hash, release }); }
            catch (error) { if (!old) release(); throw error; }
          }
        });
      } while (c.pendingRead && !c.closed);
    } catch (error) {
      if (code(error) === 'EDITING_SEQUENCE_GAP' || code(error) === 'EDITING_GENERATION_CHANGED') {
        try { c.output.sendJSON({ type: 'resync', reason: code(error) === 'EDITING_SEQUENCE_GAP' ? 'gap' : 'generation', generation: c.generation }); }
        catch { /* Closed/backpressured clients recover through their next atomic bootstrap. */ }
        c.socket.close(1008, 'Snapshot required'); close(c);
      } else if (!capacity(error)) fail(c, error);
      // Capacity retries hold no extra prepared result or unbounded catch-up promises.
    } finally { c.reading = false;completed(); }
  }
  function work(c: Connection) {
    if (c.closed || c.working) return;
    const retained = c.movement ?? c.presence;
    if (!retained) return;
    if (retained === c.movement) {c.movement = null;pendingMovement--;} else {c.presence = null;pendingPresence--;}editingResourcesChanged();
    if (retained.expiresAt <= Date.now()) { retained.release(); fail(c, new ServiceUnavailableError('The transient input expired before admission', 'EDITING_MAP_CAPACITY')); work(c); return; }
    c.working = true;const completed=operation();
    const command = retained.value;
    const action = command.type === 'map-move' ? authority.move(c.context.session, c.context.target.id, c.context.connectionId, command.command, retained.rawBytes)
      : command.type === 'map-cancel' ? authority.cancel(c.context.session, c.context.target.id, c.context.connectionId, command.command, retained.rawBytes)
      : authority.presence(c.context.session, c.context.target.id, c.context.connectionId, command.command, retained.rawBytes);
    // The authority synchronously reserves its own operation before its first await.
    retained.release();
    void action.then(() => {
      if(command.type==='map-move')telemetry?.()?.schedule('map',{resourceId:c.context.target.id,generation:command.command.generation,interactionId:command.command.gestureId,inputSequence:command.command.sequence});
      // Its transaction's own NOTIFY starts the room's reads, once: a second, local wakeup made every
      // connection read the same change twice, and reads queue on the room's head row (#228 Gate 4).
      lastProducer.set(c.context.target.id, c);
    }, (error: unknown) => fail(c, error)).finally(() => { c.working = false;completed(); work(c); });
  }
  function enqueue(c: Connection, value: Command, rawBytes: number) {
    const slot = value.type === 'map-presence' ? 'presence' : 'movement';
    const old = c[slot];
    if (old && value.type === 'map-move' && (old.value.type !== 'map-move' || old.value.command.leaseId !== value.command.leaseId || old.value.command.gestureId !== value.command.gestureId || old.value.command.generation !== value.command.generation || old.value.command.sequence >= value.command.sequence)) throw invalid('A queued preview may only be replaced by its newer same-lease position');
    if (old && value.type === 'map-cancel' && old.value.type !== 'map-presence' && (old.value.command.leaseId !== value.command.leaseId || old.value.command.gestureId !== value.command.gestureId || old.value.command.generation !== value.command.generation)) throw invalid('Cancellation must match the queued lease');
    const release = outputBudget.reserve(rawBytes + editingMapContextCharge({ context: c.context, value }));
    c[slot] = { value, release, expiresAt: Date.now() + 5000, rawBytes };
    if(!old){if(slot==='movement')pendingMovement++;else pendingPresence++;}editingResourcesChanged();
    old?.release(); work(c);
  }
  const timer = setInterval(() => {
    for (const c of connections.values()) { work(c); void catchup(c); }
  }, 250); timer.unref();
  return {
    accept(socket: WebSocket, context: EditingContext) {
      if (closing || context.target.kind !== 'map') { socket.close(1008, 'Unavailable'); return; }
      const c: Connection = { context, socket, output: new EditingOutput(socket, outputBudget), generation: null, sequence: 0,
        subscribed: false, closed: false, reading: false, pendingRead: false, working: false, movement: null, presence: null,
        releaseBase: outputBudget.reserve(2048 + editingMapContextCharge(context)), lastHead: '', transient: new Map() };
      connections.set(context.connectionId, c);editingResourcesChanged(); socket.once('close', () => close(c));
      socket.on('message', (data: RawData, binary) => {
        if (c.closed) return;
        try {
          if (binary || !Buffer.isBuffer(data) || data.byteLength > EDITING_LIMITS.frameBytes) throw invalid('Bounded JSON map frames required');
          const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
          closed(message, ['type','generation','afterSequence','deliveryId','index','gestureId','leaseId','sequence','positions','selected','cursor']);
          if (message.type === 'subscribe') {
            closed(message, ['type','generation','afterSequence']);
            if (c.subscribed || !id(message.generation) || !integer(message.afterSequence, 0, Number.MAX_SAFE_INTEGER)) throw invalid('Invalid map subscription');
            c.generation = message.generation; c.sequence = message.afterSequence; c.subscribed = true; void catchup(c); return;
          }
          if (!c.subscribed || !c.generation) throw invalid('Subscribe before a map action');
          if (message.type === 'received') {
            closed(message, ['type','deliveryId','index']);
            if (!id(message.deliveryId) || !integer(message.index, 0, EDITING_LIMITS.chunks - 1)) throw invalid('Invalid map delivery acknowledgment');
            c.output.received(message.deliveryId, message.index); void catchup(c); return;
          }
          if (message.generation !== c.generation) throw invalid('The map generation changed');
          if (message.type === 'map-move') enqueue(c, { type: 'map-move', command: movement(message) }, data.byteLength);
          else if (message.type === 'map-cancel') {
            closed(message, ['type','generation','gestureId','leaseId']);
            if (!id(message.generation) || !id(message.gestureId) || !id(message.leaseId)) throw invalid('Invalid movement cancellation');
            enqueue(c, { type: 'map-cancel', command: { generation: message.generation, gestureId: message.gestureId, leaseId: message.leaseId } }, data.byteLength);
          } else if (message.type === 'map-presence') {
            if (data.byteLength > 2048) throw invalid('Map presence exceeds its 2KiB bound');
            enqueue(c, { type: 'map-presence', command: presence(message) }, data.byteLength);
          } else throw invalid('Unknown map message');
        } catch (error) { fail(c, error); }
      });
    },
    notify, notifyAll() { for (const c of connections.values()) void catchup(c); },
    async close() { closing = true; clearInterval(timer); for (const c of [...connections.values()]) { c.socket.terminate(); close(c); } await authority.close();await Promise.allSettled([...operations]); },
    get externalOutputBytes() { return outputBudget.bytes; },
    get resources(){return{mapConnections:connections.size,mapOperations:operations.size,mapPendingMovement:pendingMovement,mapPendingPresence:pendingPresence};},
  };
}
