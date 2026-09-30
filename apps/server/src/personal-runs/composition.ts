import { noPersonalConnections, testFixturePersonalConnections, type PersonalConnectionLookup } from '@flux/core';

// What the API composes for personal runs (#68, O-008). Production: no connection lookup until
// #124's key custody lands and the provider switch off, so enabling and invoking fail closed with
// an explicit state. Test only: `FLUX_TEST_PERSONAL_RUNS=anthropic-mock` together with
// `FLUX_TEST_FAILURE_INJECTION=true` uses the fixture connections and turns the switch on; the
// worker then dispatches to a mock provider (apps/worker/src/personal-runs/composition.ts).

export interface PersonalRunServerComposition {
  connections: PersonalConnectionLookup;
  providerEnabled: boolean;
  mode: 'production' | 'test-anthropic-mock';
}

export function personalRunServerComposition(env: NodeJS.ProcessEnv): PersonalRunServerComposition {
  const mode = env.FLUX_TEST_PERSONAL_RUNS ?? '';
  if (!mode) return { connections: noPersonalConnections, providerEnabled: false, mode: 'production' };
  if (mode !== 'anthropic-mock') throw new Error('FLUX_TEST_PERSONAL_RUNS must be empty or anthropic-mock');
  if (env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_PERSONAL_RUNS is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  return { connections: testFixturePersonalConnections, providerEnabled: true, mode: 'test-anthropic-mock' };
}
