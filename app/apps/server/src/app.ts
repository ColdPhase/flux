import { assistantRoutes } from './assistant/routes.js';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PgBoss } from 'pg-boss';
import { accessPorts, assertExactMigrationLedger, fileCipherOf, FLUX_SCHEMA_VERSION, isPersonPhotoObject, isSpaceIconObject, isRunPictureObject, readAppliedMigrationVersions, readMigrationManifest, sealResolverScope, sql as dbSql, type DbExecutor } from '@flux/db';
import { EDITING_CAPABILITIES_PATH, type EditingCapability } from '@flux/contracts';
import { registerDatabase } from './plugins/database.js';
import { aiRoutes } from './access/ai-gate.js';
import { agentTaskRoutes } from './agent-tasks/routes.js';
import { startIdentity } from './identity/index.js';
import { accessRoutes } from './access/routes.js';
import { sketchRoutes } from './sketches/routes.js';
import { dmRoutes } from './direct-messages/routes.js';
import { pushRoutes } from './push/index.js';
import { staticHeaders } from './pwa/static-headers.js';
import { loadDocumentPolicies } from './http/content-security-policy.js';
import { CSP_REPORT_PATH, cspReportRoutes } from './http/csp-reports.js';
import { streamRoutes } from './stream/index.js';
import { conversationRoutes } from './conversation/routes.js';
import { linkPreviewRoutes } from './link-previews/routes.js';
import { messagePlaceRoutes } from './conversation/message-place.js';
import { diskFileStorage } from './files/storage.js';
import { fileRoutes } from './files/routes.js';
import { pictureRoutes } from './pictures/routes.js';
import { sharpPictureRenderer } from './pictures/render.js';
import { workRoutes } from './work/routes.js';
import { workReadRoutes } from './work-read/routes.js';
import { viewRoutes } from './views/routes.js';
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
import { agentStopRoutes } from './agent-connection/agent-stops.js';
import { agentQuestionRoutes } from './agent-connection/agent-questions.js';
import { modelListRefresh } from './ai-keys/model-refresh.js';
import { aiKeyRoutes } from './ai-keys/routes.js';
import { registerMcpRoute } from './agent-connection/mcp-route.js';
import { configureRunCredentialScan } from './agent-connection/run-credentials.js';
import { webReader as createWebReader } from './web-reads/reader.js';
import { configureAgentPictures } from './agent-connection/picture-actions.js';
import { configureAgentFiles } from './agent-connection/file-actions.js';
import { CLOSED_WORLD_RULES } from './link-previews/safe-fetch.js';
import { returnRoutes } from './returns/routes.js';
import { firstStepRoutes } from './first-steps/routes.js';
import { needsYouRoutes } from './needs-you/routes.js';
import { sidebarRoutes } from './sidebar/routes.js';
import { docRoutes } from './docs/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { searchRoutes } from './search/routes.js';
import { searchQueryVectors } from './search/vectors.js';
import { personalRunRoutes } from './personal-runs/routes.js';
import { personalRunServerComposition } from './personal-runs/composition.js';
import { keyToolChecking } from './ai-keys/tool-checking.js';
import { firstAgentMaker } from './personal-runs/make-agent.js';
import { pgBossPersonalRunQueue } from './personal-runs/adapters.js';
import { registerPersonalRunTokenRoute } from './personal-runs/run-tokens.js';
import { personalRuntimeAvailability } from './personal-runs/runtime.js';
import { exportRoutes } from './export/routes.js';
import { agentRuntimeRoutes } from './agent-runtime/routes.js';
import { keyWebSearcher, type KeyWebSearcher } from './agent-connection/web-search.js';
import { typingRoutes } from './typing/routes.js';
import { typingTaskDiscussion } from './typing/tasks.js';
import { githubCredentials } from './github/credentials.js';
import { githubProvider } from './github/provider.js';
import { githubTransport } from './github/http.js';
import { type Provider as GithubUnitProvider } from './github/adapters.js';
import { githubRoutes } from './github/routes.js';
import { loadGithubConfig } from './github/config.js';
import type { ServerConfig } from './config.js';
import { fixtureFlags, registerFixtureConnectionRoute, registerFixtureRoutes } from './fixture/index.js';
import { registerHealth } from './health/routes.js';
import { composeEncryption, encryptionUnitOfWork, installSeals, processKeysFromEnv } from './encryption/adapters.js';
import { encryptionRoutes } from './encryption/routes.js';
import { registerLockGate } from './encryption/lock-gate.js';
import { createRequestIdGenerator, requestLogSerializer, SECRET_LOG_PATHS } from './http/log-serializers.js';
import { createProject, dropStaleUnlocks, listProjects } from '@flux/core';
import { useDomainErrors } from './http/errors.js';
import { registerUpgradeDispatcher } from './http/upgrades.js';
import { registerEditing } from './editing/composition.js';
import { disabledEditingUpgrade } from './editing/disabled-upgrade.js';
import { useJsonCompression } from './http/compress.js';
import { useFramingProtection } from './http/framing.js';
import { useApiRateLimit } from './http/rate-limit.js';
import { isRouted, originFormTarget } from './http/routed-path.js';
import { sessionCookieName } from './identity/session-cookie.js';
import { useSecurityHeaders } from './http/security-headers.js';

/**
 * S3 SWITCH (F-030, #655): encrypted-space creation is a production route, for the company's owners and admins (F-037).
 * Flipped in the change that merges S3, after S2a-2b-2, S2a-2c, S2b and S2c passed their acceptance criteria and the full AC-7 and
 * AC-13 passed on S2c's final head (docs/product/encrypted-workspaces.md, delivery slices).
 */
const ENCRYPTED_CREATION_IN_PRODUCTION = true;

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Process shutdown (#228): closes development live editing, then the app, and reports whether
     * editing resources drained (always true when it is off). A false result is a failed shutdown.
     */
    closeGracefully(): Promise<boolean>;
  }
}

/**
 * The API's composition root (#88): builds every route and background loop from one loaded
 * configuration, without listening, so tests can build it with their own configuration.
 * `index.ts` only loads the configuration, builds and listens.
 */
export async function buildApp(config: ServerConfig, migrationsDir = 'packages/db/migrations',
  /** Test seam: a fixture in place of the GitHub App provider, for the agent PR link and the reads of personal runs; pi's web search with a mock provider (#1441). */
  overrides: { githubProvider?: GithubUnitProvider; keySearcher?: KeyWebSearcher } = {}): Promise<FastifyInstance> {
  const { connectionString, identity: identityConfig, push: pushConfig, filesDir, env } = config;
  const { exposeWork } = fixtureFlags(config.fixture);
  // F-030: the request serializer drops query strings (a search text is content); bodies are never logged.
  // `rewriteUrl`: a request in absolute-form (`GET http://host/api/v1/x`, which a server must accept) is routed, counted and answered as the
  // origin-form request it is, so no handler (the file handler among them) reads a scheme and a host as part of the path (#1047).
  const app = Fastify({ logger: { serializers: { req: requestLogSerializer }, redact: SECRET_LOG_PATHS }, genReqId: createRequestIdGenerator(), rewriteUrl: (request) => originFormTarget(request.url ?? '/'), trustProxy: identityConfig.trustedProxies.length ? identityConfig.trustedProxies : false });
  // Domain errors and missing sessions are mapped once, here; route plugins inherit it (#85).
  useDomainErrors(app);
  // F-030 (#655): this process's keys of encrypted workspaces, refreshed by the keyring heartbeat; and the lock gate,
  // registered before any route so every later route gets it.
  const testDeployment = config.fixture.token !== null && config.fixture.failureInjection;
  // AC-6, test deployment only: every registered route, so the locked-route walk can classify each one.
  if (testDeployment) {
    const routes: { method: string; url: string; body: unknown; query: unknown }[] = [];
    app.addHook('onRoute', (route) => { for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push({ method, url: route.url, body: (route.schema as { body?: unknown } | undefined)?.body ?? null, query: (route.schema as { querystring?: unknown } | undefined)?.querystring ?? null }); });
    app.get('/api/v1/test/routes', async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${config.fixture.token}`) return reply.code(401).send({ error: 'Unauthorized' });
      return { routes };
    });
  }
  // AC-7 error paths, test deployment only: `x-flux-test-fail: 500` fails the request after its handler ran, with an
  // error whose message and detail quote the request body, so the test proves such text is never answered or logged (#991: in any space).
  if (testDeployment) app.addHook('preSerialization', async (request, _reply, payload) => {
    if (request.headers['x-flux-test-fail'] !== '500' || (request as { injected?: boolean }).injected) return payload;
    (request as { injected?: boolean }).injected = true;
    const quoted = JSON.stringify(request.body ?? null);
    // The positive control of the log scan (scripts/check_encryption.sh): a request that asks for it has its text logged on purpose.
    if (request.headers['x-flux-test-log'] === '1') request.log.info({ quoted }, 'Test control: the request text is logged on purpose');
    throw Object.assign(new Error(`Injected failure after ${quoted}`), { detail: quoted });
  });
  const encryptionKeys = processKeysFromEnv(env);
  const seals = installSeals(encryptionKeys);
  app.addHook('onRequest', (_request, _reply, done) => { sealResolverScope.run(seals, done); });
  useJsonCompression(app);
  // Every response refuses framing, the OAuth consent page included (#287).
  useFramingProtection(app);
  // The floor under every route's own limits (#838); off with FLUX_AUTH_RATE_LIMIT=false, as the sign-in limit is.
  useApiRateLimit(app, { enabled: identityConfig.rateLimit, sessionCookie: sessionCookieName(identityConfig.publicOrigin.startsWith('https:')) });
  // nosniff, Referrer-Policy, no-store on /api/ and, for an https origin, Strict-Transport-Security (#992).
  useSecurityHeaders(app, { hsts: identityConfig.publicOrigin.startsWith('https:') });
  const { pool, db } = registerDatabase(app, connectionString);
  let gateSessions: Awaited<ReturnType<typeof startIdentity>> | null = null;
  registerLockGate(app, { db, keys: encryptionKeys,
    sessions: { resolveSession: (headers) => gateSessions!.resolveSession(headers), requirePrincipal: (request) => gateSessions!.requirePrincipal(request) } });
  const migrationManifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
  assertExactMigrationLedger(migrationManifest, await readAppliedMigrationVersions(pool));
  // The API only enqueues. The worker owns scheduling and maintenance, so this instance runs neither of their timers (#862).
  // The instance registry is beaten every five minutes, not every half minute: nothing but getInstances reads it (#850).
  const boss = new PgBoss({ connectionString, migrate: false, schedule: false, supervise: false, instanceHeartbeatSeconds: 300 });
  boss.on('error', (error) => app.log.error(error));
  await boss.start();
  app.addHook('onClose', async () => boss.stop());
  const identity = await startIdentity(app, { db, config: identityConfig, originExemptPaths: testDeployment ? [CSP_REPORT_PATH] : [] });
  gateSessions = identity;
  const encryption = composeEncryption(db, boss, encryptionKeys, { isolatedCompanies: testDeployment });
  // The keyring heartbeat (5 s): swap again, then the boot id; a new boot deletes the stale unlock rows and records the locks.
  const heartbeat = encryptionKeys.startHeartbeat(async (change) => {
    if (change.current) await dropStaleUnlocks(encryptionUnitOfWork(db, boss), change.current, change.observedAt);
  }, 5_000, (error) => app.log.warn({ code: (error as { code?: unknown }).code ?? null }, 'Keyring heartbeat failed'));
  app.addHook('onClose', async () => heartbeat.stop());
  await heartbeat.first;
  // Operators learn it from the log, not from the unauthenticated health endpoint (F-030 S1 review).
  if (encryptionKeys.availability === 'swap_unsafe') app.log.warn('Encrypted workspaces stay locked here: this server can write memory to disk (swap is on and not limited). Turn swap off or set FLUX_SWAP_ACKNOWLEDGED=encrypted-swap if every swap device is encrypted.');
  await app.register(async (scope) => encryptionRoutes(scope, { sessions: identity, encryption,
    // S1/S2: creation exists only in a test deployment and with the fixture bearer (never on a ./flux up install).
    fixtureCreation: testDeployment ? config.fixture.token : null,
    productionCreation: ENCRYPTED_CREATION_IN_PRODUCTION,
    firstSpace: async (principal, workspaceId, name) => {
      const existing = await listProjects(principal, workspaceId, { limit: 1 }, db, accessPorts);
      return existing.items[0] ?? createProject(principal, workspaceId, { name, visibility: 'workspace' }, db, accessPorts);
    } }));
  const liveMedia = createLiveMediaFromEnv(env, identityConfig.publicOrigin);
  const lifecycle = liveMedia ? liveLifecycle(db, pool, liveMedia.media) : null;
  const liveRevocation = liveMedia ? liveRevocationCoordinator(db, pool, liveMedia.media, lifecycle!) : null;
  await app.register(accessRoutes, { db, sessions: identity, boss, liveRevocation, verifiedEmailMembers: identityConfig.oidc !== null, encryptionKeys,
    inviteSigner: { secret: identityConfig.secret, publicOrigin: identityConfig.publicOrigin }, inviteVerifiedEmail: identityConfig.signup === 'verified',
    ssoOnly: identityConfig.ssoOnly, testDeployment });
  // Live map/wiki editing (#228) is composed below, after media; native map routes reach its backend lazily.
  let editing: Awaited<ReturnType<typeof registerEditing>> = null;
  // F-030: an encrypted workspace's file objects are sealed as they arrive and opened only after their tag verifies.
  const fileStorage = await diskFileStorage(filesDir, { cipherFor: async (objectId) => {
    const executor = db as unknown as DbExecutor;
    const [row] = (await executor.execute<{ workspace_id: string }>(dbSql`SELECT workspace_id FROM project_files WHERE id = ${objectId}::uuid`)).rows;
    // A profile photo's rendition is account data, and a space with an icon is never an encrypted one: neither is sealed (F-039, F-040). An object without its row is refused, never written or served
    // as plaintext (#707 review).
    if (!row) {
      if (await isPersonPhotoObject(executor, objectId) || await isSpaceIconObject(executor, objectId) || await isRunPictureObject(executor, objectId)) return null;
      throw new Error('A stored file needs its row before its bytes');
    }
    return fileCipherOf(executor, row.workspace_id, objectId, { write: false });
  } });
  const editingConfirmation = identityConfig.oidc ? { providerId: identityConfig.oidc.providerId, confirmationMaxAgeMs: identityConfig.oidc.confirmationMaxAgeMs } : null;
  await app.register(sketchRoutes, { db, sessions: identity, confirmation: editingConfirmation, storage: fileStorage, developmentEditing: config.liveEditing, liveBackend: () => editing?.mapsBackend ?? null });
  await app.register(dmRoutes, { db, sessions: identity, storage: fileStorage });
  await app.register(pushRoutes, { db, sessions: identity, config: pushConfig });
  if (pushConfig.status === 'unavailable') app.log.warn(pushConfig.reason);
  // Upgrades reach @fastify/websocket through this emitter, except `/media/*` and the editing gate,
  // which take theirs before any Fastify WebSocket handling (see the dispatch below).
  const streamUpgrades = new EventEmitter();
  await app.register(websocket, { options: { maxPayload: 1024, server: streamUpgrades as unknown as Server } });
  await app.register(streamRoutes, { db, sessions: identity, publicOrigin: identityConfig.publicOrigin, connectionString, heartbeatMs: config.heartbeatMs, cursorSecret: identityConfig.secret, exposeWork });
  await app.register(typingRoutes, { db, sessions: identity, publicOrigin: identityConfig.publicOrigin, connectionString, tasks: typingTaskDiscussion(db) });
  // One libvips, one picture at a time: profile photos, space icons, every stored picture (a person's upload, an agent's) and a video's
  // poster (C-61) wait in the same line.
  const pictures = sharpPictureRenderer();
  await app.register(fileRoutes, { db, sessions: identity, storage: fileStorage, pictures, videoBytes: config.files.videoBytes, poster: (bytes) => pictures.poster(bytes) });
  await app.register(pictureRoutes, { db, sessions: identity, storage: fileStorage, renderer: pictures });
  await app.register(conversationRoutes, { db, sessions: identity, storage: fileStorage });
  await app.register(linkPreviewRoutes, { db, sessions: identity, config: config.linkPreviews });
  await app.register(messagePlaceRoutes, { db, sessions: identity });
  await app.register(workRoutes, { db, sessions: identity, storage: fileStorage });
  await app.register(workReadRoutes, { db, sessions: identity });
  // One read per screen (#1109): a space's frame and its Conversation.
  await app.register(viewRoutes, { db, sessions: identity, storage: fileStorage });
  const githubConfig = loadGithubConfig(env, identityConfig.publicOrigin);
  await app.register(githubRoutes, { db, sessions: identity, config: githubConfig });
  // The read-only App provider for the agents' PR link (#160 AC-3) and the reads of personal runs; it adds no GitHub permission.
  const githubReadTransport = githubTransport();
  const githubReadProvider: GithubUnitProvider | null = overrides.githubProvider
    ?? (githubConfig ? githubProvider(githubCredentials(db, githubConfig, githubReadTransport), githubConfig, githubReadTransport) : null);
  // Configuration alone does not prove the SFU, DNS/TLS or receiver path is healthy.
  app.get('/api/v1/live-sessions/capabilities', async () => ({ status: liveMedia ? 'configured' : 'unavailable' }));
  // Outside the editing routes, whose disabled hook refuses every request (#239 review).
  app.get(EDITING_CAPABILITIES_PATH, async (): Promise<{ status: EditingCapability }> => ({ status: editing ? 'configured' : 'unavailable' }));
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
  editing = await registerEditing(app, { database: { db, pool }, sessions: identity, publicOrigin: identityConfig.publicOrigin,
    connectionString, enabled: config.liveEditing, developmentEnabled: config.developmentLiveEditing, env, confirmation: editingConfirmation, encryptionKeys });
  if (editing && config.developmentLiveEditing) app.log.info('Isolated live editing calibration selected');
  // One listener owns every upgrade: media, then editing, then the Fastify stream emitter (1 KiB bound).
  const removeUpgradeDispatcher = registerUpgradeDispatcher(app.server, streamUpgrades,
    [liveSignaling?.gate, editing?.gate ?? disabledEditingUpgrade()]);
  app.addHook('onClose', async () => removeUpgradeDispatcher());
  app.decorate('closeGracefully', async () => {
    await editing?.close();
    await app.close();
    // Only after Fastify and its HTTP/database hooks settle, never while a SQL fence is held.
    return editing ? editing.finishTelemetry() : true;
  });
  if (liveMedia) await app.register(liveDiscoveryRoutes, { db, sessions: identity, media: liveMedia.media });
  if (liveMedia) await app.register(liveInvitationRoutes, { db, sessions: identity, cursorSecret: identityConfig.secret });
  if (lifecycle) {
    const mediaConfig = liveMedia!.config;
    await app.register(liveWebhookRoutes, { pool, apiKey: mediaConfig.apiKey, apiSecret: mediaConfig.apiSecret,
      requestReconcile: (sessionId, generation, presence) => lifecycle.reconcile(sessionId, generation, { announce: presence }).then(() => undefined),
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
  await app.register(aiRoutes(agentProposalRoutes), { db, sessions: identity });
  await app.register(aiRoutes(agentStopRoutes), { db, sessions: identity });
  await app.register(aiRoutes(agentQuestionRoutes), { db, sessions: identity });
  // Connecting AI the first time (a key saved, a plan signed in) gives a person Assistant (F-036 AG-1).
  const personalRuns = personalRunServerComposition(env, db, config.agentRuntime);
  if (personalRuns.mode !== 'production') app.log.warn({ mode: personalRuns.mode }, 'TEST ONLY: personal runs use fixture connections and a mock provider');
  // RT-1 rule 2 (#1441): an agent is put on a model of a key that called the check's `ping` (a fixture key of the test deployment has none to open).
  const toolChecking = personalRuns.mode === 'production' ? keyToolChecking(env, db, config.backgroundMasterKey) : null;
  const firstAgent = firstAgentMaker(db, { queue: pgBossPersonalRunQueue(boss), connections: personalRuns.connections, providerEnabled: personalRuns.providerEnabled,
    runtime: personalRuntimeAvailability(config.agentRuntime, db), ...(toolChecking ? { toolChecking } : {}) }, app.log);
  await app.register(aiRoutes(aiKeyRoutes), { db, sessions: identity, backgroundMasterKey: config.backgroundMasterKey, afterConnect: firstAgent,
    refresh: modelListRefresh(db, boss) });
  // The agents' web page reads (#918): the link cards' guard, a test deployment's closed world, and only when the operator turned them on.
  const webReader = createWebReader({ enabled: config.webReads.enabled, pictures, ...(config.linkPreviews.testHosts.size ? { rules: CLOSED_WORLD_RULES,
    connectTo: (host: string) => config.linkPreviews.testHosts.get(host) ?? null } : {}) });
  // An agent's picture (#1217): the same reader, and the files volume a person's upload goes to.
  configureAgentPictures({ reader: webReader, storage: fileStorage });
  // #1437: an agent's file goes through the asker's own upload path (pictures written again, videos' own limit), read from its run's scratch.
  configureAgentFiles({ storage: fileStorage, options: { videoBytes: config.files.videoBytes, pictures, poster: (bytes) => pictures.poster(bytes) },
    manager: config.agentRuntime.manager });
  // #1437: a run's change is looked through for its CLI's own login by the run's supervisor (through runtime-manager).
  configureRunCredentialScan(config.agentRuntime.manager);
  // The optional embedding container's query hook (F-042, #1294), one for the process: undefined while it is off.
  const queryVectors = searchQueryVectors(config.embeddings);
  // pi's web search (#1441, RT-5): the key's provider's hosted search, run here with the run owner's key.
  const keySearcher = overrides.keySearcher ?? keyWebSearcher(env, db, config.backgroundMasterKey, personalRuns.providerEnabled);
  registerMcpRoute(app, db, identity.auth, identityConfig.publicOrigin, config.fixture.failureInjection && !!config.fixture.token,
    identity.standing && identityConfig.oidc ? { checker: identity.standing, label: identityConfig.oidc.label } : null,
    identity.confirmation, identityConfig.oidc?.label, githubReadProvider, webReader, queryVectors, keySearcher);
  // A personal run's MCP token (F-027 A2): signed here, the authorization server, for the worker only. A run in pi is given
  // flux_web_search only where the route registers it: the web on and a searcher here (#1452 review).
  registerPersonalRunTokenRoute(app, db, identity.auth, identityConfig.publicOrigin, webReader.enabled && !!keySearcher?.compute.enabled);
  await app.register(returnRoutes, { db, sessions: identity });
  await app.register(firstStepRoutes, { db, sessions: identity });
  await app.register(needsYouRoutes, { db, sessions: identity, github: githubReadProvider });
  await app.register(sidebarRoutes, { db, sessions: identity });
  await app.register(docRoutes, { db, sessions: identity });
  await app.register(notificationRoutes, { db, sessions: identity, smtp: identityConfig.smtp, publicOrigin: identityConfig.publicOrigin });
  // Personal assistant runs (#68): the server queues; the worker dispatches.
  await app.register(aiRoutes(assistantRoutes), { db, sessions: identity, boss, github: githubReadProvider });
  await app.register(aiRoutes(personalRunRoutes), { db, sessions: identity, boss, connections: personalRuns.connections, providerEnabled: personalRuns.providerEnabled,
    runtime: personalRuntimeAvailability(config.agentRuntime, db), storage: fileStorage, toolChecking });
  // People's agents take tasks (#856): the setting, the state line and the drain of what the work and the worker wrote.
  await app.register(aiRoutes(agentTaskRoutes), { db, sessions: identity, boss, connectionString,
    composition: { connections: personalRuns.connections, providerEnabled: personalRuns.providerEnabled, runtime: personalRuntimeAvailability(config.agentRuntime, db) } });
  await app.register(searchRoutes, { db, sessions: identity, cursorSecret: identityConfig.secret, exposeWork, vectors: queryVectors });
  await app.register(exportRoutes, { db, sessions: identity, publicOrigin: identityConfig.publicOrigin, storage: fileStorage });
  // The `runtime` transport (F-022 AIM-3): off unless the operator set FLUX_AGENT_RUNTIME.
  await app.register(aiRoutes(agentRuntimeRoutes), { db, sessions: identity, config: config.agentRuntime, secret: identityConfig.secret, publicOrigin: identityConfig.publicOrigin,
    afterSignIn: firstAgent });

  registerHealth(app, { pool, boss, manifest: migrationManifest, filesDir });
  registerFixtureRoutes(app, { config: config.fixture, db, boss, publicOrigin: identityConfig.publicOrigin });
  const collectCspReports = testDeployment && config.fixture.token !== null;
  if (collectCspReports) await app.register(cspReportRoutes, { token: config.fixture.token! });
  registerFixtureConnectionRoute(app, { config: config.fixture, db, sessions: identity, publicOrigin: identityConfig.publicOrigin });

  // The build writes .br/.gz copies of the app's text files (#266 item 9); a client that accepts
  // them gets the smaller copy, everyone else the original.
  const webRoot = join(process.cwd(), 'apps/web/dist');
  // A real Content-Security-Policy on the pages and the service worker (#979); a test deployment's pages also report what they refuse.
  const documentPolicies = loadDocumentPolicies(webRoot, identityConfig.publicOrigin, collectCspReports ? { reportUri: CSP_REPORT_PATH, allowEval: config.fixture.cspEval } : undefined);
  await fastifyStatic(app, { root: webRoot, prefix: '/', cacheControl: false, setHeaders: staticHeaders(documentPolicies, webRoot), preCompressed: true });
  app.setNotFoundHandler(async (request, reply) => {
    if (isRouted(request, '/api/')) return reply.code(404).send({ error: 'Not Found' });
    if (!request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: 'Not Found' });
    return reply.sendFile('index.html');
  });
  return app;
}
