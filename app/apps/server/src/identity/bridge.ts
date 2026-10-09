import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH_BASE_PATH, type ApiError, type IdentityCapabilities } from '@flux/contracts';
import { CLIENT_IP_HEADER, type FluxAuth } from './auth.js';
import { oauthRequestContext, type OauthRequests } from './oauth-flow.js';
import type { SignInFacts, SignIns } from './sign-in.js';
import type { SessionResolver } from './session.js';

// Forwarding headers are dropped before Better Auth sees a request. Client addresses come
// from Fastify's request.ip, which honours only the configured trusted proxies.
const UNTRUSTED_FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'x-client-ip', 'cf-connecting-ip', 'true-client-ip', CLIENT_IP_HEADER];
const PASSWORD_RESET_REQUEST_PATHS = new Set([`${AUTH_BASE_PATH}/request-password-reset`, `${AUTH_BASE_PATH}/forget-password`]);
const SOCIAL_SIGN_IN_PATH = `${AUTH_BASE_PATH}/sign-in/social`;

/** Whether a sign-in body carries a raw ID token (Better Auth's direct ID-token sign-in branch). */
function carriesIdToken(body: unknown): boolean {
  if (typeof body === 'string') {
    try { return carriesIdToken(JSON.parse(body)); } catch { return body.includes('idToken'); }
  }
  return !!body && typeof body === 'object' && 'idToken' in body;
}

/**
 * Better Auth echoes the raw session token in sign-in/sign-up and get-session bodies. The
 * browser only needs the HttpOnly cookie, so the bridge removes the token from JSON bodies
 * and script cannot read or exfiltrate it.
 */
function redactSessionTokens(text: string) {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return text; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return text;
  const record = data as Record<string, unknown>;
  delete record.token;
  if (record.session && typeof record.session === 'object') delete (record.session as Record<string, unknown>).token;
  return JSON.stringify(record);
}

export interface AuthBridgeOptions {
  auth: FluxAuth;
  publicOrigin: string;
  passwordReset: IdentityCapabilities['passwordReset'];
  oauthRequests: OauthRequests;
  signIns: SignIns;
  /** Reads the cookie's session, which ends it when the provider's confirmation lapsed (F-024 S2, #312). */
  sessions: Pick<SessionResolver, 'resolveSession'>;
}

/** Forwards auth endpoints and the exact OAuth discovery paths to Better Auth. */
export function registerAuthBridge(app: FastifyInstance, { auth, publicOrigin, passwordReset, oauthRequests, signIns, sessions }: AuthBridgeOptions) {
  // OAuth token and revocation endpoints use HTML form encoding. Preserve the
  // bounded raw payload so Better Auth validates it, rather than Fastify's 415.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  const forward = async (request: FastifyRequest, reply: FastifyReply) => {
      // Build the URL from the configured origin, never from Host or an absolute-form target.
      const target = new URL(request.url, publicOrigin);
      const url = new URL(`${target.pathname}${target.search}`, publicOrigin);
      // Single sign-on uses only the browser authorization-code flow (#113): a client may not
      // present a raw ID token it obtained elsewhere.
      if (url.pathname === SOCIAL_SIGN_IN_PATH && carriesIdToken(request.body)) {
        return reply.code(400).send({ error: 'Sign-in with a raw ID token is not accepted', code: 'ID_TOKEN_SIGN_IN_DISABLED' } satisfies ApiError);
      }
      if (passwordReset === 'unavailable' && PASSWORD_RESET_REQUEST_PATHS.has(url.pathname)) {
        return reply.code(503).send({ error: 'Password reset is unavailable', code: 'PASSWORD_RESET_UNAVAILABLE' } satisfies ApiError);
      }
      // Better Auth reads the session itself on the authorization steps. Resolving it first ends a session whose
      // provider confirmation lapsed, so the person is sent through the provider again.
      if (request.headers.cookie && (url.pathname.startsWith(`${AUTH_BASE_PATH}/oauth2/`) || url.pathname === `${AUTH_BASE_PATH}/get-session`))
        await sessions.resolveSession(request.headers);
      const headers = fromNodeHeaders(request.headers);
      for (const name of UNTRUSTED_FORWARDING_HEADERS) headers.delete(name);
      headers.set(CLIENT_IP_HEADER, request.ip);
      const body = request.body === undefined || request.body === null ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      let context;
      try { context = await oauthRequestContext(url, request.body, (await auth.$context).secret, `${publicOrigin}/mcp`); }
      catch { return reply.code(400).send({ error: 'Invalid OAuth request', code: 'INVALID_OAUTH_QUERY' }); }
      const incoming = new Request(url, { method: request.method, headers, body });
      const facts: SignInFacts = {};
      const handle = () => signIns.run(facts, () => auth.handler(incoming));
      const response = context ? await oauthRequests.run(Object.freeze(context), handle) : await handle();
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key === 'set-cookie' || key === 'content-length' || key === 'transfer-encoding') return;
        // A refused sign-in (the provider returned no refresh token, #311) comes back to the page with the reason.
        reply.header(key, key === 'location' && facts.refused ? `${value}${value.includes('?') ? '&' : '?'}sso_reason=${facts.refused}` : value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      const text = response.body ? await response.text() : null;
      return reply.send(text && response.headers.get('content-type')?.includes('application/json') ? redactSessionTokens(text) : text);
  };
  app.route({ method: ['GET', 'POST'], url: `${AUTH_BASE_PATH}/*`, handler: forward });
  for (const url of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server/api/auth',
    '/.well-known/openid-configuration/api/auth',
  ]) app.route({ method: ['GET', 'HEAD'], url, handler: forward });
}
