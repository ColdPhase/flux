import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useLocation, useNavigationType, type Location, type NavigationType } from 'react-router';

/**
 * Where each history entry was left (#592): small, JSON-shaped records of the reader's place in that entry
 * (scroll anchors, panel and filter state), keyed by the entry's own `location.key` and retained in session
 * storage, so Back, Forward and the "‹ origin" control find the place as it was. Nothing here is sent to the
 * server. Docs: docs/development/return-to-origin.md.
 */

/** The history entry the person is on: its router key and its path (pathname and search, never the hash). */
export interface Entry { key: string; path: string }
/** A record is the place of the page, not of one spelling of its query: a page that mirrors its view into the address keeps its entry. */
const pageOf = (path: string) => path.replace(/[?#].*$/, '');

const PREFIX = 'flux:place:';
const INDEX = 'flux:place:index';
/** Entries kept per tab; older ones are forgotten, never new ones. */
const KEEP = 60;
/** The place is kept in memory at once and written to session storage a moment later, so scrolling never waits on storage. */
const WRITE_AFTER_MS = 250;

interface PlaceRecord { path: string; slots: { [slot: string]: unknown } }
const memory = new Map<string, PlaceRecord>();
let entry: Entry = { key: 'default', path: '' };
let booted = false;
/** The keys in the order they were last used, oldest first; null until read. */
let recent: string[] | null = null;
const unwritten = new Set<string>();
let writeTimer = 0;

export const entryOf = (location: Pick<Location, 'key' | 'pathname' | 'search'>): Entry => ({ key: location.key, path: `${location.pathname}${location.search}` });

/** The entry on show. The shell sets it while rendering a location, so children's effects see their own entry. */
export function setCurrentEntry(next: Entry) { entry = next; }
export const currentEntry = (): Entry => entry;

export const isBooted = () => booted;

/** Called once the first screen of this document is on show: a reload is not a return, and never restores. */
export function markBooted() { booted = true; }

function load(key: string): PlaceRecord | null {
  const held = memory.get(key);
  if (held) return held;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || typeof (value as PlaceRecord).path !== 'string' || typeof (value as PlaceRecord).slots !== 'object' || !(value as PlaceRecord).slots) return null;
    memory.set(key, value as PlaceRecord);
    return value as PlaceRecord;
  } catch { return null; }
}

function order(): string[] {
  if (recent) return recent;
  try {
    const known: unknown = JSON.parse(sessionStorage.getItem(INDEX) ?? '[]');
    recent = Array.isArray(known) ? known.filter((item): item is string => typeof item === 'string') : [];
  } catch { recent = []; }
  return recent;
}

/** Writes what has not been written yet: when the page is hidden, and as a reference is followed. */
function writeNow() {
  writeTimer = 0;
  try {
    for (const key of unwritten) {
      const record = memory.get(key);
      if (record) sessionStorage.setItem(PREFIX + key, JSON.stringify(record));
    }
    sessionStorage.setItem(INDEX, JSON.stringify(order()));
  } catch { /* This visit keeps the place in memory. */ }
  unwritten.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', writeNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeNow(); });
}

/** Keep one slot of the place of an entry (the current one by default). */
export function remember(slot: string, value: unknown, at: Entry = entry) {
  let record = load(at.key);
  if (!record || pageOf(record.path) !== pageOf(at.path)) { record = { path: at.path, slots: {} }; memory.set(at.key, record); }
  record.slots[slot] = value;
  const used = order();
  if (used.at(-1) !== at.key) {
    used.splice(0, used.length, ...used.filter((key) => key !== at.key), at.key);
    for (const old of used.splice(0, Math.max(0, used.length - KEEP))) {
      memory.delete(old);
      unwritten.delete(old);
      try { sessionStorage.removeItem(PREFIX + old); } catch { /* nothing to remove */ }
    }
  }
  unwritten.add(at.key);
  if (!writeTimer) writeTimer = window.setTimeout(writeNow, WRITE_AFTER_MS);
}

/** What was kept for a slot of an entry, when the entry is the same page it was kept for. */
export function recall<T>(slot: string, at: Entry = entry): T | undefined {
  const record = load(at.key);
  return record && pageOf(record.path) === pageOf(at.path) ? record.slots[slot] as T | undefined : undefined;
}

/** The state `navigate(origin.path, ...)` carries when there is no earlier entry to step back to. */
export interface ReturnState { restore?: { key: string; path: string } }

/**
 * The entry a screen is arriving at, when that is a return: Back, Forward, Alt+←, the phone's back gesture or the
 * origin control (a pop), after this document showed its first screen. Otherwise null: a first visit, a link,
 * or a reload shows the screen as it always opens.
 */
export function arrivalEntry(location: Location, type: NavigationType): Entry | null {
  const restore = (location.state as ReturnState | null)?.restore;
  if (restore && typeof restore.key === 'string' && typeof restore.path === 'string' && type !== 'POP') return restore;
  return booted && type === 'POP' ? entryOf(location) : null;
}

/** The entry this screen opened at when that was a return, fixed for the life of the screen; null for any other way of arriving. */
export function useArrival(): Entry | null {
  const location = useLocation();
  const type = useNavigationType();
  const [arrival] = useState(() => arrivalEntry(location, type));
  return arrival;
}

/**
 * `useState` for a small piece of a screen's state that a return should find as it was left: the filter an
 * Inbox shows, the groups a search opened. It is kept under the entry's key as it changes.
 */
export function usePlaceState<T>(slot: string, initial: () => T, arrival: Entry | null, valid: (value: unknown) => value is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const kept = arrival ? recall<unknown>(slot, arrival) : undefined;
    return valid(kept) ? kept : initial();
  });
  useEffect(() => { remember(slot, value); }, [slot, value]);
  return [value, setValue];
}

const flushers = new Set<() => void>();
/** A screen that keeps its place on a timer or a frame registers how to write it now; returns how to stop. */
export function onFlush(write: () => void): () => void {
  flushers.add(write);
  return () => { flushers.delete(write); };
}
/** Write every screen's place as it is this instant: called as a link is followed, before the screen goes. */
export function flushPlace() {
  for (const write of flushers) write();
  writeNow();
}
