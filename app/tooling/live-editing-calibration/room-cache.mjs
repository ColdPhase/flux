import { CAPS } from './caps.mjs';
import { Refusal, stateCharge } from './codec.mjs';

/** Charged fixture cache, never an authority or persistence substitute. */
export class RoomCache {
  constructor() { this.rooms = new Map(); this.bytes = 0; }
  put(key, state) {
    const charge = stateCharge(state);
    const old = this.rooms.get(key);
    if (charge > CAPS.roomCacheBytes || this.bytes - (old?.charge ?? 0) + charge > CAPS.cacheBytes) throw new Refusal('CACHE_BYTES_LIMIT');
    if (!old && this.rooms.size >= CAPS.caches) throw new Refusal('CACHE_COUNT_LIMIT');
    this.rooms.set(key, { state, charge }); this.bytes += charge - (old?.charge ?? 0);
  }
  remove(key) {
    const old = this.rooms.get(key);
    if (old) { this.bytes -= old.charge; this.rooms.delete(key); }
  }
}
