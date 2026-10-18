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
    response(observation: OAuthHttpObservation) {
      if (Object.values(endpoints).includes(observation.stage) && status(observation.status) !== null && http.length < 64)
        http.push({ stage: observation.stage, status: observation.status });
    },
    report(nativeOutput: string, exitCode: number | null) {
      return { schema: 'flux.oauth-diagnostic/1' as const, stages: [...stages], http: [...http], callbackCompleted,
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
