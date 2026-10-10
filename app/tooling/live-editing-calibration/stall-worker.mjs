import { parentPort, resourceLimits } from 'node:worker_threads';
// Explicit hostile-worker control proves hard termination; never used in production.
parentPort.on('message', () => { for (;;) { /* bounded by parent deadline/termination */ } });
parentPort.postMessage({ kind: 'ready', resourceLimits });
