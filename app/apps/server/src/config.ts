import { backgroundComparisonsEnabled, loadPushServerConfig, type PushServerConfig } from '@flux/core';
import { loadBackgroundMasterKey } from '@flux/db';
import { loadIdentityConfig, type IdentityConfig } from './identity/index.js';

/** Test-deployment switches (#88); both are off in a production install. */
export interface FixtureConfig {
  /** `FLUX_FIXTURE_TOKEN`: enables the integration-fixture routes. */
  token: string | null;
  /** `FLUX_TEST_FAILURE_INJECTION=true`: lets the fixture force failures and expose test counters. */
  failureInjection: boolean;
}

/** Everything the API reads from its environment, read once at startup (#88). */
export interface ServerConfig {
  /** For compositions that read their own variables (live media, personal runs). */
  env: NodeJS.ProcessEnv;
  connectionString: string;
  identity: IdentityConfig;
  push: PushServerConfig;
  fixture: FixtureConfig;
  filesDir: string;
  /** Stream ping, session revalidation and polling interval. */
  heartbeatMs: number;
  port: number;
  backgroundMasterKey: Buffer | null;
  /** `FLUX_BACKGROUND_COMPARISONS=on` (#58): owners may enable comparison rules; the worker runs them. */
  backgroundComparisons: boolean;
  /**
   * `FLUX_DEVELOPMENT_LIVE_EDITING=true` (#228): selects the isolated development live map/wiki
   * editing path. Off by default; selecting it certifies none of the four F-021 gates.
   */
  developmentLiveEditing: boolean;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, backgroundKeyPath?: string): ServerConfig {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const heartbeatMs = Number(env.FLUX_STREAM_HEARTBEAT_MS ?? 25_000);
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 100) throw new Error('FLUX_STREAM_HEARTBEAT_MS must be an integer of at least 100');
  return {
    env,
    connectionString,
    identity: loadIdentityConfig(env),
    push: loadPushServerConfig(env),
    fixture: { token: env.FLUX_FIXTURE_TOKEN || null, failureInjection: env.FLUX_TEST_FAILURE_INJECTION === 'true' },
    filesDir: env.FLUX_FILES_DIR ?? '/data/files',
    heartbeatMs,
    port: Number(env.PORT ?? 8080),
    backgroundMasterKey: backgroundKeyPath === undefined ? loadBackgroundMasterKey() : loadBackgroundMasterKey(backgroundKeyPath),
    backgroundComparisons: backgroundComparisonsEnabled(env),
    developmentLiveEditing: env.FLUX_DEVELOPMENT_LIVE_EDITING === 'true',
  };
}
