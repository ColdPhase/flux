import type { FastifyRequest } from 'fastify';

/**
 * Link tokens that sit in the URL path (#1030): Better Auth's reset link, `GET /api/auth/reset-password/<token>`, works once for an
 * hour. Every other link Flux mails or shows (email verification, a notification address, unsubscribe, an invite) carries its token
 * in the query or the fragment, which are not logged. Matched anywhere in the path so `//` and `./` variants are covered too.
 */
const TOKEN_IN_PATH = /(\/reset-password\/)[^/]+/gi;

/**
 * The request path without its query string, and without the token of a link that holds one in the path. The path is cut where the router
 * cuts it, at the first `?` or `#`: Fastify reads what follows either as the query string, so a client that writes its values after a `#`
 * would otherwise have them logged (#1047). Then the token is hidden.
 */
export function loggedPath(url: string | undefined) {
  return (url ?? '').split(/[?#]/, 1)[0]!.replace(TOKEN_IN_PATH, '$1<token>');
}

/**
 * The API's request log line (F-030, #655): Fastify's default fields without the query string, so a search text or
 * any other query value is never written to the Docker log on disk, and with a link token in the path as `<token>`
 * (#1030). Request bodies are never logged.
 */
export function requestLogSerializer(request: FastifyRequest) {
  return {
    method: request.method,
    url: loggedPath(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * The id a request is logged under. A caller's `X-Request-ID` is used when it is a short plain identifier (a proxy's id, or a
 * measurement's own, #827), so a log line can be matched to the request that caused it even though its query string is not logged.
 * Anything else, and a request without one, gets the usual `req-<counter>`.
 */
export function createRequestIdGenerator() {
  let counter = 0;
  return (request: { headers: Record<string, string | string[] | undefined> }) => {
    const sent = request.headers['x-request-id'];
    return typeof sent === 'string' && SAFE_REQUEST_ID.test(sent) ? sent : `req-${(++counter).toString(36)}`;
  };
}

/** Secret body fields, redacted should any log line ever carry a request body. */
export const SECRET_LOG_PATHS = ['req.body.password', 'req.body.newPassword', 'req.body.currentPassword', 'req.body.recoveryCode'];
