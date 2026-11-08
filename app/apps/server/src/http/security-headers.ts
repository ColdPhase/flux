import type { FastifyInstance } from 'fastify';

export const HSTS = 'max-age=31536000';

/**
 * Headers every response carries as defence in depth (#992; OWASP ASVS 4.0.3 V14.4.4 to V14.4.6, V8.2.1, V9.1.1). The framing refusal is
 * `framing.ts`, and the script policy is its own work (#979). A route that sets one of these itself keeps its value.
 *
 * - `X-Content-Type-Options: nosniff`: a browser never guesses a type other than the one sent.
 * - `Referrer-Policy: same-origin`: a link out of Flux sends no Referer, and Flux's own requests send theirs.
 * - `Cache-Control: no-store` on `/api/`: what people wrote or the server answered about them is not kept by the browser or a proxy. Static
 *   assets keep their own cache headers.
 * - `Strict-Transport-Security` when the public origin is https (a server requires it): the browser then refuses http for a year.
 */
export function useSecurityHeaders(app: FastifyInstance, options: { hsts: boolean }) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'same-origin');
    if (options.hsts && !reply.hasHeader('strict-transport-security')) reply.header('strict-transport-security', HSTS);
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
