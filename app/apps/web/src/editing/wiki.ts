import * as Y from 'yjs';
import { DOC_LIMITS, EDITING_LIMITS, type DocMention, type DocState, type EditingServerMessage, type LiveCursor, type LiveDocBootstrap, type NamedPrincipal, type SaveSharedDoc, type WikiTextEnvelope } from '@flux/contracts';
import { ApiError } from '../api/client.js';
import { enrollLiveDoc, getLiveDoc, saveLiveDoc } from '../docs/api.js';
import { decode64, EditingConnection, encode64, type ReceivedEditing } from './wire.js';

const REMOTE = Symbol('authorized shared update');
interface Pending { envelope: WikiTextEnvelope; bytes: string }
interface Recovery { generation: string; body: string; pending: Pending[]; save?: SaveSharedDoc | null }
export interface WikiPeer { connectionId: string; actor: NamedPrincipal; cursor: LiveCursor | null; expiresAt: string }
export interface WriterRange { actor: NamedPrincipal; anchor: string; head: string }

/** The Y.Doc is an editor instance. A socket reconnect renews it; a reload creates another. */
export class SharedWiki {
  document = new Y.Doc();
  text!: Y.Text;
  undo!: Y.UndoManager;
  head!: LiveDocBootstrap;
  status: 'connecting' | 'live' | 'reconnecting' | 'private' | 'unavailable' = 'connecting';
  problem: string | null = null;
  html = '';
  htmlSequence = 0;
  mentions: DocMention[] = [];
  peers = new Map<string, WikiPeer>();
  writers: WriterRange[] = [];
  privateBody: string | null = null;
  privatePending: Pending[] = [];
  lastLocalCommand: string | null = null;
  inputRevision = 0;
  sealedRevision = 0;
  sealedBatches: { from: number; to: number; commandId: string }[] = [];
  private unsealed: Uint8Array[] = [];
  private unsealedBytes = 0;
  private batchTimer: number | null = null;
  private pending = new Map<string, Pending>();
  private sent = new Set<string>();
  private activeCommand: string | null = null;
  private listeners = new Set<() => void>();
  private connection: EditingConnection | null = null;
  private instanceId: string | undefined;
  private appliedSequence = 0;
  private subscribedSequence = 0;
  private recovering = true;
  private stopped = false;
  private abort = new AbortController();
  private sendTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private presenceTimer: number;
  private renewalTimer: number;
  private renewing = false;
  private preview: Extract<EditingServerMessage, { type: 'preview' }> | null = null;
  private cursorTimer: number | null = null;
  private cursor: LiveCursor | null = null;
  /** The latest cursor names this editor's own text that the server has not admitted yet. */
  private cursorWaiting = false;
  /** Own replica clock covered by each sealed command, and the clock its received receipts cover. */
  private sealedClocks = new Map<string, number>();
  private confirmedClock = 0;
  private saveAttempt: SaveSharedDoc | null = null;
  private initialized = false;
  private archivedRecovery: Recovery | null = null;
  private storageKey: string;
  private leaving = () => { if (this.writer) this.persist(); };
  constructor(readonly id: string, readonly userId: string, readonly writer = true) {
    this.storageKey = `flux:wiki-live:${userId}:${id}`;
    if (writer) { window.addEventListener('pagehide', this.leaving); window.addEventListener('beforeunload', this.leaving); }
    this.presenceTimer = window.setInterval(() => {
      let changed = false;
      for (const [key, peer] of this.peers) if (Date.parse(peer.expiresAt) <= Date.now()) { this.peers.delete(key); changed = true; }
      if (changed) this.changed();
      if (this.editable && this.cursor) this.publishCursor();
    }, 1000);
    this.renewalTimer = window.setInterval(() => {
      if (!this.writer || !this.head?.canWrite || this.status !== 'live' || this.renewing) return;
      this.renewing = true;
      void this.enroll(this.head).catch((error: unknown) => {
        if (this.stopped) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) this.retire('Write access ended. Pending text is kept privately.');
        else this.disconnected();
      }).finally(() => { this.renewing = false; });
    }, 10_000);
    void this.start();
  }
  get pendingCount() { return this.pending.size + (this.unsealed.length ? 1 : 0); }
  get pendingSave() { return this.saveAttempt; }
  get hasPrivateArchive() { return this.archivedRecovery !== null; }
  get pendingBytes() { return this.unsealedBytes + [...this.pending.values()].reduce((total, item) => total + item.bytes.length * 3 / 4 + new TextEncoder().encode(JSON.stringify(item.envelope)).length + 32, 0); }
  get editable() { return !!(this.writer && this.status === 'live' && this.head?.canWrite && !this.recovering); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  refuseInput(message: string) { this.problem = message; this.changed(); }
  private changed() { for (const listener of this.listeners) listener(); }
  private recovery(key = this.storageKey): Recovery | null {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw || raw.length > 2_200_000) return null;
      const value = JSON.parse(raw) as Recovery;
      if (typeof value.generation !== 'string' || typeof value.body !== 'string' || value.body.length > EDITING_LIMITS.bodyUnits || !Array.isArray(value.pending) || value.pending.length > 1024) return null;
      if (value.save && (value.save.generation !== value.generation || typeof value.save.clientCommandId !== 'string' || !Number.isSafeInteger(value.save.expectedVersion) || !Number.isSafeInteger(value.save.headSequence) || typeof value.save.headHash !== 'string' || (value.save.title !== undefined && (typeof value.save.title !== 'string' || value.save.title.length > DOC_LIMITS.title)) || (value.save.reason !== undefined && (typeof value.save.reason !== 'string' || value.save.reason.length > DOC_LIMITS.reason)) || (value.save.state !== undefined && value.save.state !== 'draft' && value.save.state !== 'published'))) return null;
      let size = 0;
      for (const item of value.pending) {
        const envelope = item.envelope;
        if (!envelope || envelope.actor !== this.userId || envelope.room !== this.id || envelope.kind !== 'wiki' || envelope.operation !== 'text' || envelope.parameters !== null || envelope.generation !== value.generation || typeof envelope.uuid !== 'string' || !Number.isInteger(envelope.replica) || typeof item.bytes !== 'string') return null;
        size += item.bytes.length;
      }
      return size <= Math.ceil(EDITING_LIMITS.outputWindowBytes * 4 / 3) + 4096 ? value : null;
    } catch { return null; }
  }
  private persist() {
    if (!this.writer || !this.initialized || !this.head || !this.text) return;
    this.seal();
    try {
      if (!this.pending.size && !this.saveAttempt && this.status !== 'private') sessionStorage.removeItem(this.storageKey);
      else sessionStorage.setItem(this.storageKey, JSON.stringify({ generation: this.head.generation, body: this.text.toString(), pending: [...this.pending.values()], save: this.saveAttempt } satisfies Recovery));
    } catch { this.problem = 'This browser could not keep a recovery copy. Keep this tab open until sharing is confirmed.'; }
  }
  private async start() {
    try {
      const head = await getLiveDoc(this.id, this.abort.signal);
      if (this.stopped) return;
      if (head.actor.kind !== 'human' || head.actor.id !== this.userId) throw new Error('Editing identity changed');
      this.head = head; this.html = head.html; this.htmlSequence = head.sequence; this.mentions = head.mentions;
      const recovered = this.writer ? this.recovery() : null;
      this.archivedRecovery = this.writer ? this.recovery(`${this.storageKey}:previous`) : null;
      this.privateBody = this.archivedRecovery?.body ?? recovered?.body ?? null;
      this.privatePending = this.archivedRecovery?.pending ?? recovered?.pending ?? [];
      const resumable = recovered && recovered.generation === head.generation && head.canWrite && recovered.pending.every((item) => item.envelope.workspace === head.workspaceId);
      if (recovered && !resumable) {
        // At most one old-generation archive plus one current recovery copy. Never
        // overwrite another unresolved generation merely to make this one editable.
        if (this.archivedRecovery && JSON.stringify(this.archivedRecovery) !== JSON.stringify(recovered)) throw new Error('Two earlier sessions have private changes. Their original recovery copies are kept; resolve them before starting another shared session.');
        sessionStorage.setItem(`${this.storageKey}:previous`, JSON.stringify(recovered));
        this.archivedRecovery = recovered;
        sessionStorage.removeItem(this.storageKey);
      }
      this.privateBody = this.archivedRecovery?.body ?? recovered?.body ?? null;
      this.privatePending = this.archivedRecovery?.pending ?? recovered?.pending ?? [];
      if (head.canWrite && this.writer) await this.enroll(head);
      if (this.stopped) return;
      // Never assign clientID and never create a local struct before enrollment succeeds.
      this.text = this.document.getText('body');
      const enrolledReplica = this.document.clientID;
      Y.applyUpdate(this.document, decode64(head.checkpoint), REMOTE);
      if (this.writer && head.canWrite && this.document.clientID !== enrolledReplica) throw new Error('The checkpoint collided with this fresh editor identity. Reopen before writing.');
      this.undo = new Y.UndoManager(this.text, { trackedOrigins: new Set(), captureTimeout: 500 });
      this.document.on('update', this.localUpdate);
      this.appliedSequence = head.sequence;
      if (this.writer && recovered && resumable) {
        this.saveAttempt = recovered.save ?? null;
        for (const item of recovered.pending) {
          // Exact replay also verifies the bytes/envelope of a known receipt. A UUID-only
          // receipt lookup cannot establish that this recovery copy has the same fingerprint.
          this.pending.set(item.envelope.uuid, item);
        }
      } else if (this.archivedRecovery) {
        this.problem = 'An earlier session has private changes. Compare them before importing any text into this working copy.';
      }
      this.initialized = true;
      this.connect(); this.changed();
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof ApiError && error.status === 503 && error.code === 'LIVE_EDITING_DISABLED') this.status = 'unavailable';
      else { this.status = 'private'; this.problem = error instanceof Error ? error.message : 'The shared working copy could not be opened.'; }
      this.changed();
    }
  }
  private async enroll(head: LiveDocBootstrap) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const enrolled = await enrollLiveDoc(this.id, { generation: head.generation, replicaId: this.document.clientID, ...(this.instanceId ? { instanceId: this.instanceId } : {}) }, this.abort.signal);
        if (enrolled.replicaId !== this.document.clientID || enrolled.generation !== head.generation) throw new Error('Unexpected replica enrollment');
        this.instanceId = enrolled.instanceId; return;
      } catch (error) {
        // A collision must create a genuinely fresh, unused Y.Doc. This instance cannot mutate its ID.
        if (error instanceof ApiError && error.code === 'EDITING_REPLICA_COLLISION' && !this.text && attempt < 2) { this.document.destroy(); this.document = new Y.Doc(); continue; }
        throw error;
      }
    }
  }
  private connect() {
    this.connection?.close(); this.sent.clear(); this.activeCommand = null;
    this.connection = new EditingConnection('wiki', this.id, this.head.generation, this.appliedSequence, this.receive, this.disconnected);
  }
  private disconnected = () => {
    this.seal();
    if (this.stopped || this.status === 'private') return;
    this.status = 'reconnecting'; this.peers.clear(); this.changed();
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        const head = await getLiveDoc(this.id, this.abort.signal);
        if (this.stopped) return;
        if (head.generation !== this.head.generation || !head.canWrite && this.pending.size) { this.retire('Access or the working copy changed. Your pending text is kept privately.'); return; }
        if (head.canWrite && this.writer) await this.enroll(head);
        Y.applyUpdate(this.document, decode64(head.checkpoint), REMOTE);
        this.head = head; this.html = head.html; this.htmlSequence = head.sequence; this.mentions = head.mentions; this.appliedSequence = head.sequence;
        this.connect();
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) this.retire('Access ended. Your pending text is kept privately.');
        else this.disconnected();
      }
    }, 600);
  };
  private retire(message: string) {
    this.seal();
    this.status = 'private'; this.problem = message; this.privateBody = this.text?.toString() ?? this.privateBody;
    this.privatePending = [...this.pending.values()]; this.peers.clear(); this.writers = [];
    this.connection?.close(); this.persist(); this.changed();
  }
  private localUpdate = (bytes: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || this.stopped) return;
    // These fresh local transactions are not persistent intents yet. They are sealed
    // 40 ms after the first one or, while the previous command still awaits its
    // receipt, by that receipt: one command per round trip, not a growing queue of
    // 40 ms commands behind it. Already sealed UUID/bytes are never merged or rewritten.
    this.unsealed.push(bytes.slice()); this.unsealedBytes += bytes.length; this.inputRevision++;
    this.changed();
    if (this.batchTimer === null) this.batchTimer = window.setTimeout(() => { this.batchTimer = null; if (this.activeCommand === null) this.seal(); }, 40);
  };
  private seal() {
    if (this.batchTimer !== null) { window.clearTimeout(this.batchTimer); this.batchTimer = null; }
    if (!this.unsealed.length || !this.head) return;
    const bytes = Y.mergeUpdates(this.unsealed);
    this.unsealed = []; this.unsealedBytes = 0;
    const envelope: WikiTextEnvelope = { workspace: this.head.workspaceId, kind: 'wiki', room: this.id, generation: this.head.generation, actor: this.head.actor.id, operation: 'text', uuid: crypto.randomUUID(), replica: this.document.clientID, parameters: null };
    this.pending.set(envelope.uuid, { envelope, bytes: encode64(bytes) });
    this.sealedClocks.set(envelope.uuid, Y.decodeStateVector(Y.encodeStateVector(this.document)).get(this.document.clientID) ?? 0);
    this.lastLocalCommand = envelope.uuid;
    this.sealedBatches = [...this.sealedBatches, { from: this.sealedRevision + 1, to: this.inputRevision, commandId: envelope.uuid }].slice(-64);
    this.sealedRevision = this.inputRevision;
    this.persist(); this.changed();
    if (this.pendingBytes > EDITING_LIMITS.outputWindowBytes || this.pending.size > 1024) { this.retire('Sharing reached its bounded capacity. Your text is kept privately.'); return; }
    this.scheduleSend();
  }
  private scheduleSend(delay = 0) {
    if (this.sendTimer !== null || this.stopped || this.status !== 'live' || !this.writer || !this.head.canWrite) return;
    this.sendTimer = window.setTimeout(() => {
      this.sendTimer = null;
      if (this.activeCommand) return;
      for (const [id, item] of this.pending) {
        if (this.sent.has(id)) continue;
        if (!this.connection?.text(item.envelope, decode64(item.bytes))) { this.scheduleSend(20); break; }
        this.sent.add(id);
        this.activeCommand = id; break;
      }
    }, delay);
  }
  private receive = (message: ReceivedEditing) => {
    if (this.stopped || this.status === 'private') return;
    if ('generation' in message && message.generation !== this.head.generation) { this.retire('The working copy changed. Your pending text is kept privately for comparison.'); return; }
    switch (message.type) {
      case 'head':
        this.subscribedSequence = message.sequence;
        if (!message.canWrite) this.seal();
        this.head.canWrite = message.canWrite;
        if (!message.canWrite && this.pending.size) { this.retire('Write access ended. Your pending text is kept privately.'); return; }
        if (message.workspaceId !== this.head.workspaceId || message.resourceId !== this.id || message.actor.id !== this.userId || message.actor.kind !== 'human') { this.retire('The shared identity changed. Pending text stays private.'); return; }
        this.status = 'live'; this.recovering = this.pending.size > 0 && this.recovering;
        this.scheduleSend(); break;
      case 'update': {
        if (!('bytes' in message) || message.sequence <= this.appliedSequence) break;
        if (message.sequence !== this.appliedSequence + 1) { this.disconnected(); return; }
        const ranges: { from: number; to: number }[] = [];
        const observe = (event: Y.YTextEvent) => {
          let index = 0;
          for (const part of event.delta) {
            if (part.retain) index += part.retain;
            if (typeof part.insert === 'string') { ranges.push({ from: index, to: index + part.insert.length }); index += part.insert.length; }
          }
        };
        this.text.observe(observe);
        try { Y.applyUpdate(this.document, message.bytes, REMOTE); }
        finally { this.text.unobserve(observe); }
        this.writers = [...this.writers, ...ranges.map((range) => ({ actor: message.actor, anchor: encode64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, range.from))), head: encode64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, range.to))) }))].slice(-100);
        this.appliedSequence = message.sequence; this.head.sequence = message.sequence; this.head.hash = message.hash;
        break;
      }
      case 'ack': {
        if (message.workspaceId !== this.head.workspaceId || message.resourceId !== this.id) { this.retire('A receipt has another scope. Pending text is kept privately.'); return; }
        const original = this.pending.get(message.commandId);
        if (original) {
          if (message.operation !== 'text') { this.retire('A receipt has another operation. Pending text is kept privately.'); return; }
          // On reload this fresh Y.Doc did not initialize from private pending bytes.
          // An exact replay ACK proves server admission of those original bytes. Apply
          // them as confirmed remote data before removing the private recovery copy.
          if (original.envelope.replica !== this.document.clientID) Y.applyUpdate(this.document, decode64(original.bytes), REMOTE);
        }
        this.pending.delete(message.commandId); this.sent.delete(message.commandId);
        if (this.activeCommand === message.commandId) this.activeCommand = null;
        const confirmed = this.sealedClocks.get(message.commandId);
        if (confirmed !== undefined) { this.sealedClocks.delete(message.commandId); this.confirmedClock = Math.max(this.confirmedClock, confirmed); }
        if (original && message.sequence === this.appliedSequence + 1) { this.appliedSequence = message.sequence; this.head.sequence = message.sequence; this.head.hash = message.hash; }
        if (message.savedDoc && message.savedDoc.version >= this.head.savedVersion) { this.head.savedVersion = message.savedDoc.version; this.head.savedSequence = message.sequence; }
        if (!this.pending.size) { this.recovering = false; this.privateBody = this.archivedRecovery?.body ?? null; this.privatePending = this.archivedRecovery?.pending ?? []; }
        this.persist(); this.scheduleSend();
        if (this.cursorWaiting && this.editable) this.publishCursor();
        if (message.sequence > this.appliedSequence) { this.disconnected(); return; }
        break;
      }
      case 'preview':
        if (message.sequence >= this.appliedSequence && (!this.preview || message.sequence >= this.preview.sequence)) this.preview = message;
        break;
      case 'presence':
        if (message.actor.id !== this.userId) this.peers.set(message.connectionId, message);
        break;
      case 'saved':
        this.head.savedVersion = message.savedVersion; this.head.savedSequence = message.savedSequence; break;
      case 'resync': this.disconnected(); return;
      case 'revoked': this.retire('Access ended. Your pending text is kept privately.'); return;
      case 'error':
        if (message.outcome === 'refused' && !message.retryable && message.commandId) { this.retire(`A change was refused (${message.code}). Your text is kept privately for comparison.`); return; }
        this.problem = `Sharing is not confirmed (${message.code}). The exact pending change is kept for retry.`;
        if (message.retryable) { if (message.commandId) { this.sent.delete(message.commandId); if (this.activeCommand === message.commandId) this.activeCommand = null; } this.scheduleSend(40); }
        else if (message.outcome === 'unknown') this.disconnected();
        break;
    }
    if (this.appliedSequence < this.subscribedSequence) this.status = 'connecting';
    else if (this.status === 'connecting') this.status = 'live';
    if (this.preview?.sequence === this.appliedSequence && this.preview.hash === this.head.hash) { this.html = this.preview.html; this.htmlSequence = this.preview.sequence; this.mentions = this.preview.mentions; this.preview = null; }
    this.changed();
  };
  setCursor(anchor: number, head: number) {
    if (!this.editable) return;
    this.cursor = { anchor: encode64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, anchor))), head: encode64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, head))) };
    if (this.cursorTimer !== null) return;
    this.cursorTimer = window.setTimeout(() => { this.cursorTimer = null; this.publishCursor(); }, 40);
  }
  /** The server names only admitted text and refuses a position inside text it has not
   * admitted (INVALID_CURSOR). A cursor inside this editor's own unconfirmed text waits
   * for the receipt that confirms that text, then the latest cursor is sent. */
  private publishCursor() {
    const admitted = (encoded: string) => {
      const item = Y.decodeRelativePosition(decode64(encoded)).item;
      return !item || item.client !== this.document.clientID || item.clock < this.confirmedClock;
    };
    if (this.cursor && !(admitted(this.cursor.anchor) && admitted(this.cursor.head))) { this.cursorWaiting = true; return; }
    this.cursorWaiting = false;
    this.connection?.send({ type: 'cursor', generation: this.head.generation, cursor: this.cursor });
  }
  blur() { this.cursor = null; this.cursorWaiting = false; this.connection?.send({ type: 'cursor', generation: this.head.generation, cursor: null }); }
  discardPrivateArchive() {
    if (!this.archivedRecovery) return;
    try { sessionStorage.removeItem(`${this.storageKey}:previous`); }
    catch { this.problem = 'This browser could not remove the earlier recovery copy.'; this.changed(); return; }
    this.archivedRecovery = null; this.privateBody = this.pending.size ? this.text.toString() : null; this.privatePending = [...this.pending.values()]; this.changed();
  }
  async save(metadata: { title?: string; state?: DocState; reason?: string }, metadataVersion?: number) {
    this.seal();
    const deadline = Date.now() + 10_000;
    while (this.pending.size && this.status !== 'private' && Date.now() < deadline) await new Promise((resolve) => window.setTimeout(resolve, 20));
    if (!this.editable || this.pending.size) throw new Error('Wait until every change is shared before saving a version.');
    const sameMetadata = this.saveAttempt && this.saveAttempt.title === metadata.title && this.saveAttempt.state === metadata.state && this.saveAttempt.reason === metadata.reason;
    if (this.saveAttempt && !sameMetadata) throw new Error('Retry the unconfirmed Save with its original title, state and reason before starting another Save.');
    const command = sameMetadata ? this.saveAttempt! : { ...metadata, generation: this.head.generation, headSequence: this.head.sequence, headHash: this.head.hash, expectedVersion: metadataVersion ?? this.head.savedVersion, clientCommandId: crypto.randomUUID() };
    this.saveAttempt = command;
    this.persist();
    let receipt;
    try { receipt = await saveLiveDoc(this.id, command); }
    catch (error) {
      const outcome = error instanceof ApiError && error.body && typeof error.body === 'object' ? (error.body as { outcome?: string }).outcome : undefined;
      if (error instanceof ApiError && error.status < 500 && outcome !== 'unknown') {
        this.saveAttempt = null;
        if (error.status === 409) this.disconnected();
      }
      // A network failure may follow a committed Save: keep its exact envelope/UUID.
      this.persist(); this.changed(); throw error;
    }
    if (receipt.savedDoc && receipt.savedDoc.version >= this.head.savedVersion) { this.head.savedVersion = receipt.savedDoc.version; this.head.savedSequence = command.headSequence; }
    this.saveAttempt = null; this.persist(); this.changed(); return receipt;
  }
  destroy() {
    this.persist(); this.stopped = true; this.abort.abort(); this.connection?.close();
    window.removeEventListener('pagehide', this.leaving); window.removeEventListener('beforeunload', this.leaving);
    for (const timer of [this.sendTimer, this.reconnectTimer, this.cursorTimer, this.batchTimer]) if (timer !== null) window.clearTimeout(timer);
    window.clearInterval(this.presenceTimer); window.clearInterval(this.renewalTimer); this.document.off('update', this.localUpdate);
    this.undo?.destroy(); this.document.destroy(); this.listeners.clear();
  }
}
