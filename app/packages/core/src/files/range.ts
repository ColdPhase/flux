/**
 * HTTP byte ranges for stored files (C-61, RFC 9110 §14): what a `Range` header asks of an object of `size` bytes.
 *
 * - One `bytes=a-b`, `bytes=a-` or `bytes=-n` range that touches the object is `partial`, `end` clamped to the last byte.
 * - A range that starts at or past the end (or asks for the last 0 bytes) is `unsatisfiable`: a 416 whose Content-Range names the object's size.
 * - Anything else is `full`: no header, another unit, several ranges, a header that does not parse, and a last byte before the first
 *   all mean the whole object, which the standard allows and every player copes with.
 */
export type ByteRange = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

const SINGLE = /^bytes=(\d{1,15})?-(\d{1,15})?$/;

export function parseRange(header: string | undefined, size: number): ByteRange {
  const match = header === undefined ? null : SINGLE.exec(header.trim());
  if (!match || size < 1) return { kind: 'full' };
  const [, first, last] = match;
  if (first === undefined && last === undefined) return { kind: 'full' };
  if (first === undefined) {
    const suffix = Number(last);
    return suffix === 0 ? { kind: 'unsatisfiable' } : { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== undefined && Number(last) < start) return { kind: 'full' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: last === undefined ? size - 1 : Math.min(Number(last), size - 1) };
}
