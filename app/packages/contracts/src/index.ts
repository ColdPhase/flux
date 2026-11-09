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
}

export interface FixtureOauthClientRegistered {
  clientId: string;
}

/**
 * Test deployments only (the same switches as the OAuth client route): a signed-in person's connection of one of their own agents, as a
 * first sign-in would have made it, so a browser test can start from a connected client without the OAuth round trip. Not a product
 * route: the product makes a connection only on a client's consent page (#859).
 */
export const FIXTURE_AGENT_CONNECTION_PATH = '/api/v1/integration/agent-connections';

export interface FixtureAgentConnectionCommand {
  agentId: string;
  name?: string;
  clientDesignation?: 'claude_code' | 'codex' | 'other';
}

/** Better Auth endpoints are mounted below this prefix (sign-up/email, sign-in/email, sign-out, request-password-reset, reset-password). */
export const AUTH_BASE_PATH = '/api/auth';
export const IDENTITY_CAPABILITIES_PATH = '/api/v1/auth/capabilities';
export const ME_PATH = '/api/v1/me';
/** Better Auth's own endpoints the web client calls, below AUTH_BASE_PATH. */
export const AUTH_SIGN_UP_EMAIL_PATH = `${AUTH_BASE_PATH}/sign-up/email`;
export const AUTH_SIGN_IN_EMAIL_PATH = `${AUTH_BASE_PATH}/sign-in/email`;
export const AUTH_SIGN_IN_SOCIAL_PATH = `${AUTH_BASE_PATH}/sign-in/social`;
export const AUTH_SIGN_OUT_PATH = `${AUTH_BASE_PATH}/sign-out`;
export const AUTH_REQUEST_PASSWORD_RESET_PATH = `${AUTH_BASE_PATH}/request-password-reset`;
export const AUTH_RESET_PASSWORD_PATH = `${AUTH_BASE_PATH}/reset-password`;
/** Settings → Account (#763 SG-1): the person's own name, password and address. */
export const AUTH_UPDATE_USER_PATH = `${AUTH_BASE_PATH}/update-user`;
export const AUTH_CHANGE_PASSWORD_PATH = `${AUTH_BASE_PATH}/change-password`;
/** Also takes `currentPassword`; refused under single sign-on. */
export const AUTH_CHANGE_EMAIL_PATH = `${AUTH_BASE_PATH}/change-email`;
export const AUTH_OAUTH2_CONSENT_PATH = `${AUTH_BASE_PATH}/oauth2/consent`;
/** An unverified account's pending address claim (#313) and provider linking (#315). */
export const IDENTITY_CLAIM_PATH = '/api/v1/identity/claim';
export const IDENTITY_LINK_PATH = '/api/v1/identity/link';
export const identityLinkPath = (providerId: string) => `/api/v1/identity/links/${encodeURIComponent(providerId)}`;
/** Sent with a ME_PATH request by a page that may be signed out: the answer is 200 `null` instead of a 401 that the browser logs (#546). */
export const ME_PROBE_HEADER = 'x-flux-session-probe';
export const SESSIONS_PATH = '/api/v1/sessions';
export const REVOKE_OTHER_SESSIONS_PATH = '/api/v1/sessions/revoke-others';
/**
 * The password rule of a password account (#990, ASVS 4.0.3 V2.1.1/V2.1.2): at least 12 and at most 128 characters. The server
 * also refuses a password on the common-password list or one that is easy to guess (`PASSWORD_TOO_WEAK`); the form repeats only the length.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export interface IdentityCapabilities {
  /** The company's name for the sign-in page (F-037), or null before setup and while it has the name setup gave it. */
  company: string | null;
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
export * from './ai-lock.js';
export * from './encryption.js';
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
export * from './ai-providers.js';
export * from './background-compute.js';
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
export * from './agent-stops.js';
export * from './agent-tasks.js';
export * from './agent-questions.js';
export * from './agent-runtime.js';
export * from './agent-tools.js';

export * from './agents.js';
export * from './assistant.js';
export * from './assistant-jobs.js';
export * from './assistant-model.js';
