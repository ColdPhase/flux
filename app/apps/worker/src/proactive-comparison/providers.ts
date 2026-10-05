import { aiEndpointPolicyFromEnv, providerComparison } from '@flux/agent-runtime';
import type { ComparisonProvider } from '@flux/core';

/**
 * The comparison adapters the worker composes (F-020, #179): the registry of `@flux/agent-runtime`,
 * which writes each request in the wire format of the owner's connection, under the operator's
 * endpoint policy (`FLUX_AI_PRIVATE_TARGETS`). The comparison worker uses it when the operator switched
 * background comparisons on (#58).
 */
export function comparisonProviders(env: NodeJS.ProcessEnv): ComparisonProvider {
  return providerComparison({ policy: aiEndpointPolicyFromEnv(env) });
}
