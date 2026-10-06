import { liveMapPath, liveMapGesturePath, type LiveMapBootstrap, type LiveMapDelta, type LiveMapLease, type LiveMapPosition, type NamedPrincipal, type SketchDetail, type Thought } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { EditingConnection, type ReceivedEditing } from './wire';

export interface MapPreview { generation: string; actor: NamedPrincipal; gestureId: string; leaseId: string; positions: LiveMapPosition[]; expiresAt: string; sequence: number }
interface Gesture { id: string; base: Map<string, number>; lease: Promise<LiveMapLease>; active: boolean; sequence: number; latest: LiveMapPosition[] | null; lastPositions: LiveMapPosition[] | null; serverLease: LiveMapLease | null; lastPreviewAt: number }
interface PrivateMovement { generation: string; gestureId: string; positions: LiveMapPosition[]; versions: [string, number][] }

export class SharedMap {
  head: LiveMapBootstrap | null = null;
  status: 'connecting' | 'live' | 'unavailable' | 'private' = 'connecting';
  problem: string | null = null;
  previews = new Map<string, MapPreview>();
  peers = new Map<string, { actor: NamedPrincipal; selected: string[]; expiresAt: string }>();
  privateMovement: PrivateMovement | null = null;
  private connection: EditingConnection | null = null;
  private gesture: Gesture | null = null;
  private completedGesture: Gesture | null = null;
  private stopped = false;
  private abort = new AbortController();
  private timer: number;
  private previewTimer: number | null = null;
  private lastPreviewSentAt = -Infinity;
  private reconnectTimer: number | null = null;
  private selected: string[] = [];
  private leaving = () => this.cancel(true);
  get ownGesture() { return this.gesture?.active && this.head ? { id: this.gesture.id, sequence: this.gesture.sequence, generation: this.head.generation } : null; }
  constructor(readonly id: string, readonly userId: string,
    private snapshot: (sketch: SketchDetail) => void,
    private delta: (delta: LiveMapDelta) => void,
    private changed: () => void) {
    window.addEventListener('pagehide', this.leaving); window.addEventListener('beforeunload', this.leaving);
    try {
      const raw = sessionStorage.getItem(this.privateKey);
      const value = raw && raw.length <= 128_000 ? JSON.parse(raw) as PrivateMovement : null;
      if (value && typeof value.generation === 'string' && typeof value.gestureId === 'string' && Array.isArray(value.versions) && value.versions.length <= 200 && Array.isArray(value.positions) && value.positions.length <= 200 && value.positions.every((position) => typeof position.id === 'string' && Number.isFinite(position.x) && Number.isFinite(position.y) && (position.width === undefined || Number.isFinite(position.width)) && (position.height === undefined || Number.isFinite(position.height)))) this.privateMovement = value;
    } catch { /* An invalid browser copy cannot become a shared command. */ }
    this.timer = window.setInterval(() => {
      let expired = false;
      for (const [id, preview] of this.previews) if (Date.parse(preview.expiresAt) <= Date.now()) { this.previews.delete(id); expired = true; }
      for (const [id, peer] of this.peers) if (Date.parse(peer.expiresAt) <= Date.now()) { this.peers.delete(id); expired = true; }
      const gesture = this.gesture;
      if (gesture?.active && gesture.serverLease && Date.parse(gesture.serverLease.expiresAt) <= Date.now() && gesture.lastPreviewAt + 5000 <= Date.now()) { this.cancel(true); this.problem = 'The movement lease expired. Its unfinished positions are kept privately for comparison.'; expired = true; }
      if (expired) this.changed();
      if (this.head && this.status === 'live' && this.head.canWrite) this.connection?.send({ type: 'map-presence', generation: this.head.generation, selected: this.selected.slice(0, 16), cursor: null });
    }, 1000);
    void this.start();
  }
  private get privateKey() { return `flux:map-gesture:${this.userId}:${this.id}`; }
  private keepMovement(gesture: Gesture) {
    if (!gesture.lastPositions || !this.head) return;
    this.privateMovement = { generation: this.head.generation, gestureId: gesture.id, positions: gesture.lastPositions, versions: [...gesture.base] };
    try { sessionStorage.setItem(this.privateKey, JSON.stringify(this.privateMovement)); }
    catch { this.problem = 'Keep this tab open: the browser could not keep your unfinished movement copy.'; }
  }
  discardPrivateMovement() { try { sessionStorage.removeItem(this.privateKey); this.privateMovement = null; this.changed(); } catch { this.problem = 'This browser could not remove the movement copy.'; this.changed(); } }
  private async start() {
    try {
      const head = await request<LiveMapBootstrap>(liveMapPath(this.id), { signal: this.abort.signal });
      if (this.stopped) return;
      if (head.actor.kind !== 'human' || head.actor.id !== this.userId) throw new Error('Map editing identity changed');
      this.head = head; this.snapshot(head.sketch);
      this.connection?.close();
      this.connection = new EditingConnection('map', this.id, head.generation, head.sequence, this.receive, this.disconnected);
      this.changed();
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof ApiError && error.status === 503 && error.code === 'LIVE_EDITING_DISABLED') this.status = 'unavailable';
      else if (error instanceof ApiError && (error.status === 403 || error.status === 404)) this.retire('Access ended. Your unfinished movement is kept locally.');
      else { this.problem = 'The live map could not be reached. Reconnecting…'; this.disconnected(); }
      this.changed();
    }
  }
  private disconnected = () => {
    if (this.stopped || this.status === 'private' || this.status === 'unavailable') return;
    this.status = 'connecting'; this.previews.clear(); this.peers.clear(); this.cancel(true); this.changed();
    this.connection?.close();
    if (this.reconnectTimer === null) this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = null; void this.start(); }, 600);
  };
  private retire(problem: string) {
    this.status = 'private'; this.problem = problem; this.cancel(true); this.connection?.close(); this.previews.clear(); this.peers.clear(); this.changed();
  }
  private receive = (message: ReceivedEditing) => {
    if (!this.head || this.stopped) return;
    if ('generation' in message && message.generation !== this.head.generation) { this.retire('The map session changed. Start a fresh gesture before sharing movement.'); return; }
    switch (message.type) {
      case 'head':
        if (message.workspaceId !== this.head.workspaceId || message.resourceId !== this.id || message.actor.id !== this.userId || message.actor.kind !== 'human') { this.retire('The map identity changed. Start a new authorized session.'); return; }
        this.head.canWrite = message.canWrite; this.status = 'live'; this.problem = null;
        if (!message.canWrite) this.cancel(true); break;
      case 'map-delta':
        if (message.sequence <= this.head.sequence) break;
        if (message.sequence !== this.head.sequence + 1) { this.disconnected(); return; }
        this.head.sequence = message.sequence;
        for (const id of message.clearedLeaseIds) { this.previews.delete(id); if (this.gesture?.serverLease?.leaseId === id) { this.keepMovement(this.gesture); this.gesture.active = false; } if (this.completedGesture?.serverLease?.leaseId === id) this.completedGesture = null; }
        this.delta(message); break;
      case 'map-move': {
        // An own echo only renews the current lease. Native pointer input already
        // published its local geometry/sequence; this must not repaint the graph.
        if (this.gesture?.serverLease?.leaseId === message.leaseId) { this.gesture.serverLease.expiresAt = message.expiresAt; return; }
        if (this.completedGesture?.serverLease?.leaseId === message.leaseId) return;
        const old = this.previews.get(message.leaseId);
        if (!old || message.sequence > old.sequence) this.previews.set(message.leaseId, message);
        break;
      }
      case 'map-clear':
        this.previews.delete(message.leaseId);
        if (this.gesture?.serverLease?.leaseId === message.leaseId) { this.cancel(true); this.problem = 'The movement lease ended. Its unfinished positions are kept privately; compare them before starting again.'; }
        break;
      case 'map-presence':
        if (message.actor.id !== this.userId) this.peers.set(message.connectionId, message); break;
      case 'revoked': this.retire('Access ended. Your unfinished movement is kept locally.'); return;
      case 'resync': this.disconnected(); return;
      case 'error':
        this.problem = `The map change is not confirmed (${message.code}).`;
        if (message.outcome === 'refused') this.cancel(true); break;
    }
    this.changed();
  };
  selection(ids: string[]) { this.selected = ids.slice(0, 16); }
  resync() { this.disconnected(); }
  begin(thoughts: Thought[]) {
    this.cancel();
    if (!this.head?.canWrite || this.status !== 'live' || !thoughts.length || thoughts.length > 200) return false;
    const id = crypto.randomUUID();
    const gesture: Gesture = { id, base: new Map(thoughts.map((thought) => [thought.id, thought.version])), active: true, sequence: 0, latest: null, lastPositions: null, serverLease: null, lastPreviewAt: 0,
      lease: request<LiveMapLease>(liveMapGesturePath(this.id), { method: 'POST', body: { gestureId: id, thoughts: thoughts.map((thought) => ({ id: thought.id, expectedVersion: thought.version })) }, headers: { 'idempotency-key': id }, signal: this.abort.signal }) };
    this.gesture = gesture;
    this.changed();
    void gesture.lease.then((lease) => {
      gesture.serverLease = lease;
      if (this.stopped || !gesture.active) { this.connection?.send({ type: 'map-cancel', generation: lease.generation, gestureId: id, leaseId: lease.leaseId }); return; }
      if (lease.generation !== this.head?.generation || lease.gestureId !== id) { gesture.active = false; return; }
      this.schedulePreview();
    }, (error: unknown) => { this.keepMovement(gesture); gesture.active = false; this.problem = error instanceof Error ? error.message : 'Someone else is moving this thought.'; this.changed(); });
    return true;
  }
  preview(positions: LiveMapPosition[]) {
    const gesture = this.gesture;
    if (!gesture?.active || positions.length !== gesture.base.size || positions.some((position) => !gesture.base.has(position.id))) return;
    gesture.latest = positions; gesture.lastPositions = positions.map((position) => ({ ...position })); gesture.sequence++; this.schedulePreview(); this.changed();
  }
  /** At most one preview per 40 ms; the first movement after a quiet interval goes out at once. */
  private schedulePreview() {
    if (this.previewTimer !== null) return;
    const wait = Math.max(0, this.lastPreviewSentAt + 40 - performance.now());
    if (!wait) { this.sendPreview(); return; }
    this.previewTimer = window.setTimeout(() => { this.previewTimer = null; this.sendPreview(); }, wait);
  }
  private sendPreview() {
    const gesture = this.gesture;
    if (!gesture?.active || !gesture.serverLease || !gesture.latest) return;
    if (this.connection?.send({ type: 'map-move', generation: gesture.serverLease.generation, gestureId: gesture.id, leaseId: gesture.serverLease.leaseId, sequence: gesture.sequence, positions: gesture.latest })) {
      gesture.lastPreviewAt = Date.now(); this.lastPreviewSentAt = performance.now();
    }
    gesture.latest = null;
  }
  finish() {
    const gesture = this.gesture;
    this.gesture = null;
    this.completedGesture = gesture;
    if (!gesture) return Promise.reject(new Error('Start a fresh gesture before committing.'));
    return gesture.lease.then((lease) => {
      if (!gesture.active || this.status !== 'live' || Date.parse(lease.expiresAt) <= Date.now() && gesture.lastPreviewAt + 5000 <= Date.now()) throw new Error('The movement lease ended. Start again on the current thought.');
      return { leaseId: lease.leaseId, versions: gesture.base };
    });
  }
  cancel(keep = false) {
    const gesture = this.gesture ?? this.completedGesture; this.gesture = null; this.completedGesture = null;
    if (!gesture) return;
    if (keep && gesture.active) this.keepMovement(gesture);
    gesture.active = false;
    if (gesture.serverLease) this.connection?.send({ type: 'map-cancel', generation: gesture.serverLease.generation, gestureId: gesture.id, leaseId: gesture.serverLease.leaseId });
  }
  destroy() {
    this.cancel(true); this.stopped = true; this.abort.abort(); this.connection?.close(); window.clearInterval(this.timer);
    window.removeEventListener('pagehide', this.leaving); window.removeEventListener('beforeunload', this.leaving);
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
  }
}
