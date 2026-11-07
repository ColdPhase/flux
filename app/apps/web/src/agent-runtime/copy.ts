import type { AgentRuntimePayer, AgentRuntimeSignInMethod, ClaudeCodeSignInMethod, CodexSignInMethod } from '@flux/contracts';
import type { ConsoleOutcome } from './SignInConsole';

// The words for the runtime (F-022, F-023 FF-1): plain, what happens and why. Product names appear as
// plain text, never as logos.

export const METHODS: { id: ClaudeCodeSignInMethod; title: string; detail: string; payer: AgentRuntimePayer | 'organization_plan' }[] = [
  { id: 'claude_account', title: 'Claude account', detail: 'Pro, Max, Team or Enterprise. Use comes from your Claude plan.', payer: 'claude_plan' },
  { id: 'console', title: 'Anthropic Console', detail: 'API usage billing in your Console organization. Anthropic recommends API billing for tools like this.', payer: 'anthropic_console' },
  { id: 'sso', title: 'Single sign-on (SSO)', detail: 'Your organization’s sign-in for Claude.', payer: 'organization_plan' },
];

/** Codex's own `codex login` methods (F-022 T6 #281): ChatGPT's device code first, the others under "Other ways". */
export const CODEX_METHODS: { id: CodexSignInMethod; title: string; detail: string; payer: AgentRuntimePayer }[] = [
  { id: 'device_code', title: 'ChatGPT account', detail: 'Plus, Pro, Business, Enterprise or Edu. Use comes from your ChatGPT plan.', payer: 'chatgpt_plan' },
  { id: 'api_key', title: 'OpenAI API key', detail: 'API usage billing in your OpenAI organization. OpenAI recommends API keys for automation.', payer: 'openai_api' },
  { id: 'access_token', title: 'Access token', detail: 'A token your organization’s ChatGPT workspace gave you.', payer: 'unknown' },
];

/** F-027 Journey 6: the two ChatGPT sign-in rows, exact copy and their next step. */
export const SIGN_IN_PROBLEM: Record<'device_auth_disabled' | 'code_expired', { text: string; action: string; href?: string }> = {
  device_auth_disabled: { text: 'ChatGPT needs one setting first: turn on device code sign-in in ChatGPT → Settings → Security.', action: 'Open ChatGPT settings',
    href: 'https://chatgpt.com/#settings/Security' },
  code_expired: { text: 'That code has expired. Codes work once, for a few minutes.', action: 'Get a new code' },
};

const SIGN_IN_ERRORS: Record<string, string> = {
  busy: 'Your runtime is busy with another sign-in or task. Try again in a moment.',
  unavailable: 'The runtime could not confirm the operation. Check its current state before trying again.',
  refused: 'This sign-in could not start. It may have expired or belong to another session.',
  cancelled: 'You cancelled the sign-in. Runtime access stays disabled until cleanup is confirmed; both clients may need to sign in again.',
  superseded: 'This sign-in result is no longer current and was not accepted. Check the current runtime state before starting again.',
  ended: 'The sign-in connection ended before its result was confirmed. Flux is recovering the runtime safely; both clients may need to sign in again.',
};

/** Why a sign-in did not end signed in, in one line (the pages and the Connect AI window). */
export function signInFailure(outcome: Pick<ConsoleOutcome, 'error' | 'ended'>, cli: 'Claude Code' | 'Codex'): string {
  if (outcome.error) return SIGN_IN_ERRORS[outcome.error] ?? SIGN_IN_ERRORS.ended!;
  if (outcome.ended === 'timed_out') return `The sign-in ran for 15 minutes and was stopped. ${cli} did not report a login.`;
  return cli === 'Codex' ? 'Codex ended without reporting a login, so you are not signed in.'
    : 'Claude Code ended without reporting a login, so you are not signed in. If the code was refused, try again and paste the whole code.';
}

/** F-027 AST-1: plain account labels for a signed-in Claude Code or Codex account. */
export const accountLabel = (method: AgentRuntimeSignInMethod | null) => (
  method === 'console' ? 'Anthropic Console · API billing' : method === 'sso' ? 'Claude · your organization'
    : method === 'device_code' ? 'ChatGPT · your subscription' : method === 'api_key' ? 'OpenAI · API key'
      : method === 'access_token' ? 'ChatGPT · your organization' : 'Claude · your subscription'
);

/** F-022 "Payer and data": who pays, never shown as zero. */
export const PAYER: Record<AgentRuntimePayer | 'organization_plan', string> = {
  claude_plan: 'Your Claude plan (plan limits or paid extra usage, not visible to Flux).',
  anthropic_console: 'Your Anthropic Console organization (API billing, cost not reported to Flux).',
  chatgpt_plan: 'Your ChatGPT plan (plan limits or credits, not visible to Flux).',
  openai_api: 'Your OpenAI API organization (API billing, cost not reported to Flux).',
  organization_plan: 'Your organization’s Claude plan (plan limits or paid extra usage, not visible to Flux).',
  unknown: 'Not reported by the program, so Flux cannot say. It is never another person.',
};

export const dateTime = (iso: string) => {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? iso : value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
