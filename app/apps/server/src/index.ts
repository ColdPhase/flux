import { SAMPLE_JOB } from '@flux/db';
import { buildApp } from './app.js';
import { loadServerConfig } from './config.js';

// The API process (#88): environment, build, listen. Everything else is in app.ts.
const config = loadServerConfig();
const app = await buildApp(config);
await app.listen({ host: '0.0.0.0', port: config.port });
app.log.info({ queue: SAMPLE_JOB }, 'Flux API ready');

let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Leaves room inside the runner's eight-second Docker stop deadline (#228). Failure is
  // a nonzero actual process outcome; it never invents a terminal drained record.
  const deadline = setTimeout(() => { process.stderr.write('Flux API graceful shutdown deadline expired\n'); process.exit(1); }, 7000);
  try {
    if (!await app.closeGracefully()) process.exitCode = 1;
  } catch (error) {
    process.exitCode = 1;
    app.log.error({ error }, 'Flux API graceful shutdown failed');
  } finally {
    clearTimeout(deadline);
  }
}
process.once('SIGTERM', () => { void gracefulShutdown(); });
process.once('SIGINT', () => { void gracefulShutdown(); });
