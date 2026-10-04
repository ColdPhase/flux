// Provider-neutral AI connection rules (F-020, #179): validation, the conservative token estimate,
// prices and the endpoint policy port. Adapters for the wire formats live in `@flux/agent-runtime`.

/**
 * Whether an owner-set base URL may be reached now (PROV-4): public HTTPS unless the instance
 * operator allowlists a private target. The adapter resolves the host and checks every address;
 * the same check runs again when a request connects, so a later DNS answer cannot redirect it.
 */
export interface AiEndpointPolicyPort {
  /** Null when allowed; otherwise a safe reason that names no address. */
  check(baseUrl: string): Promise<string | null>;
}

/** Without a composed policy no owner-set endpoint is accepted. */
export const refuseAllEndpoints: AiEndpointPolicyPort = { check: async () => 'Owner-set endpoints are not available on this server' };

export * from './validation.js';
export * from './estimate.js';
export * from './price.js';
