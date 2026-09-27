import { open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { PgBoss } from 'pg-boss';
import { FLUX_SCHEMA_VERSION, PG_BOSS_SCHEMA_VERSION } from '@flux/db';
import { SAMPLE_COMMAND_PATH, type SampleCommand } from '@flux/contracts';
import { createSample, SAMPLE_JOB } from '@flux/core';
import { registerDatabase } from './plugins/database.js';
import { loadIdentityConfig, registerIdentity } from './identity/index.js';

const connectionString = process.env.DATABASE_URL;
const fixtureToken = process.env.FLUX_FIXTURE_TOKEN;
const filesDir = process.env.FLUX_FILES_DIR ?? '/data/files';
if (!connectionString) throw new Error('DATABASE_URL is required');
const identityConfig = loadIdentityConfig();
const app = Fastify({ logger: true, trustProxy: identityConfig.trustedProxies.length ? identityConfig.trustedProxies : false });
const { pool, db } = registerDatabase(app, connectionString);
const boss = new PgBoss({ connectionString, migrate: false });
boss.on('error', (error) => app.log.error(error));
await boss.start();
app.addHook('onClose', async () => boss.stop());
registerIdentity(app, { db, config: identityConfig });

app.get('/api/v1/health', async (_request, reply) => {
  try {
    const version = await pool.query('SELECT max(version) AS version FROM flux_schema_version');
    if (Number(version.rows[0]?.version) !== FLUX_SCHEMA_VERSION) throw new Error('Schema mismatch');
    if ((await boss.schemaVersion()) !== PG_BOSS_SCHEMA_VERSION) throw new Error('Queue schema mismatch');
    const probe = join(filesDir, `.flux-health-${randomUUID()}`);
    const file = await open(probe, 'wx');
    try { await file.writeFile('ok'); } finally { await file.close(); await unlink(probe); }
    return { status: 'ok', schemaVersion: FLUX_SCHEMA_VERSION };
  } catch (error) {
    app.log.warn(error);
    return reply.code(503).send({ status: 'unavailable' });
  }
});

app.post<{ Body: SampleCommand }>(SAMPLE_COMMAND_PATH, {
  schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string' }, failAfterInsert: { type: 'boolean' } } } },
}, async (request, reply) => {
  if (!fixtureToken || request.headers.authorization !== `Bearer ${fixtureToken}`) return reply.code(401).send({ error: 'Unauthorized' });
  try {
    const result = await createSample({ id: 'fixture', kind: 'fixture' }, request.body, db, boss);
    return reply.code(201).send(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Forced rollback') return reply.code(409).send({ error: error.message });
    if (error instanceof Error && error.message.startsWith('Title must')) return reply.code(400).send({ error: error.message });
    throw error;
  }
});

await fastifyStatic(app, { root: join(process.cwd(), 'apps/web/dist'), prefix: '/' });
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not Found' });
  if (!request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: 'Not Found' });
  return reply.sendFile('index.html');
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
app.log.info({ queue: SAMPLE_JOB }, 'Flux API ready');
