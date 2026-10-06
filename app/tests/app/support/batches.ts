/**
 * Fixture requests at a time (#271): fewer than the API's 10 pooled connections, so creating fixtures never
 * queues for one. Each write ends with the stream's event insert, under one global lock until commit; a burst
 * larger than the pool waits behind it, and on a busy host that wait outgrew the pool's connection timeout.
 */
export const FIXTURE_CONCURRENCY = 5;

/** `make(0)` … `make(count - 1)`, at most `size` at a time; the results keep index order. */
export async function inBatches<T>(count: number, make: (index: number) => Promise<T>, size = FIXTURE_CONCURRENCY): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < count; start += size) {
    results.push(...await Promise.all(Array.from({ length: Math.min(size, count - start) }, (_, offset) => make(start + offset))));
  }
  return results;
}
