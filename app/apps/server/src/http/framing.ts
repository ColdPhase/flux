import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";
/**
 * What a Flux page may ask the browser for (#838, ZAP 10063): the calls use the camera, microphone and screen of the page's own origin;
 * nothing here uses location, payment or any device bus, so no page, and no frame in it, may ask for them.
 */
export const PERMISSIONS_POLICY = 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), '
  + 'midi=(), accelerometer=(), gyroscope=(), magnetometer=()';

/**
 * No Flux page may be shown inside another site's frame (#287). The OAuth sign-in, connection
 * choice and consent pages are the reason: framed and overlaid, a person could be led to approve
 * an agent connection they cannot see. Flux itself frames nothing and the installed PWA is a
 * top-level window, so every response carries the policy. A route that sets its own
 * Content-Security-Policy (stored files send `sandbox`) keeps it; `X-Frame-Options: DENY` still
 * refuses framing there, including in browsers without `frame-ancestors`. The one framed response is a
 * file preview (C-58, #1252), which sets `frame-ancestors 'self'` and `SAMEORIGIN` itself.
 *
 * The same hook sets the other headers every response should carry (#838): no MIME sniffing (a script is a script only when it says
 * so), a Permissions-Policy, and Cross-Origin-Resource-Policy `same-origin` (Flux's responses, its API's and its files included,
 * are for pages of its own origin, never for another site's tags). A route that sets its own value keeps it.
 */
export function useFramingProtection(app: FastifyInstance) {
  app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    // Only a file preview (C-58) sets its own: SAMEORIGIN, so that a Flux page alone can frame it.
    if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', FRAME_ANCESTORS_NONE);
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('permissions-policy')) reply.header('permissions-policy', PERMISSIONS_POLICY);
    if (!reply.hasHeader('cross-origin-resource-policy')) reply.header('cross-origin-resource-policy', 'same-origin');
    return payload;
  });
}
