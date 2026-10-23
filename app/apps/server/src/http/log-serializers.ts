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

/** Secret body fields, redacted should any log line ever carry a request body. */
export const SECRET_LOG_PATHS = ['req.body.password', 'req.body.newPassword', 'req.body.currentPassword', 'req.body.recoveryCode'];
