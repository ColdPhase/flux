import { testFixturePersonalConnections, type AgentRuntimeConfig, type PersonalConnectionLookup } from '@flux/core';
import { personalConnectionLookup, type Database } from '@flux/db';

// What the API composes for personal runs (#68, O-008, F-020). Production: the owner's own AI
// connections (#124 custody, PROV-1) are looked up, and the operator switch `FLUX_PERSONAL_RUNS=on`
// lets runs be queued for the provider; off (the default) every run fails closed as `provider_off`.
// API keys run only in pi in the agent runtime (#1441, RT-1): without `pi` in FLUX_AGENT_RUNTIME (and the
// runtime itself) API keys are off as if the switch were, so nothing is queued that could only end unavailable.
// Test only: `FLUX_TEST_PERSONAL_RUNS=anthropic-mock` together with
// `FLUX_TEST_FAILURE_INJECTION=true` uses the fixture connections and turns the switch on; the
// worker then dispatches to a mock provider (apps/worker/src/personal-runs/composition.ts).

export interface PersonalRunServerComposition {
  connections: PersonalConnectionLookup;
  providerEnabled: boolean;
  mode: 'production' | 'test-anthropic-mock';
}

/** The operator's switch for in-product personal runs: empty or `off` (default) or `on`. */
export function personalRunsSwitch(env: NodeJS.ProcessEnv): boolean {
  const value = env.FLUX_PERSONAL_RUNS ?? '';
  if (value !== '' && value !== 'off' && value !== 'on') throw new Error('FLUX_PERSONAL_RUNS must be empty, off or on');
  return value === 'on';
}

export function personalRunServerComposition(env: NodeJS.ProcessEnv, db: Database, runtime: Pick<AgentRuntimeConfig, 'keys' | 'manager'>): PersonalRunServerComposition {
  const mode = env.FLUX_TEST_PERSONAL_RUNS ?? '';
  const inPi = runtime.keys === true && runtime.manager !== null;
  if (!mode) {
    const providerEnabled = personalRunsSwitch(env) && inPi;
    return { connections: personalConnectionLookup(db), providerEnabled, mode: 'production' };
  }
  if (mode !== 'anthropic-mock') throw new Error('FLUX_TEST_PERSONAL_RUNS must be empty or anthropic-mock');
  if (env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_PERSONAL_RUNS is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  return { connections: testFixturePersonalConnections, providerEnabled: inPi, mode: 'test-anthropic-mock' };
}
