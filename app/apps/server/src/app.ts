import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PgBoss } from 'pg-boss';
import { assertExactMigrationLedger, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { registerDatabase } from './plugins/database.js';
import { registerIdentity } from './identity/index.js';
import { accessRoutes } from './access/routes.js';
import { sketchRoutes } from './sketches/routes.js';
import { dmRoutes } from './direct-messages/routes.js';
import { pushRoutes } from './push/index.js';
import { setStaticHeaders } from './pwa/static-headers.js';
import { streamRoutes } from './stream/index.js';
import { conversationRoutes } from './conversation/routes.js';
import { diskFileStorage } from './files/storage.js';
import { fileRoutes } from './files/routes.js';
import { workRoutes } from './work/routes.js';
import { workReadRoutes } from './work-read/routes.js';
import { liveRoutes } from './live/routes.js';
import { liveAccess } from './live/access.js';
import { liveSessionStore } from './live/store.js';
import { createLiveMediaFromEnv } from './live/media.js';
import { registerLiveSignaling } from './live/signaling.js';
import { liveRevocationCoordinator } from './live/revocation.js';
import { liveDiscoveryRoutes } from './live/discovery.js';
import { liveLifecycle } from './live/lifecycle.js';
import { liveWebhookRoutes } from './live/webhook.js';
import { liveInvitationRoutes } from './live/invitation-routes.js';
import { joinRateLimiter } from './live/rate-limit.js';
import { agentProposalRoutes } from './agent-connection/routes.js';
import { projectAgentRoutes } from './agent-connection/project-agents.js';
import { agentPolicyRoutes } from './agent-connection/project-policy.js';
import { agentMcpPolicyRoutes } from './agent-connection/mcp-policy-routes.js';
import { proactiveComparisonRoutes } from './proactive-comparison/routes.js';
import { registerMcpRoute } from './agent-connection/mcp-route.js';
import { returnRoutes } from './returns/routes.js';
import { docRoutes } from './docs/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { searchRoutes } from './search/routes.js';
import { personalRunRoutes } from './personal-runs/routes.js';
import { personalRunServerComposition } from './personal-runs/composition.js';
import { exportRoutes } from './export/routes.js';
import { agentRuntimeRoutes } from './agent-runtime/routes.js';
import { typingRoutes } from './typing/routes.js';
import { typingTaskDiscussion } from './typing/tasks.js';
import { githubRoutes } from './github/routes.js';
import { loadGithubConfig } from './github/config.js';
import type { ServerConfig } from './config.js';
import { fixtureFlags, registerFixtureRoutes } from './fixture/index.js';
import { registerHealth } from './health/routes.js';
import { useDomainErrors } from './http/errors.js';
import { useJsonCompression } from './http/compress.js';
import { useFramingProtection } from './http/framing.js';

/**
 * The API's composition root (#88): builds every route and background loop from one loaded
 * configuration, without listening, so tests can build it with their own configuration.
 * `index.ts` only loads the configuration, builds and listens.
 */
export async function buildApp(config: ServerConfig, migrationsDir = 'packages/db/migrations'): Promise<FastifyInstance> {
  const { connectionString, identity: identityConfig, push: pushConfig, filesDir, env } = config;
  const { exposeWork } = fixtureFlags(config.fixture);
  const app = Fastify({ logger: true, trustProxy: identityConfig.trustedProxies.length ? identityConfig.trustedProxies : false });
  // Domain errors and missing sessions are mapped once, here; route plugins inherit it (#85).
  useDomainErrors(app);
  useJsonCompression(app);
  // Every response refuses framing, the OAuth consent page included (#287).
  useFramingProtection(app);
  const { pool, db } = registerDatabase(app, connectionString);
  const migrationManifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
  assertExactMigrationLedger(migrationManifest, await readAppliedMigrationVersions(pool));
  const boss = new PgBoss({ connectionString, migrate: false });
  boss.on('error', (error) => app.log.error(error));
  await boss.start();
  app.addHook('onClose', async () => boss.stop());
  const identity = registerIdentity(app, { db, config: identityConfig });
  const liveMedia = createLiveMediaFromEnv(env, identityConfig.publicOrigin);
  const lifecycle = liveMedia ? liveLifecycle(db, pool, liveMedia.media) : null;
  const liveRevocation = liveMedia ? liveRevocationCoordinator(db, pool, liveMedia.media, lifecycle!) : null;
  await app.register(accessRoutes, { db, sessions: identity, boss, liveRevocation });
  const fileStorage = await diskFileStorage(filesDir);
  await app.register(sketchRoutes, { db, sessions: identity, storage: fileStorage });
  await app.register(dmRoutes, { db, sessions: identity });
  await app.register(pushRoutes, { db, sessions: identity, config: pushConfig });
  if (pushConfig.status === 'unavailable') app.log.warn(pushConfig.reason);
  // Upgrades reach @fastify/websocket through this emitter, except `/media/*`, which the live
  // signaling gate takes before any Fastify WebSocket handling (see the dispatch below).
  const streamUpgrades = new EventEmitter();
  await app.register(websocket, { options: { maxPayload: 1024, server: streamUpgrades as unknown as Server } });
  await app.register(streamRoutes, { db, sessions: identity, publicOrigin: identityConfig.publicOrigin, connectionString, heartbeatMs: config.heartbeatMs, cursorSecret: identityConfig.secret, exposeWork });
  await app.register(typingRoutes, { db, sessions: identity, publicOrigin: identityConfig.publicOrigin, connectionString, tasks: typingTaskDiscussion(db) });
  await app.register(fileRoutes, { db, sessions: identity, storage: fileStorage });
  await app.register(conversationRoutes, { db, sessions: identity, storage: fileStorage });
  await app.register(workRoutes, { db, sessions: identity, storage: fileStorage });
  await app.register(workReadRoutes, { db, sessions: identity });
  await app.register(githubRoutes, { db, sessions: identity, config: loadGithubConfig(env, identityConfig.publicOrigin) });
  // Configuration alone does not prove the SFU, DNS/TLS or receiver path is healthy.
  app.get('/api/v1/live-sessions/capabilities', async () => ({ status: liveMedia ? 'configured' : 'unavailable' }));
  const livePorts = liveMedia ? { access: liveAccess(db), sessions: liveSessionStore(db), media: liveMedia.media, mediaUrl: liveMedia.mediaUrl } : null;
  if (liveMedia) await app.register(liveRoutes, {
    sessions: identity,
    ports: livePorts!,
    lifecycle: lifecycle!,
    revocation: liveRevocation!,
    // Per API instance: N replicas allow N times the limit (docs/development/live-sessions.md).
    joinLimiter: joinRateLimiter(),
  });
  // Browsers signal only through this gate; ending an auth session revokes its media admission (#128).
  const liveSignaling = liveMedia ? registerLiveSignaling(app, { db, connectionString, publicOrigin: identityConfig.publicOrigin,
    sessions: identity, ports: livePorts!, media: liveMedia.media, config: liveMedia.config }) : null;
  app.server.on('upgrade', (request, socket, head) => {
    if (liveSignaling?.gate.handleUpgrade(request, socket, head)) return;
    streamUpgrades.emit('upgrade', request, socket, head);
  });
  if (liveMedia) await app.register(liveDiscoveryRoutes, { db, sessions: identity, media: liveMedia.media });
  if (liveMedia) await app.register(liveInvitationRoutes, { db, sessions: identity, cursorSecret: identityConfig.secret });
  if (lifecycle) {
    const mediaConfig = liveMedia!.config;
    await app.register(liveWebhookRoutes, { pool, apiKey: mediaConfig.apiKey, apiSecret: mediaConfig.apiSecret,
      requestReconcile: (sessionId, generation) => lifecycle.reconcile(sessionId, generation).then(() => undefined),
      reconcileAdmissions: (roomId) => liveSignaling!.revocation.reconcileRoom(roomId) });
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
  await app.register(agentProposalRoutes, { db, sessions: identity, oauthSecret: identityConfig.secret, publicOrigin: identityConfig.publicOrigin });
  await app.register(projectAgentRoutes, { db, sessions: identity });
  await app.register(agentPolicyRoutes, { db, sessions: identity });
  await app.register(agentMcpPolicyRoutes, { db, sessions: identity });
  await app.register(proactiveComparisonRoutes, { db, sessions: identity, backgroundMasterKey: config.backgroundMasterKey,
    comparisonsEnabled: config.backgroundComparisons });
  registerMcpRoute(app, db, identity.auth, identityConfig.publicOrigin, config.fixture.failureInjection && !!config.fixture.token);
  await app.register(returnRoutes, { db, sessions: identity });
  await app.register(docRoutes, { db, sessions: identity });
  await app.register(notificationRoutes, { db, sessions: identity, smtp: identityConfig.smtp, publicOrigin: identityConfig.publicOrigin });
  // Personal assistant runs (#68): the server queues; the worker dispatches.
  const personalRuns = personalRunServerComposition(env, db);
  if (personalRuns.mode !== 'production') app.log.warn({ mode: personalRuns.mode }, 'TEST ONLY: personal runs use fixture connections and a mock provider');
  await app.register(personalRunRoutes, { db, sessions: identity, boss, connections: personalRuns.connections, providerEnabled: personalRuns.providerEnabled });
  await app.register(searchRoutes, { db, sessions: identity, cursorSecret: identityConfig.secret, exposeWork });
  await app.register(exportRoutes, { db, sessions: identity, publicOrigin: identityConfig.publicOrigin, storage: fileStorage });
  // The `runtime` transport (F-022 AIM-3): off unless the operator set FLUX_AGENT_RUNTIME.
  await app.register(agentRuntimeRoutes, { db, sessions: identity, config: config.agentRuntime });

  registerHealth(app, { pool, boss, manifest: migrationManifest, filesDir });
  registerFixtureRoutes(app, { config: config.fixture, db, boss, publicOrigin: identityConfig.publicOrigin });

  // The build writes .br/.gz copies of the app's text files (#266 item 9); a client that accepts
  // them gets the smaller copy, everyone else the original.
  await fastifyStatic(app, { root: join(process.cwd(), 'apps/web/dist'), prefix: '/', cacheControl: false, setHeaders: setStaticHeaders, preCompressed: true });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not Found' });
    if (!request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: 'Not Found' });
    return reply.sendFile('index.html');
  });
  return app;
}
