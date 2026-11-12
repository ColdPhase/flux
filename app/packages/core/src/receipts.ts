import { RECEIPT_LIMITS, type MessageReader, type MessageReadersResult, type MessageReceiptRun } from '@flux/contracts';
import { InvalidInputError } from './access/errors.js';

/** Someone who observed every message of run number `run`, and when they finished (the last of those observations). */
export interface RunReader { run: number; id: string; name: string; at: Date }

/**
 * Where each reader's face goes (#1231): once, under the NEWEST run they observed whole. `runs` is in the order the client sent them,
 * oldest first, so a reader found in several runs is kept in the last one; later is newer. Each run's readers come back newest first
 * (the time they finished it, then the id), the order of the faces and of the list. Only current readers are passed in: who left or
 * lost access is the caller's filter, never a historical roster.
 */
export function placeReaders(found: readonly RunReader[], runCount: number): MessageReader[][] {
  const newest = new Map<string, RunReader>();
  for (const row of found) {
    const seen = newest.get(row.id);
    if (!seen || row.run > seen.run) newest.set(row.id, row);
  }
  const placed: MessageReader[][] = Array.from({ length: runCount }, () => []);
  const times = new Map<string, number>();
  for (const row of newest.values()) {
    placed[row.run]?.push({ id: row.id, name: row.name, at: row.at.toISOString() });
    times.set(row.id, row.at.getTime());
  }
  for (const list of placed) list.sort((a, b) => times.get(b.id)! - times.get(a.id)! || a.id.localeCompare(b.id));
  return placed;
}

/** One run as the receipts answer it: how many readers, and only the faces. */
export const receiptRun = (messageIds: string[], readers: readonly MessageReader[]): MessageReceiptRun =>
  ({ messageIds, count: readers.length, readers: readers.slice(0, RECEIPT_LIMITS.faces) });

/** The cursor of a page of readers: the time and id of its last reader, so a reader arriving meanwhile cannot repeat or skip one. */
const cursorOf = (reader: MessageReader) => `${new Date(reader.at).getTime()}.${reader.id}`;

/** A page of `RECEIPT_LIMITS.listPage` readers of one run (already newest first) after `after`. */
export function readersPage(readers: readonly MessageReader[], after: unknown): MessageReadersResult {
  let start = 0;
  if (after !== undefined) {
    const match = typeof after === 'string' ? /^(\d{1,16})\.(.{1,64})$/.exec(after) : null;
    if (!match) throw new InvalidInputError('after must be the next value of the previous page');
    const at = Number(match[1]), id = match[2]!;
    // The first reader strictly after the cursor in the list's own order.
    start = readers.findIndex((reader) => { const time = new Date(reader.at).getTime(); return time < at || (time === at && reader.id.localeCompare(id) > 0); });
    if (start < 0) start = readers.length;
  }
  const page = readers.slice(start, start + RECEIPT_LIMITS.listPage);
  return { count: readers.length, readers: page, next: start + page.length < readers.length ? cursorOf(page.at(-1)!) : null };
}

/** The run asked about by `readers`: a whole number that names one of the requested runs. */
export function runIndex(value: unknown, runCount: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= runCount) throw new InvalidInputError('run must be the index of one of the runs');
  return value as number;
}
