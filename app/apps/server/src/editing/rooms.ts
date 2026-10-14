import { CAPS } from './codec/caps.mjs';
import { stateCharge } from './codec/codec.mjs';
import type { CodecState } from './codec/types.js';

interface Room { generation: string; revision: number; state: CodecState; charge: number }

/**
 * Decoded wiki rooms of this API process (founder direction 2026-10-09, B1). An optimization only:
 * a room is used solely while its revision equals the locked head's, so another process's commit,
 * an enrollment, a retired generation or an unknown COMMIT outcome makes it stale, never wrong.
 * Only committed states enter it. Bounded by the existing room cache caps; the least recently used
 * room leaves first.
 */
export class DecodedRooms {
  private rooms = new Map<string, Room>();
  bytes = 0;
  constructor(private limits = { rooms: CAPS.caches, bytes: CAPS.cacheBytes }) {}
  get size() { return this.rooms.size; }
  get(docId: string, generation: string) {
    const room = this.rooms.get(docId);
    if (!room || room.generation !== generation) return null;
    this.rooms.delete(docId); this.rooms.set(docId, room);
    return room;
  }
  /** `charge`: the state's stateCharge when the codec already computed it. */
  put(docId: string, generation: string, revision: number, state: CodecState, charge?: number) {
    const old = this.rooms.get(docId);
    // A later transaction of this process may already have installed a newer committed revision.
    if (old && old.generation === generation && old.revision >= revision) return;
    this.drop(docId);
    // A committed state arrives with the charge its codec admission measured; only a rebuilt one is measured here.
    const exact = charge ?? stateCharge(state);
    if (exact > CAPS.roomCacheBytes || exact > this.limits.bytes) return;
    for (const [key] of this.rooms) {
      if (this.rooms.size < this.limits.rooms && this.bytes + exact <= this.limits.bytes) break;
      this.drop(key);
    }
    this.rooms.set(docId, { generation, revision, state, charge: exact }); this.bytes += exact;
  }
  drop(docId: string) {
    const old = this.rooms.get(docId);
    if (old) { this.bytes -= old.charge; this.rooms.delete(docId); }
  }
  clear() { this.rooms.clear(); this.bytes = 0; }
}
