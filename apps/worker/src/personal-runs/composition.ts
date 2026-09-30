import { anthropicPersonalCompute } from '@flux/agent-runtime';
import {
  noPersonalConnections, TEST_FIXTURE_API_KEY, TEST_FIXTURE_KEY_REF, testFixturePersonalConnections, unavailablePersonalCompute,
  type PersonalCompute, type PersonalConnectionLookup,
} from '@flux/core';

// Which connection lookup and provider the worker composes for personal runs (#68, O-008).
//
// Production: nobody has a usable key connection until #124's key custody lands, and the
// provider is off, so every queued run ends `unavailable` at zero cost. The real Anthropic
// adapter exists (`@flux/agent-runtime`) but is wired only when a real connection lookup and key
// resolver exist; see docs/development/personal-runs.md "Switching production on".
//
// Test only: `FLUX_TEST_PERSONAL_RUNS=anthropic-mock`, accepted only together with the existing
// test flag `FLUX_TEST_FAILURE_INJECTION=true`, composes the fixture connections and the REAL
// adapter pointed at `FLUX_TEST_ANTHROPIC_URL`, a mock provider server in the same Compose
// project. Its fixed fixture "key" is not a provider key. Any other value refuses to start.

export interface PersonalRunWorkerComposition {
  connections: PersonalConnectionLookup;
  compute: PersonalCompute;
  mode: 'production' | 'test-anthropic-mock';
}

export function personalRunWorkerComposition(env: NodeJS.ProcessEnv): PersonalRunWorkerComposition {
  const mode = env.FLUX_TEST_PERSONAL_RUNS ?? '';
  if (!mode) return { connections: noPersonalConnections, compute: unavailablePersonalCompute, mode: 'production' };
  if (mode !== 'anthropic-mock') throw new Error('FLUX_TEST_PERSONAL_RUNS must be empty or anthropic-mock');
  if (env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_PERSONAL_RUNS is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  const baseURL = env.FLUX_TEST_ANTHROPIC_URL ?? '';
  if (!/^http:\/\/[a-z0-9.-]+(:\d+)?$/.test(baseURL)) throw new Error('FLUX_TEST_ANTHROPIC_URL must be the http origin of the mock provider');
  return {
    connections: testFixturePersonalConnections,
    compute: anthropicPersonalCompute({
      enabled: true, baseURL, timeoutMs: 30_000,
      resolveKey: async (keyRef) => (keyRef === TEST_FIXTURE_KEY_REF ? TEST_FIXTURE_API_KEY : null),
    }),
    mode: 'test-anthropic-mock',
  };
}
