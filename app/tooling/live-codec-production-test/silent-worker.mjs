import { parentPort } from 'node:worker_threads';
// Deliberately omit readiness. Parent must terminate this isolated negative control.
parentPort.on('message', () => {});
