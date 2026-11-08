/**
 * How often an editor connection is read on its timer (#850, #862). Every change to a room reaches its connections at once, through
 * the database's NOTIFY, the connection's own messages and its acknowledgements; the timer behind them retries what capacity refused
 * and notices that access has ended. A connection nothing has touched for ACTIVE_FOR_MS is read on the timer every IDLE_EVERY_MS
 * instead of every TICK_MS: an open, untouched editor then costs a few statements a minute, not thousands (each read is a full access
 * check under row locks), and a person who lost access still hears of it within IDLE_EVERY_MS. Any event wakes it for ACTIVE_FOR_MS.
 */
export const TICK_MS = 250;
export const IDLE_EVERY_MS = 2000;
export const ACTIVE_FOR_MS = 5000;

export interface Cadence { activeAt: number; readAt: number }

export function newCadence(now = Date.now()): Cadence { return { activeAt: now, readAt: now }; }

/** Something happened to this connection: it is read every tick for a while. */
export function touch(cadence: Cadence, now = Date.now()): void { cadence.activeAt = now; }

/** Whether the timer reads the connection now; `busy` is any work in flight, retained or waiting for it. */
export function readDue(cadence: Cadence, busy: boolean, now = Date.now()): boolean {
  if (busy || now - cadence.activeAt < ACTIVE_FOR_MS || now - cadence.readAt >= IDLE_EVERY_MS) { cadence.readAt = now; return true; }
  return false;
}
