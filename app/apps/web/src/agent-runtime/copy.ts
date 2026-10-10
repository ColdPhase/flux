import type { AgentRuntimePayer, AgentRuntimeSignInMethod, ClaudeCodeSignInMethod } from '@flux/contracts';

// The words for the runtime (F-022, F-023 FF-1): plain, what happens and why. Product names appear as
// plain text, never as logos.

export const METHODS: { id: ClaudeCodeSignInMethod; title: string; detail: string; payer: AgentRuntimePayer | 'organization_plan' }[] = [
  { id: 'claude_account', title: 'Claude account', detail: 'Pro, Max, Team or Enterprise. Use comes from your Claude plan.', payer: 'claude_plan' },
  { id: 'console', title: 'Anthropic Console', detail: 'API usage billing in your Console organization. Anthropic recommends API billing for tools like this.', payer: 'anthropic_console' },
  { id: 'sso', title: 'Single sign-on (SSO)', detail: 'Your organization’s sign-in for Claude.', payer: 'organization_plan' },
];

export const METHOD_NAME: Record<AgentRuntimeSignInMethod, string> = {
  claude_account: 'Claude account', console: 'Anthropic Console', sso: 'single sign-on',
  device_code: 'ChatGPT device code', api_key: 'OpenAI API key', access_token: 'access token',
};

/** F-027 AST-1: plain account labels for a signed-in Claude Code account. */
export const accountLabel = (method: AgentRuntimeSignInMethod | null) => (
  method === 'console' ? 'Anthropic Console · API billing' : method === 'sso' ? 'Claude · your organization' : 'Claude · your subscription'
);

/** F-022 "Payer and data": who pays, never shown as zero. */
export const PAYER: Record<AgentRuntimePayer | 'organization_plan', string> = {
  claude_plan: 'Your Claude plan (plan limits or paid extra usage, not visible to Flux).',
  anthropic_console: 'Your Anthropic Console organization (API billing, cost not reported to Flux).',
  organization_plan: 'Your organization’s Claude plan (plan limits or paid extra usage, not visible to Flux).',
  unknown: 'Not reported by Claude Code, so Flux cannot say. It is never another person.',
};

export const dateTime = (iso: string) => {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? iso : value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
