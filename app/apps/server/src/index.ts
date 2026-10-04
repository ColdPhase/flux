import { SAMPLE_JOB } from '@flux/db';
import { buildApp } from './app.js';
import { loadServerConfig } from './config.js';

// The API process (#88): environment, build, listen. Everything else is in app.ts.
const config = loadServerConfig();
const app = await buildApp(config);
await app.listen({ host: '0.0.0.0', port: config.port });
app.log.info({ queue: SAMPLE_JOB }, 'Flux API ready');
