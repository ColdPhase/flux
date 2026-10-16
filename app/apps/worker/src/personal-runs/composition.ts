import { aiEndpointPolicyFromEnv, parsePrivateTargets, providerPersonalCompute } from '@flux/agent-runtime';
import {
  TEST_FIXTURE_API_KEY, TEST_FIXTURE_KEY_REF, testFixturePersonalConnections, unavailablePersonalCompute,
  type AgentRuntimeConfig, type Database, type PersonalCompute, type PersonalConnectionLookup, type PersonalRunTokenIssuer, type PersonalRuntime, type PersonalToolHost,
} from '@flux/core';
import { loadBackgroundMasterKey, personalConnectionLookup, personalKeyResolver } from '@flux/db';
import { mcpToolHost } from './mcp-session.js';
import { apiInternalUrl, runTokenIssuer } from './run-tokens.js';
import { managerPersonalRuntime } from './runtime-engine.js';

// Which connection lookup and provider the worker composes for personal runs (#68, O-008; F-020).
//
// Production: the owner's own AI connections (#124 custody, F-020 PROV-1) and, only when the
// operator sets `FLUX_PERSONAL_RUNS=on`, the provider registry with a key resolver that opens one
// connection's sealed key for one dispatch. Off (the default) or without the instance key, every
// queued run ends `unavailable` at zero cost. See docs/development/personal-runs.md.
//
// Test only: `FLUX_TEST_PERSONAL_RUNS=anthropic-mock`, accepted only together with the existing
// test flag `FLUX_TEST_FAILURE_INJECTION=true`, composes the fixture connections and the REAL
// adapter registry with the Anthropic URL pointed at `FLUX_TEST_ANTHROPIC_URL`, a mock provider
// server in the same Compose project whose host the endpoint policy then allows. Its fixed fixture
// "key" is not a provider key. Any other value refuses to start.

export interface PersonalRunWorkerComposition {
  connections: PersonalConnectionLookup;
  compute: PersonalCompute;
  mode: 'production' | 'test-anthropic-mock';
  /**
   * F-027 A2/A6 (#484): with the provider on, each `server` run lists and calls its tools through the API's
   * `/mcp` with its run token (`FLUX_API_INTERNAL_URL`, default `http://api:8080`); the API composes the
   * matching turn reservation. The owner's own Claude Code runs through runtime-manager (#280).
   */
  tools?: PersonalToolHost;
  tokens: PersonalRunTokenIssuer;
  runtime: PersonalRuntime;
}

/** The run token issuer, the `server` tool host (only with the provider on) and the runtime engine. */
function runPorts(env: NodeJS.ProcessEnv, db: Database, compute: PersonalCompute, runtimeConfig: AgentRuntimeConfig) {
  const apiUrl = apiInternalUrl(env);
  const tokens = runTokenIssuer(db, apiUrl);
  return { tokens, runtime: managerPersonalRuntime(runtimeConfig, db), ...(compute.enabled ? { tools: mcpToolHost(tokens, `${apiUrl}/mcp`) } : {}) };
}

/** The agent runtime switched off (FLUX_AGENT_RUNTIME empty): no runtime run can start. */
const RUNTIME_OFF: AgentRuntimeConfig = { clients: [], commercialTermsAgreedOn: null, idleDays: null, manager: null };

export function personalRunWorkerComposition(env: NodeJS.ProcessEnv, db: Database, runtimeConfig: AgentRuntimeConfig = RUNTIME_OFF): PersonalRunWorkerComposition {
  const mode = env.FLUX_TEST_PERSONAL_RUNS ?? '';
  // A malformed operator allowlist or switch stops the worker in every mode.
  const policy = aiEndpointPolicyFromEnv(env);
  const switchedOn = (() => {
    const value = env.FLUX_PERSONAL_RUNS ?? '';
    if (value !== '' && value !== 'off' && value !== 'on') throw new Error('FLUX_PERSONAL_RUNS must be empty, off or on');
    return value === 'on';
  })();
  if (!mode) {
    const masterKey = switchedOn ? loadBackgroundMasterKey() : null;
    const compute = switchedOn && masterKey ? providerPersonalCompute({ enabled: true, resolveKey: personalKeyResolver(db, masterKey), policy }) : unavailablePersonalCompute;
    return { connections: personalConnectionLookup(db), compute, mode: 'production', ...runPorts(env, db, compute, runtimeConfig) };
  }
  if (mode !== 'anthropic-mock') throw new Error('FLUX_TEST_PERSONAL_RUNS must be empty or anthropic-mock');
  if (env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_PERSONAL_RUNS is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  const baseURL = env.FLUX_TEST_ANTHROPIC_URL ?? '';
  const mock = /^http:\/\/([a-z0-9.-]+)(:\d+)?$/.exec(baseURL);
  if (!mock) throw new Error('FLUX_TEST_ANTHROPIC_URL must be the http origin of the mock provider');
  const compute = providerPersonalCompute({
    enabled: true, timeoutMs: 30_000, baseUrls: { anthropic: baseURL },
    policy: parsePrivateTargets([env.FLUX_AI_PRIVATE_TARGETS ?? '', mock[1]].join(',')),
    resolveKey: async (keyRef) => (keyRef === TEST_FIXTURE_KEY_REF ? TEST_FIXTURE_API_KEY : null),
  });
  return { connections: testFixturePersonalConnections, compute, mode: 'test-anthropic-mock', ...runPorts(env, db, compute, runtimeConfig) };
}
