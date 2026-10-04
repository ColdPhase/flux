import { createHash } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { DomainError, ServiceUnavailableError } from '@flux/core';
import { EditingTransactionError } from '@flux/db';
import type { EditingClientMessage } from '@flux/contracts';
import type { EditingContext } from './gate.js';
import { editingContextCharge,editingWikiResultCharge } from './context-charge.js';
import { Assemblies, type CompletedAssembly } from './codec/assembly.mjs';
import { EditingOutput, EditingOutputBudget } from './output.js';
import type { WikiAuthority } from './authority.js';
import { EditingHTTPAdmission } from './http-admission.js';
import { editingJSONSize } from './json-size.js';
import { editingResourcesChanged } from './resource-observation.js';
import type { EditingQueueTelemetry } from './telemetry.js';

interface Connection {
  socket: WebSocket; context: EditingContext; output: EditingOutput; generation: string | null;
  sequence: number; previewSequence: number; assemblyCommand: string | null; assembly: CompletedAssembly | null; running: boolean; reading: boolean;
  pendingRead: boolean; closed: boolean; subscribed: boolean; lastHead: string; lastSaved: string; presence: Map<string, { hash: string; release: () => void }>; cursorBusy: boolean; releaseBase: () => void;
}
const signature = (text: string) => createHash('sha256').update(text).digest('hex');
const errorCode = (error: unknown) => error instanceof DomainError ? error.code
  : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'EDITING_UNAVAILABLE';
const busy = (error: unknown) => ['EXTERNAL_BUFFER_LIMIT', 'WORK_QUEUE_LIMIT', 'POOL_CLOSED', 'EDITING_OUTPUT_CAPACITY', 'EDITING_PRESENCE_CAPACITY'].includes(errorCode(error));
/** Message listeners are installed synchronously by the one upgrade dispatcher; all protected send paths use SQL authority. */
export function wikiController(authority: WikiAuthority, outputBudget: EditingOutputBudget,telemetry?:()=>EditingQueueTelemetry|null) {
  const connections = new Map<string, Connection>(); const assemblies = new Assemblies(editingResourcesChanged);
  const preparation=new EditingHTTPAdmission(outputBudget,10_000,'wiki');
  const operations=new Set<Promise<void>>();let reading=0,writing=0,cursorActive=0;
  function operation(){let finish=()=>{};const done=new Promise<void>(resolve=>{finish=resolve;});operations.add(done);return()=>{operations.delete(done);finish();};}
  let closing = false;
  function close(c: Connection) { if (c.closed) return; c.closed = true; c.releaseBase(); for (const entry of c.presence.values()) entry.release(); c.presence.clear(); c.output.close(); assemblies.remove(c.context.connectionId); c.assembly = null; connections.delete(c.context.connectionId);editingResourcesChanged(); }
  function fail(c: Connection, error: unknown, commandId?: string) {
    if (c.closed) return;
    if (errorCode(error) === 'UNAUTHENTICATED' || error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      try { c.output.sendJSON({ type: 'revoked' }); } finally { c.socket.close(1008, 'Access ended'); close(c); } return;
    }
    const unknown = error instanceof EditingTransactionError && error.outcome === 'unknown';
    try { c.output.sendJSON({ type: 'error', code: errorCode(error), ...(commandId ? { commandId } : {}), outcome: unknown ? 'unknown' : 'refused', retryable: unknown || busy(error) }); }
    catch { c.socket.terminate(); close(c); }
  }
  async function catchup(c: Connection) {
    if (c.closed || !c.subscribed || !c.generation) return;
    if (c.reading) { c.pendingRead = true; return; }
    c.reading = true;reading++;editingResourcesChanged();const completed=operation();
    try {
      do {
        c.pendingRead = false;
        if(c.output.busy) {
          await authority.handoff(c.context.session,c.context.target.id,()=>{if(!c.closed)c.pendingRead=c.output.pump()&&c.output.canPump;});
          continue;
        }
        const releasePreparation=await preparation.admit(editingContextCharge({session:c.context.session,docId:c.context.target.id}));
        try {await authority.deliver(c.context.session, c.context.target.id, c.generation, c.sequence, (result) => {
          if (c.closed) return;
          // The pre-SQL worst-case reservation retains all protected source objects through transaction settlement.
          editingWikiResultCharge(result);
          const head = result.current;
          const currentHead = { type: 'head', kind: 'wiki', workspaceId: head.workspaceId, resourceId: head.resourceId,
            generation: head.generation, sequence: head.sequence, hash: head.hash, savedVersion: head.savedVersion, canWrite: result.canWrite, actor: result.actor };
          const headSignature = signature(JSON.stringify({ generation: head.generation, canWrite: result.canWrite, actor: result.actor }));
          if (c.lastHead !== headSignature) { c.output.sendJSON(currentHead); c.lastHead = headSignature; c.pendingRead = true; return; }
          const savedSignature = signature(JSON.stringify({ generation: head.generation, savedVersion: head.savedVersion, savedSequence: head.savedSequence }));
          if (c.lastSaved !== savedSignature) {
            c.output.sendJSON({ type: 'saved', generation: head.generation, sequence: head.sequence, hash: head.hash,
              savedVersion: head.savedVersion, savedSequence: head.savedSequence }); c.lastSaved = savedSignature; c.pendingRead = true; return;
          }
          const active = new Set(result.presence.map((peer) => peer.connectionId));
          for (const key of c.presence.keys()) if (!active.has(key)) { c.presence.get(key)!.release(); c.presence.delete(key); }
          for (const peer of result.presence) {
            const value = { type: 'presence', generation: head.generation, ...peer };
            const currentSignature = signature(JSON.stringify(value));
            if (c.presence.get(peer.connectionId)?.hash !== currentSignature) {
              const old = c.presence.get(peer.connectionId); const release = old?.release ?? outputBudget.reserve(512);
              try { c.output.sendJSON(value); c.presence.set(peer.connectionId, { hash: currentSignature, release }); }
              catch (error) { if (!old) release(); throw error; }
              c.pendingRead = true; return;
            }
          }
          if (!c.output.busy) {
            const update = result.updates[0];
            if (update) {
              const deliveredSequence = update.sequence;
              c.output.send({ type: 'update', generation: head.generation, sequence: update.sequence, hash: update.hash,
                commandId: update.commandId, actor: update.actor }, update.bytes, () => { c.sequence = deliveredSequence; void catchup(c); });
            } else if (result.preview && c.previewSequence < head.sequence) {
              const size=editingJSONSize(result.preview);
              const releaseText=outputBudget.reserve(size.textBytes);
              try {
              const text=JSON.stringify(result.preview);if(Buffer.byteLength(text)!==size.bytes||text.length*2!==size.textBytes)throw new ServiceUnavailableError('Invalid bounded preview','EDITING_OUTPUT_CAPACITY');
              const deliveredSequence = head.sequence;
              c.output.sendJSONPayload({ type: 'preview', generation: head.generation, sequence: head.sequence, hash: head.hash }, text,
                () => { c.previewSequence = deliveredSequence; void catchup(c); });
              } finally {releaseText();}
            }
            c.pendingRead = c.output.canPump;
          } else c.pendingRead = c.output.pump() && c.output.canPump;
          // Each callback hands off at most one frame. Every next chunk repeats current SQL clock/access checks.
        }, { previewAfterSequence: c.previewSequence, includeContent: true });} finally {releasePreparation();}
      } while (c.pendingRead && !c.closed);
    } catch (error) {
      if (!busy(error)) fail(c, error);
      // Periodic catch-up retries bounded capacity; it holds no additional input or promise queue.
    } finally { c.reading = false;reading--;editingResourcesChanged();completed(); }
  }
  function pump(c: Connection) {
    if (c.closed || c.running || !c.assembly) return;
    let admission;
    try { admission = authority.reserve(c.assembly); }
    catch (error) { if (!busy(error)) { fail(c, error, c.assembly.intent.uuid); assemblies.remove(c.context.connectionId); c.assembly = null; } return; }
    let bytes:CompletedAssembly|null=c.assembly;const commandId=bytes.intent.uuid;c.assembly = null;
    assemblies.remove(c.context.connectionId); c.assemblyCommand = null; c.running = true;writing++;editingResourcesChanged();const completed=operation();
    void (async () => {
      try {
        await authority.submit(c.context.session, c.context.target.id, bytes!.intent, bytes!, admission);bytes=null;
        // Re-read the immutable original receipt under CURRENT authority AFTER the commit.
        await authority.deliverReceipt(c.context.session, c.context.target.id, commandId, (receipt) => {
          if (!c.closed && receipt) c.output.sendJSON({ type: 'ack', ...receipt });
          if(receipt)telemetry?.()?.schedule('wiki',{resourceId:c.context.target.id,generation:receipt.generation,commandId:receipt.commandId,confirmedSequence:receipt.sequence});
        });
        for (const other of connections.values()) if (other.context.target.id === c.context.target.id) void catchup(other);
      } catch (error) { fail(c, error, commandId); }
      finally { bytes=null;c.running = false;writing--;editingResourcesChanged();completed(); pump(c); }
    })();
  }
  const unsubscribeCapacity = authority.runtime.onCapacity(() => { if (!closing) for (const c of connections.values()) pump(c); });
  const timer = setInterval(() => {
    assemblies.expire(Date.now());
    for (const c of connections.values()) {
      if (c.assemblyCommand && !assemblies.pending.has(c.context.connectionId)) { const uuid = c.assemblyCommand; c.assembly = null; c.assemblyCommand = null; fail(c, new ServiceUnavailableError('The finite assembly deadline ended', 'EDITING_ASSEMBLY_EXPIRED'), uuid); }
      void catchup(c);
    }
  }, 250); timer.unref();
  return {
    accept(socket: WebSocket, context: EditingContext) {
      if (closing || context.target.kind !== 'wiki') { socket.close(1008, 'Unavailable'); return; }
      const c: Connection = { socket, context, output: new EditingOutput(socket, outputBudget), generation: null,
        sequence: 0, previewSequence: -1, assemblyCommand: null, assembly: null, running: false, reading: false, pendingRead: false, closed: false, subscribed: false, lastHead: '', lastSaved: '', presence: new Map(), cursorBusy: false, releaseBase: outputBudget.reserve(2048 + editingContextCharge(context)) };
      connections.set(context.connectionId, c);editingResourcesChanged();
      socket.once('close', () => close(c));
      socket.on('message', (data: RawData, binary) => {
        if (c.closed) return;
        try {
          if (binary) {
            if (!c.subscribed || !c.generation) throw new DomainError(400, 'EDITING_SUBSCRIBE_REQUIRED', 'Subscribe before sharing text');
            if (!Buffer.isBuffer(data)) throw new DomainError(400, 'EDITING_FRAME_INVALID', 'An exact binary frame is required');
            const complete = assemblies.receive(context.connectionId, data, { actor: context.session.principal.id, kind: 'wiki', room: context.target.id, operation: 'text', parameters: null }, Date.now());
            c.assemblyCommand = assemblies.intent(context.connectionId)?.uuid ?? null;
            if (complete) { c.assembly = complete; pump(c); }
            return;
          }
          const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
          const message = JSON.parse(raw) as EditingClientMessage;
          if (message.type === 'subscribe') {
            if (c.subscribed || typeof message.generation !== 'string' || !Number.isSafeInteger(message.afterSequence) || message.afterSequence < 0
              || Object.keys(message).some((key) => !['type','generation','afterSequence'].includes(key))) throw new DomainError(400, 'EDITING_SUBSCRIBE_INVALID', 'Invalid subscription');
            c.generation = message.generation; c.sequence = message.afterSequence; c.subscribed = true; void catchup(c);
          } else if (message.type === 'received') {
            if (Object.keys(message).some((key) => !['type','deliveryId','index'].includes(key))) throw new DomainError(400, 'EDITING_ACK_INVALID', 'Invalid delivery acknowledgment');
            c.output.received(message.deliveryId, message.index); void catchup(c);
          } else if (message.type === 'cursor') {
            if (!c.subscribed || message.generation !== c.generation || Object.keys(message).some((key) => !['type','generation','cursor'].includes(key))) throw new DomainError(400, 'INVALID_CURSOR', 'Invalid cursor');
            if (c.cursorBusy) throw new ServiceUnavailableError('The bounded cursor admission is busy', 'EDITING_PRESENCE_CAPACITY');
            c.cursorBusy = true;cursorActive++;editingResourcesChanged();const completed=operation();
            void authority.cursor(context.session, context.target.id, message.generation, context.connectionId, message.cursor)
              .then(() => { for (const other of connections.values()) if (other.context.target.id === context.target.id) void catchup(other); })
              .catch((error) => fail(c, error)).finally(() => { c.cursorBusy = false;cursorActive--;editingResourcesChanged();completed(); });
          } else throw new DomainError(400, 'EDITING_MESSAGE_INVALID', 'Invalid wiki message');
        } catch (error) { fail(c, error, assemblies.intent(context.connectionId)?.uuid); }
      });
    },
    notifyAll() { for (const c of connections.values()) void catchup(c); },
    notify(docId: string) { for (const c of connections.values()) if (c.context.target.id === docId) void catchup(c); },
    async close() { closing = true; clearInterval(timer); unsubscribeCapacity(); preparation.close(); for (const c of [...connections.values()]) { c.socket.terminate(); close(c); } await authority.close();await Promise.allSettled([...operations]); },
    get externalOutputBytes() { return outputBudget.bytes; }, get assemblyBytes() { return assemblies.bytes; },
    get resources(){return{wikiConnections:connections.size,wikiReading:reading,wikiWriting:writing,wikiCursorActive:cursorActive,assemblyCount:assemblies.pending.size,assemblyBytes:assemblies.bytes};},
  };
}
