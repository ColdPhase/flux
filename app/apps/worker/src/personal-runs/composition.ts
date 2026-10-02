import { aiEndpointPolicyFromEnv, parsePrivateTargets, providerPersonalCompute } from '@flux/agent-runtime';
import {
  noPersonalConnections, TEST_FIXTURE_API_KEY, TEST_FIXTURE_KEY_REF, testFixturePersonalConnections, unavailablePersonalCompute,
  type PersonalCompute, type PersonalConnectionLookup,
} from '@flux/core';

// Which connection lookup and provider the worker composes for personal runs (#68, O-008; F-020).
//
// Production: nobody has a usable key connection until the real lookup over #124's custody is
// wired (#68, owned by @Zamojski5), and the provider is off, so every queued run ends `unavailable`
// at zero cost. The adapters exist (`@flux/agent-runtime`'s registry, one per wire format, selected
// by the connection's provider kind) but are wired only when a real connection lookup and key
// resolver exist; see docs/development/personal-runs.md "Switching production on". When they are,
// compose `providerPersonalCompute({ enabled, resolveKey, policy: aiEndpointPolicyFromEnv(env) })`.
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
}

export function personalRunWorkerComposition(env: NodeJS.ProcessEnv): PersonalRunWorkerComposition {
  const mode = env.FLUX_TEST_PERSONAL_RUNS ?? '';
  // A malformed operator allowlist stops the worker in every mode.
  aiEndpointPolicyFromEnv(env);
  if (!mode) return { connections: noPersonalConnections, compute: unavailablePersonalCompute, mode: 'production' };
  if (mode !== 'anthropic-mock') throw new Error('FLUX_TEST_PERSONAL_RUNS must be empty or anthropic-mock');
  if (env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_PERSONAL_RUNS is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  const baseURL = env.FLUX_TEST_ANTHROPIC_URL ?? '';
  const mock = /^http:\/\/([a-z0-9.-]+)(:\d+)?$/.exec(baseURL);
  if (!mock) throw new Error('FLUX_TEST_ANTHROPIC_URL must be the http origin of the mock provider');
  return {
    connections: testFixturePersonalConnections,
    compute: providerPersonalCompute({
      enabled: true, timeoutMs: 30_000, baseUrls: { anthropic: baseURL },
      policy: parsePrivateTargets([env.FLUX_AI_PRIVATE_TARGETS ?? '', mock[1]].join(',')),
      resolveKey: async (keyRef) => (keyRef === TEST_FIXTURE_KEY_REF ? TEST_FIXTURE_API_KEY : null),
    }),
    mode: 'test-anthropic-mock',
  };
}
