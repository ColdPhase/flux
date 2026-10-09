import type { AgentScope, AgentToolCapability } from '@flux/contracts';

// The tool list of one owner-invoked run (F-022 "Agent connection and permissions", "Run", "Hardening").
// It is derived, never written in the run code: a tool is in the run when the connection's current
// scopes make it available AND the run policy allows its scope. The `claude -p` allowed list and the
// MCP route's per-run listing both take this list, so changing the policy changes both.
//
// Today the policy is read-only: only `flux.context.read` tools. Editing tools (F-027, the assistant's
// per-area switches and approval mode) come with a later policy that adds their scopes here; no run
// code changes. A tool registered without a scope (none exists) would be refused by the default policy.

/** The scopes a run may use. Read-only today; F-027 may add write scopes behind per-area switches. */
export interface RunToolPolicy { allowedScopes: readonly AgentScope[] }

export const READ_ONLY_RUN_POLICY: RunToolPolicy = { allowedScopes: ['flux.context.read'] };

/** The names of the run's tools: available to the connection's current scopes and allowed by the policy. */
export function selectRunTools(capabilities: readonly AgentToolCapability[], policy: RunToolPolicy = READ_ONLY_RUN_POLICY): string[] {
  return capabilities
    .filter((tool) => tool.available && policy.allowedScopes.includes(tool.requiredScope))
    .map((tool) => tool.name);
}
