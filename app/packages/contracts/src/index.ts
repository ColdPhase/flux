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

/**
 * Test deployments only (the same switches, with the fixture bearer): sets when a person was last active (#1225, C-58) to `minutesAgo` minutes
 * before now, or erases it with `null`, so a browser test can show "Active 2 h ago" without waiting. Not a product route.
 */
export const FIXTURE_LAST_ACTIVE_PATH = '/api/v1/integration/last-active';

export interface FixtureLastActiveCommand {
  userId: string;
  minutesAgo: number | null;
}

export interface FixtureAgentConnectionCommand {
  agentId: string;
  name?: string;
  clientDesignation?: 'claude_code' | 'codex' | 'other';
}

/** Better Auth endpoints are mounted below this prefix (sign-up/email, sign-in/email, sign-out, request-password-reset, reset-password). */
export const AUTH_BASE_PATH = '/api/auth';
export const IDENTITY_CAPABILITIES_PATH = '/api/v1/auth/capabilities';
export const ME_PATH = '/api/v1/me';
/**
 * PUT `SetTimeZone`, 204 (#1168, C-57): the web app saves its browser's IANA zone on the signed-in person whenever it is not the one
 * `MeResponse.user.timeZone` holds. Their schedules run in it and their agents' clock reads in it.
 */
export const ME_TIME_ZONE_PATH = '/api/v1/me/time-zone';
/**
 * PUT `SetLastActive`, 204 (#1225, C-58): "Show when I was last active" in Settings › Account. On by default; off, Flux erases the time it holds
 * for the person, stops writing it and the people lists show no line for them. `MeResponse.user.showLastActive` holds it.
 */
export const ME_LAST_ACTIVE_PATH = '/api/v1/me/last-active';
/** Home's first-steps card (founder decision 2026-11-13, #1438): `GET` the steps left, `POST …/hide` hides the card for good. */
export const ME_FIRST_STEPS_PATH = '/api/v1/me/first-steps';
export const ME_FIRST_STEPS_HIDE_PATH = `${ME_FIRST_STEPS_PATH}/hide`;
/**
 * A step the server can tell is left. An owner or admin: `name_company` (still the name setup gave it), `invite_people` (nobody else is in
 * the company and no invite link was ever made), `connect_ai` (no AI connection of their own). A member: `first_message` (none written in
 * any space), `photo` (no profile photo). The member's third row, notifications on this device, is the browser's to know (`offerPush`).
 * Only a new person has a card: someone who joined the company in the last 30 days and has a step left, until it is hidden or done once.
 */
export type FirstStep = 'name_company' | 'invite_people' | 'connect_ai' | 'first_message' | 'photo';
/** A person who joined with a link the owner or admin made and whom they have not yet written to (#1438, #1424): "Nia joined · Say hello". */
export interface FirstStepJoined { userId: string; name: string }
export interface FirstSteps {
  /** The steps left, in the card's order; empty for a guest, someone outside the company, someone who joined it long ago, and once the card was hidden or done. */
  steps: FirstStep[];
  /**
   * Who joined with this person's links and has no direct message with them yet, newest first, at most the card's three rows. They ride along only
   * beside a step that is left, in the place of "Invite people" (that step is done once a link was made), and leave when a direct message is opened.
   */
  joined: FirstStepJoined[];
  /** A member whose card has a step left: the browser may add "Get notifications on this device" while it is not subscribed. Never alone: with no step left there is no card. */
  offerPush: boolean;
  /** Everyone, for "Write your first message" (opens it with the composer ready); null when there is none. */
  everyoneSpaceId: string | null;
}
/**
 * Better Auth's own endpoints the web client calls, below AUTH_BASE_PATH. A sign-up also carries the link it comes from (#1471):
 * `setupToken` (the first account, from `SETUP_PAGE#<token>`) or `inviteToken` (an invite link).
 */
export const AUTH_SIGN_UP_EMAIL_PATH = `${AUTH_BASE_PATH}/sign-up/email`;
/** The page the setup link opens; the token follows `#` (#1471). */
export const SETUP_PAGE = '/setup';
/** The page a reset link opens; the token follows `#` (a mailed link arrives as `?token=`). */
export const RESET_PASSWORD_PAGE = '/reset-password';
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
  /** No company exists yet (and sign-in is not SSO-only): the first account, its owner, comes from the setup link (#1471). */
  setup: boolean;
  /**
   * Who can create a password account (#1471): `link`, only from the setup link or an invite link; `open`, also without a link, only
   * on a test deployment. Single sign-on makes accounts too (`sso`).
   */
  signup: 'link' | 'open';
  /** With the one provider in SSO-only mode (#315): no password sign-in, sign-up or reset; the page offers only SSO. */
  ssoOnly: boolean;
  /** Prepare mode (#315): the signed-in password account may link the provider now, before cutover. */
  linkable: boolean;
  /** The operator's single sign-on provider (#113), or null when only email/password sign-in exists. */
  sso: { providerId: string; label: string; /** The provider's discovery document answers right now (#310). */ reachable: boolean } | null;
}

export interface MeResponse {
  principal: { id: string; kind: 'human' };
  /**
   * `timeZone`: the person's own IANA zone, their browser's as last saved (`ME_TIME_ZONE_PATH`); UTC until a browser has said.
   * `showLastActive`: whether others may see when the person was last active (`ME_LAST_ACTIVE_PATH`, C-58); true until they turn it off.
   */
  user: { id: string; email: string; name: string; timeZone: string; showLastActive: boolean };
  session: { id: string; expiresAt: string };
}

export interface SetLastActive {
  /** Whether others who can see the person may see when they were last active. */
  show: boolean;
}

export interface SetTimeZone {
  /** An IANA time zone, as the browser names it (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
  timeZone: string;
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
export * from './message-format.js';
export * from './names.js';
export * from './pictures.js';
export * from './sketch.js';
export * from './work.js';
export * from './work-read.js';
export * from './views.js';
export * from './live.js';
export * from './agent-proposals.js';
export * from './returns.js';
export * from './direct-message.js';
export * from './docs.js';
export * from './editing.js';
export * from './ai-providers.js';
export * from './ai-model-families.js';
export * from './background-compute.js';
export * from './notifications.js';
export * from './needs-you.js';
export * from './search.js';
export * from './search-words.js';
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
export * from './agent-summary.js';

export * from './agents.js';
export * from './assistant.js';
export * from './assistant-jobs.js';
export * from './assistant-model.js';
export * from './sidebar.js';
