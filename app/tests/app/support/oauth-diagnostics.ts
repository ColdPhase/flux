/** Closed diagnostic vocabulary. Raw URLs, response bodies, native output and credentials never leave this module. */
export const OAUTH_DIAGNOSTIC_STAGES = ['native_login_started', 'authorization_received', 'sign_in_ready', 'connection_selected',
  'consent_ready', 'consent_submitted', 'callback_navigation', 'callback_response', 'callback_wait_failed', 'native_login_finished'] as const;
export type OAuthDiagnosticStage = typeof OAUTH_DIAGNOSTIC_STAGES[number];
export const OAUTH_DIAGNOSTIC_CODES = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'invalid_target', 'access_denied', 'server_error', 'temporarily_unavailable'] as const;
const endpoints = { '/.well-known/oauth-authorization-server': 'authorization_server_discovery',
  '/.well-known/oauth-protected-resource': 'protected_resource_discovery', '/.well-known/oauth-protected-resource/mcp': 'protected_resource_discovery',
  '/.well-known/oauth-authorization-server/api/auth': 'authorization_server_discovery',
  '/api/auth/.well-known/oauth-authorization-server': 'authorization_server_discovery',
  '/api/auth/oauth2/authorize': 'authorization_endpoint', '/api/auth/oauth2/token': 'token_endpoint',
  '/api/auth/oauth2/consent': 'consent_endpoint', '/api/auth/oauth2/continue': 'continuation_endpoint' } as const;
export interface OAuthBrowserObservation { stage: OAuthDiagnosticStage; status?: number }
export interface OAuthHttpObservation { stage: typeof endpoints[keyof typeof endpoints]; status: number }
const status = (input: number): number | null => Number.isInteger(input) && input >= 100 && input <= 599 ? input : null;
export function oauthHttpObservation(rawUrl: string, httpStatus: number): OAuthHttpObservation | null {
  let pathname: string;
  try { pathname = new URL(rawUrl, 'http://fixture.invalid').pathname; } catch { return null; }
  const stage = endpoints[pathname as keyof typeof endpoints], checked = status(httpStatus);
  return stage && checked !== null ? { stage, status: checked } : null;
}
/** Fixed codes only; matching text is an observed marker, never an inferred OAuth diagnosis. */
export function oauthObservedCodes(nativeOutput: string) {
  return OAUTH_DIAGNOSTIC_CODES.filter(code => new RegExp(`\\b${code}\\b`, 'i').test(nativeOutput));
}
export function createOAuthDiagnostic() {
  const stages: OAuthDiagnosticStage[] = [], http: (OAuthHttpObservation | { stage: 'callback_response'; status: number })[] = [];
  const callbacks: OAuthCallbackObservation[] = [];
  let callbackCompleted = false;
  return {
    browser(observation: OAuthBrowserObservation) {
      if (!OAUTH_DIAGNOSTIC_STAGES.includes(observation.stage)) return;
      if (stages.length < 32) stages.push(observation.stage);
      if (observation.stage === 'callback_response' && observation.status !== undefined && status(observation.status) !== null) {
        if (http.length < 64) http.push({ stage: 'callback_response', status: observation.status });
        if (observation.status >= 200 && observation.status < 300) callbackCompleted = true;
      }
    },
    callback(observation: OAuthCallbackObservation) {
      const target = observation.target;
      if (!['request', 'response', 'failure'].includes(observation.phase) || !['base', 'suffixed', 'other'].includes(target.path)
        || ![target.loopback, target.expectedPort, target.issuerPresent, target.codePresent, target.errorPresent].every(value => typeof value === 'boolean')) return;
      const checkedStatus = observation.status === undefined ? null : status(observation.status);
      const failure = observation.failure && OAUTH_BROWSER_FAILURES.includes(observation.failure) ? observation.failure : undefined;
      if (callbacks.length < 16) callbacks.push({ phase: observation.phase,
        target: { loopback: target.loopback, expectedPort: target.expectedPort, path: target.path, issuerPresent: target.issuerPresent,
          codePresent: target.codePresent, errorPresent: target.errorPresent }, ...(checkedStatus !== null ? { status: checkedStatus } : {}), ...(failure ? { failure } : {}) });
    },
    response(observation: OAuthHttpObservation) {
      if (Object.values(endpoints).includes(observation.stage) && status(observation.status) !== null && http.length < 64)
        http.push({ stage: observation.stage, status: observation.status });
    },
    report(nativeOutput: string, exitCode: number | null) {
      return { schema: 'flux.oauth-diagnostic/1' as const, stages: [...stages], http: [...http], callbacks: [...callbacks], callbackCompleted,
        observedCodes: oauthObservedCodes(nativeOutput), nativeExitCode: exitCode !== null && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null };
    },
  };
}

/** Login-only must be explicitly opted in and can never select Claude or reach workflow execution. */
export function oauthLoginOnly(env: Record<string, string | undefined>) {
  if (env.FLUX_TEST_MCP_OAUTH_ONLY !== '1') return false;
  if (env.FLUX_TEST_MCP_LIVE_WORKFLOW !== '1' || env.FLUX_TEST_MCP_LIVE_CLIENT !== 'codex')
    throw new Error('Login-only diagnosis requires the explicit Codex fixture selector and workflow opt-in.');
  return true;
}

export interface OAuthCallbackTarget {
  loopback: boolean; expectedPort: boolean; path: 'base' | 'suffixed' | 'other';
  issuerPresent: boolean; codePresent: boolean; errorPresent: boolean;
}
export const OAUTH_BROWSER_FAILURES = ['connection_refused', 'connection_closed', 'connection_reset', 'name_not_resolved',
  'timed_out', 'aborted', 'blocked', 'tls', 'unknown'] as const;
export type OAuthBrowserFailure = typeof OAUTH_BROWSER_FAILURES[number];
export interface OAuthCallbackObservation {
  phase: 'request' | 'response' | 'failure'; target: OAuthCallbackTarget; status?: number; failure?: OAuthBrowserFailure;
}
/** Identical escaping to the successful frozen #612 harness. Match evidence is separate from network/native completion. */
export function oauthCallbackPattern(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid fixture callback port is required.');
  return new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${port}/callback`);
}
export function oauthCallbackTarget(rawUrl: string, expectedPort: number): OAuthCallbackTarget | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  return { loopback, expectedPort: Number(url.port || (url.protocol === 'http:' ? 80 : url.protocol === 'https:' ? 443 : 0)) === expectedPort,
    path: url.pathname === '/callback' ? 'base' : /^\/callback\/[^/]+\/?$/.test(url.pathname) ? 'suffixed' : 'other',
    issuerPresent: url.searchParams.has('iss'), codePresent: url.searchParams.has('code'), errorPresent: url.searchParams.has('error') };
}
/** Only fixed browser transport categories leave the classifier, never the browser's original message. */
export function oauthBrowserFailure(rawFailure: string): OAuthBrowserFailure {
  const code = rawFailure.toUpperCase();
  if (code.includes('CONNECTION_REFUSED') || code.includes('COULD NOT CONNECT') || code.includes('CONNECTION REFUSED')) return 'connection_refused';
  if (code.includes('CONNECTION_CLOSED')) return 'connection_closed';
  if (code.includes('CONNECTION_RESET')) return 'connection_reset';
  if (code.includes('NAME_NOT_RESOLVED') || code.includes('HOSTNAME') && code.includes('RESOLVE')) return 'name_not_resolved';
  if (code.includes('TIMED_OUT') || code.includes('TIMEOUT')) return 'timed_out';
  if (code.includes('ABORTED') || code.includes('CANCELLED')) return 'aborted';
  if (code.includes('BLOCKED')) return 'blocked';
  if (code.includes('CERT_') || code.includes('SSL_') || code.includes('TLS')) return 'tls';
  return 'unknown';
}


export function oauthComparisonOnly(env: Record<string, string | undefined>) {
  if (env.FLUX_TEST_MCP_OAUTH_COMPARE !== '1') return false;
  if (!oauthLoginOnly(env)) throw new Error('OAuth comparison requires explicit login-only mode.');
  return true;
}
