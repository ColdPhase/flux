import { parentPort, resourceLimits } from 'node:worker_threads';
import { admit } from './codec.mjs';
parentPort.on('message', ({ state, envelope, bytes, canWrite, charge }) => {
  try { parentPort.postMessage({ kind: 'result', ok: true, ...admit(state, envelope, new Uint8Array(bytes), canWrite, charge) }); }
  catch (error) { parentPort.postMessage({ kind: 'result', ok: false, code: error.code ?? 'CODEC_FAILURE' }); }
});
parentPort.postMessage({ kind: 'ready', resourceLimits });
