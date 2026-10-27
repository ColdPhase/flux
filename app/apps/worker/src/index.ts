import { PgBoss } from 'pg-boss';
import { assertExactMigrationLedger, createDatabase, FLUX_SCHEMA_VERSION, loadBackgroundMasterKey, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { PERSONAL_RUN_LIMITS } from '@flux/contracts';
import { backgroundComparisonsEnabled, loadAgentRuntimeConfig } from '@flux/core';
import { startAgentRuntimeReconciler } from './agent-runtime/index.js';
import { registerDraftSummaryWorker } from './jobs/draft-summary.js';
import { registerIdempotencyCleanup } from './jobs/idempotency-cleanup.js';
import { registerMorningSummary } from './jobs/morning-summary.js';
import { assistantSummaryStart, registerAssistantTick } from './assistant/index.js';
import { registerSampleWorker } from './jobs/sample.js';
import { createVapidAuthorizer, registerPushWorker } from './push/index.js';
import { registerNotificationEmailWorker, startNotificationGenerator } from './notifications/index.js';
import { personalRunWorkerComposition, registerPersonalRunWorker } from './personal-runs/index.js';
import { workerRuntimeAvailability } from './personal-runs/runtime-standing.js';
import { registerComparisonWorker } from './proactive-comparison/index.js';
import { registerWorkspaceAiSweep } from './workspace-ai/index.js';
import { startWorkspaceEncryption } from './workspace-encryption/index.js';
import { comparisonProviders } from './proactive-comparison/providers.js';

// The worker's composition root (#82): environment, pool, pg-boss and signals; each job's
// handler lives in its registrar.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
assertExactMigrationLedger(await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION), await readAppliedMigrationVersions(pool));
pool.on('error', (error) => console.error('Database connection interrupted', error));
const boss = new PgBoss({ connectionString, migrate: false });
boss.on('error', (error) => console.error(error));
await boss.start();
await registerSampleWorker(boss, db, process.env.HOSTNAME ?? 'worker');
await registerPushWorker(boss, db, createVapidAuthorizer());
// Notifications from committed events and their email (#116).
const email = await registerNotificationEmailWorker(boss, db);
const generator = startNotificationGenerator({ db, boss, connectionString, emailAvailable: email.available });
await registerDraftSummaryWorker(boss, db);
// Personal assistant runs (#68): the payload is a run id; every step rechecks the owner.
const agentRuntimeConfig = loadAgentRuntimeConfig(process.env);
const personalRuns = personalRunWorkerComposition(process.env, db, agentRuntimeConfig);
if (personalRuns.mode !== 'production') console.warn(JSON.stringify({ warning: 'TEST ONLY: personal runs use fixture connections and a mock provider', mode: personalRuns.mode }));
const personalRunRecovery = await registerPersonalRunWorker(boss, db, personalRuns);
// The owner's schedules and the assistant-written morning summary (F-027 A8): the same personal-run path, one tick a minute.
const assistantRuns = { connections: personalRuns.connections, providerEnabled: personalRuns.compute.enabled, toolTurns: personalRuns.compute.enabled ? PERSONAL_RUN_LIMITS.maxTurns : 1,
  runtime: workerRuntimeAvailability(agentRuntimeConfig, db) };
// The morning summary (#350, S22): one push a day per person who turned it on; the assistant may write its text.
await registerMorningSummary(boss, db, assistantSummaryStart(db, boss, assistantRuns));
await registerAssistantTick(boss, db, assistantRuns);
// Background comparisons (#58): only when the operator switched them on; otherwise unscheduled.
const comparisonsOn = backgroundComparisonsEnabled(process.env);
await registerComparisonWorker(boss, db, { enabled: comparisonsOn, masterKey: comparisonsOn ? loadBackgroundMasterKey() : null, provider: comparisonProviders(process.env) });
await registerIdempotencyCleanup(boss, db);
await registerWorkspaceAiSweep(boss, db);
// Encrypted workspaces (F-030): the keyring heartbeat and the resume job sent with every unlock.
const encryption = await startWorkspaceEncryption(boss, db, process.env);
// The `runtime` transport (F-022 T3): reconciles slot bindings at start and periodically; off by default.
const agentRuntime = startAgentRuntimeReconciler({ config: agentRuntimeConfig, db, pool, env: process.env });
console.log('Flux worker ready');
const stop = async () => { encryption.stop(); await agentRuntime.stop(); await personalRunRecovery.stop(); await generator.stop(); await boss.stop(); email.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
