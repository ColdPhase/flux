export const API_VERSION = 'v1';
export const SAMPLE_COMMAND_PATH = '/api/v1/integration/sample';

export interface SampleCommand {
  title: string;
}

export interface SampleAccepted {
  id: string;
  eventId: string;
  jobId: string;
}

/**
 * Test deployments only (#287): registers a public PKCE OAuth client for the MCP resource. It
 * exists only with `FLUX_FIXTURE_TOKEN` and `FLUX_TEST_FAILURE_INJECTION=true`; browser sessions
 * cannot register clients.
 */
export const FIXTURE_OAUTH_CLIENT_PATH = '/api/v1/integration/oauth-clients';

export interface FixtureOauthClientCommand {
  name: string;
  redirectUris: string[];
  /** Defaults to every MCP scope and `offline_access`. */
  scopes?: string[];
}

export interface FixtureOauthClientRegistered {
  clientId: string;
}

/** Better Auth endpoints are mounted below this prefix (sign-up/email, sign-in/email, sign-out, request-password-reset, reset-password). */
export const AUTH_BASE_PATH = '/api/auth';
export const IDENTITY_CAPABILITIES_PATH = '/api/v1/auth/capabilities';
export const ME_PATH = '/api/v1/me';
/** Sent with a ME_PATH request by a page that may be signed out: the answer is 200 `null` instead of a 401 that the browser logs (#546). */
export const ME_PROBE_HEADER = 'x-flux-session-probe';
export const SESSIONS_PATH = '/api/v1/sessions';
export const REVOKE_OTHER_SESSIONS_PATH = '/api/v1/sessions/revoke-others';

export interface IdentityCapabilities {
  passwordReset: 'available' | 'unavailable';
  /** Who can create a password account (#313): `verified` mails a link first; `off` is closed, including `verified` without email. */
  signup: 'open' | 'verified' | 'off';
  /** With the one provider in SSO-only mode (#315): no password sign-in, sign-up or reset; the page offers only SSO. */
  ssoOnly: boolean;
  /** Prepare mode (#315): the signed-in password account may link the provider now, before cutover. */
  linkable: boolean;
  /** The operator's single sign-on provider (#113), or null when only email/password sign-in exists. */
  sso: { providerId: string; label: string; /** The provider's discovery document answers right now (#310). */ reachable: boolean } | null;
}

export interface MeResponse {
  principal: { id: string; kind: 'human' };
  user: { id: string; email: string; name: string };
  session: { id: string; expiresAt: string };
}

/** Session tokens are never returned; revoke by session id. */
export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export * from './access.js';
export * from './project-goals.js';
export * from './push.js';
export * from './conversation.js';
export * from './files.js';
export * from './sketch.js';
export * from './work.js';
export * from './work-read.js';
export * from './live.js';
export * from './agent-proposals.js';
export * from './returns.js';
export * from './direct-message.js';
export * from './docs.js';
export * from './editing.js';
export * from './proactive-comparison.js';
export * from './ai-providers.js';
export * from './background-compute.js';
export * from './proactive-outcomes.js';
export * from './notifications.js';
export * from './needs-you.js';
export * from './search.js';
export * from './personal-runs.js';
export * from './export.js';

export * from './typing.js';
export * from './cowork.js';
export * from './github.js';
export * from './agent-execution.js';
export * from './agent-bootstrap.js';
export * from './project-agents.js';
export * from './agent-stops.js';
export * from './agent-questions.js';
export * from './agent-runtime.js';
export * from './agent-mcp-policy.js';

export * from './assistant.js';
export * from './assistant-jobs.js';
export * from './agent-connection-setup.js';
