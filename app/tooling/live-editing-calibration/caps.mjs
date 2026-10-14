// Accepted calibration candidates; no deployed route imports this fixture.
export const CAPS = Object.freeze({
  frameBytes: 65_536, chunkBytes: 61_440, assemblyBytes: 8 * 1024 * 1024,
  chunks: 144, assemblyTimeoutMs: 10_000, outputWindowBytes: 1024 * 1024,
  assembliesPerConnection: 1, assembliesPerApi: 4,
  assembliesBytesPerApi: 32 * 1024 * 1024,
  workers: 2, workerHeapMiB: 64, workerTimeoutMs: 100, waitingTasks: 8,
  workerOldMiB: 48, workerYoungMiB: 16, workerCodeMiB: 16, workerStackMiB: 2,
  workerBootstrapMs: 2_000,
  admissionWaitMs: 3_000,
  caches: 16, cacheBytes: 128 * 1024 * 1024, roomCacheBytes: 8 * 1024 * 1024, sockets: 32,
  bodyUnits: 100_000,
  intentRegistryBytes: 8 * 1024 * 1024,
  // Finite structural accounting, independently measurable inside the worker.
  structs: 65_536, deleteRanges: 65_536,
});
