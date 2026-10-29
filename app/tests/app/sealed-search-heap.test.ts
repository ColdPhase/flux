import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { test } from 'node:test';
import { containerMemoryLimit, docHeapCost, SealedSearchIndex, sealedSearchLimits, SEALED_SEARCH_DEFAULT_MAX_BYTES, SEALED_SEARCH_DEFAULT_PROCESS_MAX_BYTES, type IndexDoc } from '@flux/db';

// F-030 S2b (#655): FLUX_SEALED_SEARCH_MAX_BYTES and the process-wide bound count ESTIMATED HEAP, so they bound memory. This test builds
// indexes of very different shapes, forces a full GC, and compares the heap that grew with the index's own estimate: the estimate must
// never fall below the measurement (an operator's bound would then let the process exceed it) and must stay within a small multiple
// (a bound that is far too loose wastes the memory it protects). Unique terms dominate the heap: each costs a map entry, a string and
// an array, so the ratio of heap to text is 1.7 to 8.

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;

const word = (n: number) => `w${n.toString(36)}`;
function doc(n: number, title: string, body: string): IndexDoc {
  const audience = `project:${n % 8}`;
  return { id: String(n + 1), key: `message:${n}`, kind: 'message', audience, workspaceId: 'w', projectId: String(n % 8), objectId: `object-${n}-${randomBytes(6).toString('hex')}`,
    parentId: null, dmId: null, version: null, status: null, author: { kind: 'human', id: 'user-1' }, at: new Date(1_700_000_000_000 + n), atKey: '2026-01-01 00:00:00+00',
    atMicros: 1n, title, body, number: null, hidden: false, cost: docHeapCost(title, body), indexCost: 0 };
}

const corpora: Record<string, (n: number) => IndexDoc> = {
  // 2000 messages of 60 words from a 4000-word vocabulary.
  natural: (n) => doc(n, '', Array.from({ length: 60 }, (_, k) => word((n * 7 + k * 131) % 4000)).join(' ')),
  // Titles and bodies, a 6000-word vocabulary.
  mixed: (n) => doc(n, Array.from({ length: 4 }, (_, k) => word((n * 3 + k) % 6000)).join(' '), Array.from({ length: 80 }, (_, k) => word((n * 11 + k * 17) % 6000)).join(' ')),
  // Identifier-like text: every token is new.
  identifiers: (n) => doc(n, '', Array.from({ length: 100 }, () => randomBytes(5).toString('hex')).join(' ')),
  // Many short titles (the trigram postings).
  titles: (n) => doc(n, `Task ${word(n)} ${randomBytes(3).toString('hex')}`, ''),
};

/** Builds an index in its own frame and returns what it measured, so nothing of it is live when the next one is measured. */
function measure(make: (n: number) => IndexDoc, count: number) {
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const index = new SealedSearchIndex('w');
  let text = 0;
  for (let n = 0; n < count; n += 1) { const d = make(n); text += d.title.length + d.body.length; index.put(d); }
  gc(); gc();
  const measured = process.memoryUsage().heapUsed - before;
  const result = { text, measured, estimated: index.heap, size: index.size };
  return { ...result, live: index.size }; // reading the index here keeps it live until after the measurement
}

test('the estimated heap of an index is never below the measured heap, and stays within a small multiple', () => {
  const rows: string[] = [];
  const results: [string, number, number, number][] = [];
  for (const [name, make] of Object.entries(corpora)) {
    const count = name === 'titles' ? 6000 : 2000;
    // One warm-up build settles the heap; then three builds. A measurement can only be disturbed by garbage the collector had not freed
    // yet, so the estimate must cover the largest of the three and may not exceed 2.5 times the median.
    measure(make, count);
    const runs = [measure(make, count), measure(make, count), measure(make, count)];
    const measured = runs.map((run) => run.measured).sort((a, b) => a - b);
    const { text, estimated, size } = runs[0]!;
    rows.push(`${name}: text ${text} B, measured ${measured.join('/')} B, estimated ${estimated} B (x${(estimated / measured[1]!).toFixed(2)} the median), heap/text ${(measured[1]! / text).toFixed(1)}`);
    assert.equal(size, count);
    results.push([name, measured[2]!, measured[1]!, estimated]);
  }
  console.log(rows.join('\n'));
  for (const [name, largest, median, estimate] of results) {
    assert.ok(estimate >= largest, `${name}: the estimate ${estimate} is below the measured heap ${largest}`);
    assert.ok(estimate <= median * 2.5, `${name}: the estimate ${estimate} is more than 2.5 times the measured heap ${median}`);
  }
});

test('removing documents lowers the estimate by their strings, keeps their stale postings, and a rebuild frees them', () => {
  const index = new SealedSearchIndex('w');
  for (let n = 0; n < 600; n += 1) index.put(corpora.identifiers!(n));
  const full = index.heap;
  for (let n = 0; n < 100; n += 1) index.remove(`message:${n}`);
  assert.ok(index.heap < full, 'the strings of removed documents are released');
  assert.ok(index.heap > full * 0.8, 'their postings stay until the partition is rebuilt');
  for (let n = 100; n < 590; n += 1) index.remove(`message:${n}`);
  // A partition is rebuilt once its stale postings pass 64 KiB and outweigh the live ones (eight partitions here).
  assert.ok(index.heap < full * 0.6, `the stale postings are freed by a rebuild (${index.heap} of ${full})`);
  // Replacing the same documents again and again must not grow the estimate without bound: a partition is rebuilt once its stale postings dominate.
  const steady = new SealedSearchIndex('w');
  for (let round = 0; round < 40; round += 1) for (let n = 0; n < 40; n += 1) steady.put({ ...corpora.identifiers!(n), key: `message:${n}` });
  assert.ok(steady.heap < 40 * 40 * 100 * 40, `a rewritten set of 40 documents keeps a bounded estimate (${steady.heap})`);
});

test('the bounds come from the environment, and by default from the container memory: at most a quarter of it, 64 to 512 MiB', () => {
  const MiB = 1024 * 1024;
  assert.deepEqual(sealedSearchLimits({}, null), { workspace: SEALED_SEARCH_DEFAULT_MAX_BYTES, process: SEALED_SEARCH_DEFAULT_PROCESS_MAX_BYTES, idleMs: 5 * 60_000 });
  assert.ok(SEALED_SEARCH_DEFAULT_PROCESS_MAX_BYTES <= 512 * MiB && SEALED_SEARCH_DEFAULT_MAX_BYTES <= SEALED_SEARCH_DEFAULT_PROCESS_MAX_BYTES);
  // The default 2 GiB API container (FLUX_API_MEMORY) gets the 512 MiB cap; a smaller one a quarter of its memory; a tiny one the 64 MiB floor.
  assert.equal(sealedSearchLimits({}, 2048 * MiB).process, 512 * MiB);
  assert.equal(sealedSearchLimits({}, 8192 * MiB).process, 512 * MiB);
  assert.equal(sealedSearchLimits({}, 1024 * MiB).process, 256 * MiB);
  assert.equal(sealedSearchLimits({}, 1024 * MiB).workspace, 256 * MiB);
  assert.equal(sealedSearchLimits({}, 512 * MiB).process, 128 * MiB);
  assert.equal(sealedSearchLimits({}, 512 * MiB).workspace, 128 * MiB, 'a workspace never gets more than the process');
  assert.equal(sealedSearchLimits({}, 128 * MiB).process, 64 * MiB);
  // The operator's values win.
  assert.deepEqual(sealedSearchLimits({ FLUX_SEALED_SEARCH_MAX_BYTES: '1000', FLUX_SEALED_SEARCH_PROCESS_MAX_BYTES: '5000', FLUX_SEALED_SEARCH_IDLE_MS: '3000' }, 2048 * MiB),
    { workspace: 1000, process: 5000, idleMs: 3000 });
  assert.deepEqual(sealedSearchLimits({ FLUX_SEALED_SEARCH_MAX_BYTES: 'x', FLUX_SEALED_SEARCH_PROCESS_MAX_BYTES: '-1' }, null), sealedSearchLimits({}, null));
  // This container's own limit (or none) is read.
  const own = containerMemoryLimit();
  assert.ok(own === null || own > 0);
});
