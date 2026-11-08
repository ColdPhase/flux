import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { useDomainErrors } from '../../apps/server/src/http/errors.js';

// Fastify names a second error handler set in the same scope (FSTWRN004). Route groups that need their own handler set it in their
// own scope; one that wrapped the shared handler set two in one scope and made every API start log the warning (#916).
const collect = () => {
  // The code and the message: a failure that shows only "FSTWRN004" sends the reader to look the warning up.
  const seen: string[] = [];
  const listener = (warning: Error & { code?: string }) => { if (warning.code?.startsWith('FST')) seen.push(`${warning.code}: ${warning.message}`); };
  process.on('warning', listener);
  return { warnings: seen, stop: () => { process.removeListener('warning', listener); } };
};
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 50); });

test('the detector sees a second error handler in one scope (positive control)', async () => {
  const seen = collect();
  const app = Fastify();
  try {
    useDomainErrors(app);
    app.setErrorHandler((_error, _request, reply) => reply.code(500).send({}));
    await app.ready();
    await settle();
    assert.equal(seen.warnings.length, 1, seen.warnings.join('\n'));
    assert.match(seen.warnings[0]!, /^FSTWRN004: /);
  } finally { seen.stop(); await app.close(); }
});

test('building the whole API logs no Fastify warning, FSTWRN004 included', async () => {
  const seen = collect();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `fastify-warnings-${'x'.repeat(40)}`,
    FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080',
  };
  const app = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'));
  try {
    await app.ready();
    await settle();
    assert.deepEqual(seen.warnings, [], 'the warnings Fastify emitted while the API was built');
  } finally { seen.stop(); await app.close(); }
});
