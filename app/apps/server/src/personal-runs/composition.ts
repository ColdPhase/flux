import { PERSONAL_RUN_LIMITS } from '@flux/contracts';
import { testFixturePersonalConnections, type Database, type PersonalConnectionLookup } from '@flux/core';
import { personalConnectionLookup } from '@flux/db';

// What the API composes for personal runs (#68, O-008, F-020). Production: the owner's own AI
// connections (#124 custody, PROV-1) are looked up, and the operator switch `FLUX_PERSONAL_RUNS=on`
// lets runs be queued for the provider; off (the default) every run fails closed as `provider_off`.
// Test only: `FLUX_TEST_PERSONAL_RUNS=anthropic-mock` together with
// `FLUX_TEST_FAILURE_INJECTION=true` uses the fixture connections and turns the switch on; the
// worker then dispatches to a mock provider (apps/worker/src/personal-runs/composition.ts).

export interface PersonalRunServerComposition {
  connections: PersonalConnectionLookup;
  providerEnabled: boolean;
  /**
   * F-027 AST-8 (#484): with the provider on, the worker runs the bounded tool loop through the MCP route
   * with each run's token, so a run reserves its turns; off, every run stays one request.
   */
  toolTurns: number;
  mode: 'production' | 'test-anthropic-mock';
}

/** The operator's switch for in-product personal runs: empty or `off` (default) or `on`. */
export function personalRunsSwitch(env: NodeJS.ProcessEnv): boolean {
  const value = env.FLUX_PERSONAL_RUNS ?? '';
  if (value !== '' && value !== 'off' && value !== 'on') throw new Error('FLUX_PERSONAL_RUNS must be empty, off or on');
  return value === 'on';
}

export function personalRunServerComposition(env: NodeJS.ProcessEnv, db: Database): PersonalRunServerComposition {
  const mode = env.FLUX_TEST_PERSONAL_RUNS ?? '';
  if (!mode) {
    const providerEnabled = personalRunsSwitch(env);
    return { connections: personalConnectionLookup(db), providerEnabled, toolTurns: providerEnabled ? PERSONAL_RUN_LIMITS.maxTurns : 1, mode: 'production' };
  }
  if (mode !== 'anthropic-mock') throw new Error('FLUX_TEST_PERSONAL_RUNS must be empty or anthropic-mock');
  if (env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_PERSONAL_RUNS is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  return { connections: testFixturePersonalConnections, providerEnabled: true, toolTurns: PERSONAL_RUN_LIMITS.maxTurns, mode: 'test-anthropic-mock' };
}
