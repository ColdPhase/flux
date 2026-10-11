import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { isMcpRequest, isPublicAddress, parseConnectTarget } from './policy.js';

// The two listeners of `runtime-egress`. The proxy answers only CONNECT to an allowed host on 443 whose
// every resolved address is public, then relays bytes (TLS stays end to end). The MCP forwarder passes
// only `/mcp` to the API, with a fixed set of headers and a bounded body. Each parses nothing beyond
// Node's bounded HTTP head and the checks in policy.ts.

export type Resolve = (host: string) => Promise<string[]>;
export type Connect = (address: string, port: number) => Socket;
export type Log = (event: Record<string, unknown>) => void;

export const EGRESS_LIMITS = {
  headerBytes: 4096,
  mcpHeaderBytes: 16 * 1024,
  mcpBodyBytes: 1024 * 1024,
  tunnelIdleMs: 5 * 60_000,
  connectTimeoutMs: 10_000,
  connections: 256,
  /** Per source address. Each slot sits alone on its own network, so its address identifies it. */
  connectionsPerSource: 32,
} as const;

const defaultResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
const defaultConnect: Connect = (address, port) => netConnect({ host: address, port });

/** Closes a connection past the per-source cap before any byte is read; one busy slot cannot take all `connections`. */
export function capConnectionsPerSource(server: Server, limit: number = EGRESS_LIMITS.connectionsPerSource, log: Log = () => undefined): void {
  const open = new Map<string, number>();
  server.on('connection', (socket: Socket) => {
    const source = socket.remoteAddress ?? 'unknown';
    const count = (open.get(source) ?? 0) + 1;
    if (count > limit) { log({ event: 'refused', reason: 'source_limit' }); socket.destroy(); return; }
    open.set(source, count);
    socket.once('close', () => {
      const left = (open.get(source) ?? 1) - 1;
      if (left <= 0) open.delete(source); else open.set(source, left);
    });
  });
}

function refuse(socket: Duplex, status: 400 | 403 | 405 | 502, reason: string) {
  if (!socket.writable) { socket.destroy(); return; }
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

export function createProxyServer({ allow, resolve = defaultResolve, connect = defaultConnect, log = () => undefined }: {
  allow: ReadonlySet<string>; resolve?: Resolve; connect?: Connect; log?: Log;
}): Server {
  const server = createServer({ maxHeaderSize: EGRESS_LIMITS.headerBytes, requestTimeout: 10_000, headersTimeout: 10_000 }, (_req, res) => {
    // A plain HTTP proxy request (absolute-form GET) is never forwarded.
    res.writeHead(405, { connection: 'close', 'content-length': '0' });
    res.end();
  });
  server.maxConnections = EGRESS_LIMITS.connections;
  capConnectionsPerSource(server, EGRESS_LIMITS.connectionsPerSource, log);
  server.on('connect', async (req, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const target = parseConnectTarget(req.url);
    if (!target || !allow.has(target.host)) { log({ event: 'refused', reason: 'host' }); refuse(socket, 403, 'Forbidden'); return; }
    let addresses: string[];
    try { addresses = await resolve(target.host); } catch { refuse(socket, 502, 'Bad Gateway'); return; }
    // Every answer must be public: a vendor name that resolves into the LAN is refused, not filtered.
    if (!addresses.length || !addresses.every(isPublicAddress)) { log({ event: 'refused', reason: 'address', host: target.host }); refuse(socket, 403, 'Forbidden'); return; }
    const upstream = connect(addresses[0]!, target.port);
    const timer = setTimeout(() => { upstream.destroy(); refuse(socket, 502, 'Bad Gateway'); }, EGRESS_LIMITS.connectTimeoutMs);
    upstream.once('connect', () => {
      clearTimeout(timer);
      if (socket.destroyed) { upstream.destroy(); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      log({ event: 'tunnel', host: target.host });
    });
    upstream.setTimeout(EGRESS_LIMITS.tunnelIdleMs, () => { upstream.destroy(); socket.destroy(); });
    upstream.on('error', () => { clearTimeout(timer); if (!socket.destroyed) refuse(socket, 502, 'Bad Gateway'); });
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  server.on('clientError', (_error, socket) => refuse(socket, 400, 'Bad Request'));
  return server;
}

const FORWARDED_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'user-agent'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control'];

function pick(headers: IncomingHttpHeaders, names: string[]) {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value.length <= 8192) out[name] = value;
  }
  return out;
}

/** Forwards exactly `/mcp` to the API on `runtime-api`; every other request is a 404 from here. */
export function createMcpForwarder({ upstream, log = () => undefined }: { upstream: { host: string; port: number }; log?: Log }): Server {
  const server = createServer({ maxHeaderSize: EGRESS_LIMITS.mcpHeaderBytes, requestTimeout: 60_000, headersTimeout: 10_000 }, (req, res) => {
    if (!isMcpRequest(req.method, req.url)) {
      log({ event: 'refused', reason: 'path' });
      res.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"error":"not_found"}');
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && !(/^[0-9]{1,8}$/.test(declared) && Number(declared) <= EGRESS_LIMITS.mcpBodyBytes)) {
      res.writeHead(413, { connection: 'close' });
      res.end();
      req.destroy();
      return;
    }
    const forward = httpRequest({ host: upstream.host, port: upstream.port, method: req.method, path: '/mcp', agent: false,
      headers: { ...pick(req.headers, FORWARDED_REQUEST_HEADERS), ...(declared !== undefined ? { 'content-length': declared } : {}) } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, pick(answer.headers, FORWARDED_RESPONSE_HEADERS));
      answer.pipe(res);
    });
    forward.on('error', () => { if (!res.headersSent) { res.writeHead(502, { connection: 'close' }); } res.end(); });
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > EGRESS_LIMITS.mcpBodyBytes) { forward.destroy(); if (!res.headersSent) res.writeHead(413, { connection: 'close' }); res.end(); req.destroy(); return; }
      forward.write(chunk);
    });
    req.on('end', () => forward.end());
    req.on('error', () => forward.destroy());
    res.on('close', () => forward.destroy());
  });
  server.maxConnections = EGRESS_LIMITS.connections;
  capConnectionsPerSource(server, EGRESS_LIMITS.connectionsPerSource, log);
  // CONNECT on the MCP port is refused like any other non-/mcp request.
  server.on('connect', (_req, socket: Duplex) => { socket.on('error', () => socket.destroy()); refuse(socket, 405, 'Method Not Allowed'); });
  server.on('clientError', (_error, socket) => refuse(socket, 400, 'Bad Request'));
  return server;
}
