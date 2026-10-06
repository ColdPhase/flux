import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/**
 * No Flux page may be shown inside another site's frame (#287). The OAuth sign-in, connection
 * choice and consent pages are the reason: framed and overlaid, a person could be led to approve
 * an agent connection they cannot see. Flux itself frames nothing and the installed PWA is a
 * top-level window, so every response carries the policy. A route that sets its own
 * Content-Security-Policy (stored files send `sandbox`) keeps it; `X-Frame-Options: DENY` still
 * refuses framing there, including in browsers without `frame-ancestors`.
 */
export function useFramingProtection(app: FastifyInstance) {
  app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', FRAME_ANCESTORS_NONE);
    return payload;
  });
}
