import { open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PgBoss } from 'pg-boss';
import { FLUX_SCHEMA_VERSION, PG_BOSS_SCHEMA_VERSION } from '@flux/db';
import { SAMPLE_COMMAND_PATH, type SampleCommand } from '@flux/contracts';
import { createSample, SAMPLE_JOB } from '@flux/core';
import { registerDatabase } from './plugins/database.js';
import { loadIdentityConfig, registerIdentity } from './identity/index.js';
import { accessRoutes } from './access/routes.js';
import { sketchRoutes } from './sketches/routes.js';
import { loadPushServerConfig, pushRoutes } from './push/index.js';
import { setStaticHeaders } from './pwa/static-headers.js';
import { streamRoutes } from './stream/index.js';
import { conversationRoutes } from './conversation/routes.js';
import { workRoutes } from './work/routes.js';
import { liveRoutes } from './live/routes.js';
import { liveAccess } from './live/access.js';
import { liveSessionStore } from './live/store.js';
import { createLiveMediaFromEnv, liveMediaConfig } from './live/media.js';
import { liveRevocationCoordinator } from './live/revocation.js';
import { liveDiscoveryRoutes } from './live/discovery.js';
import { liveLifecycle } from './live/lifecycle.js';
import { liveWebhookRoutes } from './live/webhook.js';
import { liveInvitationRoutes } from './live/invitation-routes.js';

const connectionString = process.env.DATABASE_URL;
const fixtureToken = process.env.FLUX_FIXTURE_TOKEN;
const testFailureInjection = process.env.FLUX_TEST_FAILURE_INJECTION === 'true';
const filesDir = process.env.FLUX_FILES_DIR ?? '/data/files';
if (!connectionString) throw new Error('DATABASE_URL is required');
const identityConfig = loadIdentityConfig();
const pushConfig = loadPushServerConfig();
const app = Fastify({ logger: true, trustProxy: identityConfig.trustedProxies.length ? identityConfig.trustedProxies : false });
const { pool, db } = registerDatabase(app, connectionString);
const boss = new PgBoss({ connectionString, migrate: false });
boss.on('error', (error) => app.log.error(error));
await boss.start();
app.addHook('onClose', async () => boss.stop());
const identity = registerIdentity(app, { db, config: identityConfig });
const liveMedia = createLiveMediaFromEnv();
const lifecycle = liveMedia ? liveLifecycle(db, pool, liveMedia.media) : null;
const liveRevocation = liveMedia ? liveRevocationCoordinator(db, pool, liveMedia.media, lifecycle!) : null;
await app.register(accessRoutes, { db, sessions: identity, boss, liveRevocation });
await app.register(sketchRoutes, { db, sessions: identity });
await app.register(pushRoutes, { db, sessions: identity, config: pushConfig });
if (pushConfig.status === 'unavailable') app.log.warn(pushConfig.reason);
await app.register(websocket, { options: { maxPayload: 1024 } });
const heartbeatMs = Number(process.env.FLUX_STREAM_HEARTBEAT_MS ?? 25_000);
if (!Number.isInteger(heartbeatMs) || heartbeatMs < 100) throw new Error('FLUX_STREAM_HEARTBEAT_MS must be an integer of at least 100');
await app.register(streamRoutes, { db, sessions: identity, publicOrigin: identityConfig.publicOrigin, connectionString, heartbeatMs, cursorSecret: identityConfig.secret, exposeWork: testFailureInjection });
await app.register(conversationRoutes, { db, sessions: identity });
await app.register(workRoutes, { db, sessions: identity });
// Configuration alone does not prove the SFU, DNS/TLS or receiver path is healthy.
app.get('/api/v1/live-sessions/capabilities', async () => ({ status: liveMedia ? 'configured' : 'unavailable' }));
if (liveMedia) await app.register(liveRoutes, {
  sessions: identity,
  ports: { access: liveAccess(db), sessions: liveSessionStore(db), ...liveMedia },
  lifecycle: lifecycle!,
});
if (liveMedia) await app.register(liveDiscoveryRoutes, { db, sessions: identity, media: liveMedia.media });
if (liveMedia) await app.register(liveInvitationRoutes, { db, sessions: identity, cursorSecret: identityConfig.secret });
if (lifecycle) {
  const config = liveMediaConfig(process.env);
  await app.register(liveWebhookRoutes, { pool, apiKey: config.apiKey, apiSecret: config.apiSecret,
    requestReconcile: (sessionId, generation) => lifecycle.reconcile(sessionId, generation).then(() => undefined) });
  const pruneWebhooks = async () => {
    try {
      await pool.query(`DELETE FROM live_webhook_events WHERE event_id IN (
        SELECT event_id FROM live_webhook_events
        WHERE received_at < now() - interval '7 days'
        ORDER BY received_at LIMIT 1000)`);
    } catch (error) { app.log.warn({ error }, 'Live webhook event retention is pending'); }
  };
  const webhookRetentionTimer = setInterval(() => { void pruneWebhooks(); }, 600_000);
  webhookRetentionTimer.unref();
  app.addHook('onClose', async () => clearInterval(webhookRetentionTimer));
  void pruneWebhooks();
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await lifecycle.sweep(); }
    catch (error) { app.log.error({ error }, 'Live session lifecycle sweep is pending'); }
    finally { sweeping = false; }
  };
  const sweepTimer = setInterval(() => { void sweep(); }, 30_000);
  sweepTimer.unref();
  app.addHook('onClose', async () => clearInterval(sweepTimer));
  void lifecycle.recoverPending().catch((error) => app.log.error({ error }, 'Live session lifecycle recovery is pending'));
  void sweep();
}
if (liveRevocation) {
  let recovering = false;
  const recover = async () => {
    if (recovering) return;
    recovering = true;
    try { await liveRevocation.recoverPending(); }
    catch (error) { app.log.error({ error }, 'Live media room recovery is pending'); }
    finally { recovering = false; }
  };
  const recoveryTimer = setInterval(() => { void recover(); }, 10_000);
  recoveryTimer.unref();
  app.addHook('onClose', async () => clearInterval(recoveryTimer));
  void recover();
}

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
  schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string' } } } },
  preValidation: async (request, reply) => {
    // Fastify's default AJV removes unknown body fields before validation.
    if (request.body && typeof request.body === 'object' && 'failAfterInsert' in request.body) {
      return reply.code(400).send({ error: 'Unknown command field' });
    }
  },
}, async (request, reply) => {
  if (!fixtureToken || request.headers.authorization !== `Bearer ${fixtureToken}`) return reply.code(401).send({ error: 'Unauthorized' });
  try {
    const result = await createSample({ id: 'fixture', kind: 'fixture' }, request.body, db, boss,
      testFailureInjection && request.headers['x-flux-test-failure'] === 'after-insert');
    return reply.code(201).send(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Forced rollback') return reply.code(409).send({ error: error.message });
    if (error instanceof Error && error.message.startsWith('Title must')) return reply.code(400).send({ error: error.message });
    throw error;
  }
});

await fastifyStatic(app, { root: join(process.cwd(), 'apps/web/dist'), prefix: '/', cacheControl: false, setHeaders: setStaticHeaders });
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not Found' });
  if (!request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: 'Not Found' });
  return reply.sendFile('index.html');
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
app.log.info({ queue: SAMPLE_JOB }, 'Flux API ready');
