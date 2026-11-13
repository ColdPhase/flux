import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  MODEL_GATEWAY_LIMITS, MODEL_GATEWAY_REQUEST_HEADERS, MODEL_GATEWAY_RESPONSE_HEADERS, modelGatewayError, parseModelGatewayUrl, type ModelGatewayErrorCode,
} from '@flux/runtime-protocol';
import { capConnectionsPerSource, EGRESS_LIMITS, type Log } from './server.js';

// runtime-egress's model port (#1441, docs/product/ai-modes.md "The model gateway"). A harness in the runtime sends its provider's
// model requests here with its run's gateway token; this listener passes exactly the providers' model paths on to the worker's
// gateway, with a fixed set of headers and a bounded body, and passes the answer back as it arrives. It holds no key, reads no
// database and reaches no provider: the worker checks the token and the request again, and alone opens the key.

export interface ModelForwarderOptions {
  upstream: { host: string; port: number };
  log?: Log;
  limits?: Partial<Pick<typeof MODEL_GATEWAY_LIMITS, 'requestBytes' | 'requestMs' | 'headerBytes'>>;
}

function pick(headers: IncomingHttpHeaders, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value.length <= 8192) out[name] = value;
  }
  return out;
}

const refusal = (status: number, code: ModelGatewayErrorCode, message: string) => modelGatewayError(status, code, message);

function refuseRaw(socket: Duplex, status: 400 | 405, reason: string) {
  if (!socket.writable) { socket.destroy(); return; }
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** Passes exactly the providers' model paths (POST) on to the worker's gateway; everything else is answered here. */
export function createModelForwarder({ upstream, log = () => undefined, limits: given = {} }: ModelForwarderOptions): Server {
  const limits = { requestBytes: MODEL_GATEWAY_LIMITS.requestBytes, requestMs: MODEL_GATEWAY_LIMITS.requestMs, headerBytes: MODEL_GATEWAY_LIMITS.headerBytes, ...given };
  const server = createServer({ maxHeaderSize: limits.headerBytes, requestTimeout: 60_000, headersTimeout: 10_000 }, (req, res) => {
    const answer = (error: ReturnType<typeof refusal>) => { res.writeHead(error.status, { ...error.headers, connection: 'close' }); res.end(error.body); };
    const route = parseModelGatewayUrl(req.url);
    if (req.method !== 'POST') { log({ event: 'refused', reason: 'model_method' }); answer(refusal(405, 'flux_method_not_allowed', 'Only POST')); return; }
    if (!route) { log({ event: 'refused', reason: 'model_path' }); answer(refusal(404, 'flux_not_found', 'There is no such model request')); return; }
    const declared = req.headers['content-length'];
    if (declared !== undefined && !(/^[0-9]{1,9}$/.test(declared) && Number(declared) <= limits.requestBytes)) {
      answer(refusal(413, 'flux_request_too_large', 'The request is too large'));
      req.resume();
      return;
    }
    const forward = httpRequest({ host: upstream.host, port: upstream.port, method: 'POST', path: req.url, agent: false,
      headers: { ...pick(req.headers, MODEL_GATEWAY_REQUEST_HEADERS), ...(declared !== undefined ? { 'content-length': declared } : {}) } }, (back) => {
      res.writeHead(back.statusCode ?? 502, pick(back.headers, MODEL_GATEWAY_RESPONSE_HEADERS));
      back.pipe(res);
      back.on('error', () => res.destroy());
    });
    // The worker bounds a request's own clocks; this one only keeps a stuck exchange from holding a connection for ever.
    const timer = setTimeout(() => { forward.destroy(); res.destroy(); }, limits.requestMs + 30_000);
    timer.unref();
    res.on('close', () => { clearTimeout(timer); forward.destroy(); });
    forward.on('error', () => { if (!res.headersSent) answer(refusal(502, 'flux_provider_unreachable', 'The model gateway could not be reached')); else res.destroy(); });
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.requestBytes) {
        forward.destroy();
        if (!res.headersSent) answer(refusal(413, 'flux_request_too_large', 'The request is too large'));
        req.destroy();
        return;
      }
      if (!forward.write(chunk)) { req.pause(); forward.once('drain', () => req.resume()); }
    });
    req.on('end', () => forward.end());
    req.on('error', () => forward.destroy());
    log({ event: 'model', provider: route.provider, operation: route.operation });
  });
  server.timeout = 0;
  server.maxConnections = EGRESS_LIMITS.connections;
  capConnectionsPerSource(server, EGRESS_LIMITS.connectionsPerSource, log);
  server.on('connect', (_req, socket: Duplex) => { socket.on('error', () => socket.destroy()); refuseRaw(socket, 405, 'Method Not Allowed'); });
  server.on('clientError', (_error, socket) => refuseRaw(socket, 400, 'Bad Request'));
  return server;
}
