import http from 'node:http';
import net from 'node:net';
import { readJson } from './state.mjs';
import { publicOrigin } from './state.mjs';

export function authorizeBoundary(boundary, host, path, now = Date.now()) {
  if (!boundary || boundary.enabled !== true || !Number.isSafeInteger(boundary.expiresAt) || now >= boundary.expiresAt || typeof boundary.origin !== 'string') return 503;
  let origin; let pathname;
  try {
    origin = publicOrigin(boundary.origin, boundary.origin.startsWith('http:'));
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return 400;
    pathname = new URL(path, origin).pathname;
    // Fixture API identifiers are canonical ASCII; encoded path separators/route names are
    // refused so the fence cannot disagree with the application's router normalization.
    if (pathname.includes('%') || pathname.includes('//')) return 400;
  } catch { return 503; }
  if (host !== new URL(origin).host) return 421;
  // Registration is only performed privately through the normal account API before exposure.
  // This is a bounded two-person push fixture, with no provider/OAuth/upload/admin journeys.
  if (/^\/api\/(?:auth\/(?:sign-up|reset-password|request-password-reset|sign-in\/(?!email)|oauth|callback)|v1\/(?:sample|agent|integration|github|mcp))/.test(pathname) || /^\/(?:mcp|media)(?:\/|$)/.test(pathname) || /\/(?:files|uploads)(?:\/|$)/.test(pathname)) return 403;
  return 200;
}
export function startGateway(directory, port = 8080, target = { hostname: 'api', port: 8080 }) {
  let inFlight = 0; let requests = 0; let windowStart = Date.now();
  const sockets = new Set();
  const allowed = async request => {
    let boundary;
    try { boundary = await readJson(directory, 'boundary.json'); } catch { return 503; }
    const status = authorizeBoundary(boundary, request.headers.host, request.url);
    if (status !== 200) return status;
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 240 || inFlight >= 24 || sockets.size >= 64) return 429;
    const length = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(length) || length > 1_048_576 || length < 0) return 413;
    return 200;
  };
  const server = http.createServer(async (request, response) => {
    const status = await allowed(request);
    if (status !== 200) { response.writeHead(status, { 'cache-control': 'no-store', connection: 'close' }); response.end('Fixture boundary unavailable'); return; }
    inFlight++;
    let bytes = 0;
    const headers = { ...request.headers };
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip']) delete headers[name];
    const upstream = http.request({ ...target, method: request.method, path: request.url, headers, timeout: 15_000 }, reply => {
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
    });
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 1_048_576) { upstream.destroy(); response.destroy(); request.destroy(); } });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { inFlight--; upstream.destroy(); });
    request.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', async (request, client, head) => {
    const status = await allowed(request);
    if (status !== 200 || !/^\/api\/v1\/stream(?:\?|$)/.test(request.url)) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = net.connect(target.port, target.hostname);
    const timer = setTimeout(() => { client.destroy(); upstream.destroy(); }, 15_000);
    upstream.on('connect', () => {
      clearTimeout(timer);
      const headers = { ...request.headers };
      for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip']) delete headers[name];
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    const close = () => { clearTimeout(timer); client.destroy(); upstream.destroy(); };
    upstream.on('error', close); client.on('error', close); client.on('close', close); upstream.on('close', close);
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 64;
  const fence = setInterval(async () => {
    let boundary; try { boundary = await readJson(directory, 'boundary.json'); } catch { boundary = {}; }
    if (!boundary || authorizeBoundary(boundary, (() => { try { return new URL(boundary.origin).host; } catch { return ''; } })(), '/') !== 200) for (const socket of sockets) socket.destroy();
  }, 1000);
  server.on('close', () => clearInterval(fence));
  server.listen(port, '0.0.0.0');
  return server;
}
if (process.argv[1]?.endsWith('/gateway.mjs')) startGateway(process.env.MOBILE_STATE ?? '/state');
