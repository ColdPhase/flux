import { createHash } from 'node:crypto';
import { API_KEY_DAILY_BUDGET_CENTS, type AiPrice } from '@flux/contracts';
import type { PersonalConnection, PersonalConnectionLookup } from './ports.js';

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

const FIXTURE_MODEL = 'claude-sonnet-5';
/** Claude Sonnet 5's price ($2 / $10 per 1M tokens), fixed here so the fixture never depends on the day's price list (#1465). */
const FIXTURE_PRICE: AiPrice = { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, source: 'list', checkedOn: '2026-11-13' };

/** The fixture key's one daily budget: the default of a new key. */
export const FIXTURE_DAILY_BUDGET_CENTS = API_KEY_DAILY_BUDGET_CENTS.default;

/** Every person has one stable, active fixture connection of their own: Anthropic at a fixed list price. */
export const testFixturePersonalConnections: PersonalConnectionLookup = {
  list: async (ownerUserId) => [fixtureFor(ownerUserId)],
  resolve: async (ownerUserId, connectionId) => (connectionId !== undefined && connectionId !== connectionIdOf(ownerUserId) ? null : fixtureFor(ownerUserId)),
};

function fixtureFor(ownerUserId: string): PersonalConnection {
  return {
    id: connectionIdOf(ownerUserId), ownerUserId, status: 'active', keyRef: TEST_FIXTURE_KEY_REF, name: 'Test fixture key',
    provider: 'anthropic', model: FIXTURE_MODEL, baseUrl: null, dailyBudgetCents: FIXTURE_DAILY_BUDGET_CENTS, timeZone: 'UTC', createdAt: new Date(0),
    price: { ...FIXTURE_PRICE },
  };
}
