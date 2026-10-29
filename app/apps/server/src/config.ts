import { backgroundComparisonsEnabled, loadAgentRuntimeConfig, loadPushServerConfig, type AgentRuntimeConfig, type PushServerConfig } from '@flux/core';
import { loadBackgroundMasterKey } from '@flux/db';
import { loadIdentityConfig, type IdentityConfig } from './identity/index.js';
import { loadLinkPreviewsConfig, type LinkPreviewsConfig } from './link-previews/config.js';

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
  /** Normal map/wiki collaboration; missing/empty/on enables it, off is the operator opt-out. */
  liveEditing: boolean;
  /**
   * `FLUX_DEVELOPMENT_LIVE_EDITING=true` (#228): isolated calibration marker only.
   * It never overrides the production opt-out or certifies any acceptance gate.
   */
  developmentLiveEditing: boolean;
  /** `FLUX_AGENT_RUNTIME` and its settings (F-022 AIM-3); empty, the default, is off. */
  agentRuntime: AgentRuntimeConfig;
  /** `FLUX_LINK_PREVIEWS=on` (#469): the server may fetch the pages of links in messages for their cards. Off by default. */
  linkPreviews: LinkPreviewsConfig;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, backgroundKeyPath?: string): ServerConfig {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const heartbeatMs = Number(env.FLUX_STREAM_HEARTBEAT_MS ?? 25_000);
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 100) throw new Error('FLUX_STREAM_HEARTBEAT_MS must be an integer of at least 100');
  const liveEditing = env.FLUX_LIVE_EDITING || 'on';
  if (!['on', 'off'].includes(liveEditing)) throw new Error('FLUX_LIVE_EDITING must be on or off');
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
    liveEditing: liveEditing === 'on',
    developmentLiveEditing: env.FLUX_DEVELOPMENT_LIVE_EDITING === 'true',
    agentRuntime: loadAgentRuntimeConfig(env),
    linkPreviews: loadLinkPreviewsConfig(env),
  };
}
