import type { EditingServerMessage, LiveMapBootstrap, LiveMapDelta, LiveMapGesture, LiveMapLease, LiveMapPosition, UndoLiveMap, UndoneLiveMap, NamedPrincipal } from '@flux/contracts';

/** The server adapter derives this identity from the current session, never a wire actor. */
export interface MapIdentity { sessionId: string; actorId: string }
export type MapTransient = Extract<EditingServerMessage, { type: 'map-presence' | 'map-move' | 'map-clear' }>;
export interface MapConfirmed {
  generation: string; sequence: number; hash: string; workspaceId: string; resourceId: string;
  actor: NamedPrincipal; canWrite: boolean;
  /** At most one ordered commit; each postimage is projected for this current reader. */
  delta: LiveMapDelta | null;
  /** Bounded currently-authorized leases/presence, never an event or private recovery input. */
  transient: MapTransient[];
}
export interface MapMove {
  generation: string; gestureId: string; leaseId: string; sequence: number; positions: LiveMapPosition[];
}
export interface MapCancel { generation: string; gestureId: string; leaseId: string }
export interface MapPresence {
  generation: string; selected: string[]; cursor: { x: number; y: number } | null;
}
/**
 * Each method owns a SQL transaction: current session FOR SHARE, current native sketch policy,
 * native sketch/material lock, then room/lease locks in that order. Before a handoff callback,
 * repeat the SQL clock check; the callback synchronously hands off at most one protected frame.
 * A successful operation commits before another transaction delivers its protected result.
 */
export interface LiveMapBackend {
  bootstrap(identity: MapIdentity, sketchId: string, handoff: (head: LiveMapBootstrap) => void): Promise<void>;
  authorize(identity: MapIdentity, sketchId: string, handoff: () => void): Promise<void>;
  /** Legacy native reply is projected under current material rights before its protected handoff. */
  deliverNative(identity:MapIdentity,sketchId:string,body:unknown,handoff:(body:unknown)=>void):Promise<void>;
  acquire(identity: MapIdentity, sketchId: string, gesture: LiveMapGesture): Promise<LiveMapLease>;
  /** First authorized movement/cancel binds the lease to this server-generated connection. */
  move(identity: MapIdentity, sketchId: string, connectionId: string, command: MapMove): Promise<void>;
  cancel(identity: MapIdentity, sketchId: string, connectionId: string, command: MapCancel): Promise<void>;
  presence(identity: MapIdentity, sketchId: string, connectionId: string, command: MapPresence): Promise<void>;
  /** Commit receipt/delta is looked up under current authority; UUID namespace remains immutable. */
  undo(identity: MapIdentity, sketchId: string, command: UndoLiveMap): Promise<string>;
  deliverUndo(identity: MapIdentity, sketchId: string, commandId: string, handoff: (receipt: UndoneLiveMap) => void): Promise<void>;
  deliver(identity: MapIdentity, sketchId: string, generation: string, afterSequence: number, handoff: (result: MapConfirmed) => void,
    options?: { includeDelta?: boolean }): Promise<void>;
  /** Best-effort immediate cleanup; durable expiry/current policy independently revoke delivery. */
  disconnect(identity: MapIdentity, sketchId: string, connectionId: string): Promise<void>;
  close(): Promise<void>;
}
