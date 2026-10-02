import { aiEndpointPolicyFromEnv, parsePrivateTargets, providerPersonalCompute } from '@flux/agent-runtime';
import {
  TEST_FIXTURE_API_KEY, TEST_FIXTURE_KEY_REF, testFixturePersonalConnections, unavailablePersonalCompute,
  type Database, type PersonalCompute, type PersonalConnectionLookup,
} from '@flux/core';
import { loadBackgroundMasterKey, personalConnectionLookup, personalKeyResolver } from '@flux/db';

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
}

export function personalRunWorkerComposition(env: NodeJS.ProcessEnv, db: Database): PersonalRunWorkerComposition {
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
    return {
      connections: personalConnectionLookup(db),
      compute: switchedOn && masterKey ? providerPersonalCompute({ enabled: true, resolveKey: personalKeyResolver(db, masterKey), policy }) : unavailablePersonalCompute,
      mode: 'production',
    };
  }
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
