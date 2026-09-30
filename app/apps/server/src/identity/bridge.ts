import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH_BASE_PATH, type ApiError, type IdentityCapabilities } from '@flux/contracts';
import { CLIENT_IP_HEADER, type FluxAuth } from './auth.js';

// Forwarding headers are dropped before Better Auth sees a request. Client addresses come
// from Fastify's request.ip, which honours only the configured trusted proxies.
const UNTRUSTED_FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'x-client-ip', 'cf-connecting-ip', 'true-client-ip', CLIENT_IP_HEADER];
const PASSWORD_RESET_REQUEST_PATHS = new Set([`${AUTH_BASE_PATH}/request-password-reset`, `${AUTH_BASE_PATH}/forget-password`]);

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
}

/** Forwards auth endpoints and the exact OAuth discovery paths to Better Auth. */
export function registerAuthBridge(app: FastifyInstance, { auth, publicOrigin, passwordReset }: AuthBridgeOptions) {
  // OAuth token and revocation endpoints use HTML form encoding. Preserve the
  // bounded raw payload so Better Auth validates it, rather than Fastify's 415.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  const forward = async (request: FastifyRequest, reply: FastifyReply) => {
      // Build the URL from the configured origin, never from Host or an absolute-form target.
      const target = new URL(request.url, publicOrigin);
      const url = new URL(`${target.pathname}${target.search}`, publicOrigin);
      if (passwordReset === 'unavailable' && PASSWORD_RESET_REQUEST_PATHS.has(url.pathname)) {
        return reply.code(503).send({ error: 'Password reset is unavailable', code: 'PASSWORD_RESET_UNAVAILABLE' } satisfies ApiError);
      }
      const headers = fromNodeHeaders(request.headers);
      for (const name of UNTRUSTED_FORWARDING_HEADERS) headers.delete(name);
      headers.set(CLIENT_IP_HEADER, request.ip);
      const body = request.body === undefined || request.body === null ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      const response = await auth.handler(new Request(url, { method: request.method, headers, body }));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie' && key !== 'content-length' && key !== 'transfer-encoding') reply.header(key, value);
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
