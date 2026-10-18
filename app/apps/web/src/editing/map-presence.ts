import type { NamedPrincipal } from '@flux/contracts';

export interface MapPeer {
  readonly actor: NamedPrincipal;
  readonly selected: readonly string[];
  readonly cursor: Readonly<{ x: number; y: number }> | null;
  readonly expiresAt: string;
}
export interface MapPresenceSource {
  getSnapshot(): ReadonlyMap<string, MapPeer>;
  subscribe(listener: () => void): () => void;
}

/** One account/map editor's transient presence. Only its overlay leaves subscribe to this store. */
export class MapPresenceStore implements MapPresenceSource {
  private snapshot: ReadonlyMap<string, MapPeer> = new Map();
  private listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: ReadonlyMap<string, MapPeer>) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  set(connectionId: string, peer: MapPeer) {
    this.publish(new Map(this.snapshot).set(connectionId, peer));
  }
  expire(now: number) {
    const expired = [...this.snapshot].filter(([, peer]) => Date.parse(peer.expiresAt) <= now);
    if (!expired.length) return;
    const next = new Map(this.snapshot);
    for (const [key] of expired) next.delete(key);
    this.publish(next);
  }
  clear() {
    if (this.snapshot.size) this.publish(new Map());
  }
}
