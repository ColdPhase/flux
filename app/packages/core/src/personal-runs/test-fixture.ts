import { createHash } from 'node:crypto';
import type { PersonalConnectionLookup } from './ports.js';

// TEST FIXTURE ONLY (#68). A stand-in for #124's owner key connections, so the browser suite can
// drive a whole run through the real worker, the real Anthropic adapter and a MOCK provider
// server. The server and worker compose it only when both `FLUX_TEST_PERSONAL_RUNS=anthropic-mock`
// and `FLUX_TEST_FAILURE_INJECTION=true` are set (see docs/development/personal-runs.md); a
// production composition never does. The "key" is a fixed non-secret string the mock checks.

export const TEST_FIXTURE_KEY_REF = 'test-fixture-key-ref';
/** Not a key: the mock provider accepts exactly this value and the real API would reject it. */
export const TEST_FIXTURE_API_KEY = 'flux-test-fixture-not-a-provider-key';

function connectionIdOf(ownerUserId: string) {
  const hex = createHash('sha256').update(`flux-test-personal-connection:${ownerUserId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Every person has one stable, active fixture connection of their own. */
export const testFixturePersonalConnections: PersonalConnectionLookup = {
  resolve: async (ownerUserId) => ({
    id: connectionIdOf(ownerUserId), ownerUserId, status: 'active', keyRef: TEST_FIXTURE_KEY_REF,
    payer: { organization: 'Test fixture payer', workspace: 'Test fixture workspace' },
  }),
};
