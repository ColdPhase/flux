import type { FastifyRequest } from 'fastify';

/**
 * The API's request log line (F-030, #655): Fastify's default fields without the query string, so a search text or
 * any other query value is never written to the Docker log on disk. Request bodies are never logged.
 */
export function requestLogSerializer(request: FastifyRequest) {
  return {
    method: request.method,
    url: (request.url ?? '').split('?')[0],
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
