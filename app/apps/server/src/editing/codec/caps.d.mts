export const CAPS: Readonly<{
  frameBytes: 65536; chunkBytes: 61440; assemblyBytes: 8388608;
  chunks: 144; assemblyTimeoutMs: 10000; outputWindowBytes: 1048576;
  assembliesPerConnection: 1; assembliesPerApi: 4;
  assembliesBytesPerApi: 33554432;
  workers: 2; workerHeapMiB: 64; workerTimeoutMs: 100; waitingTasks: 8;
  workerOldMiB: 48; workerYoungMiB: 16; workerCodeMiB: 16; workerStackMiB: 2;
  workerBootstrapMs: 2000; admissionWaitMs: 3000;
  caches: 16; cacheBytes: 134217728; roomCacheBytes: 8388608; sockets: 32;
  bodyUnits: 100000; intentRegistryBytes: 8388608;
  structs: 65536; deleteRanges: 65536;
}>;
