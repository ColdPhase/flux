import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { endpointRefusal, guardedFetch, PUBLIC_ONLY, type AiEndpointPolicy, type PersonalKeyResolver } from '@flux/agent-runtime';
import { usageMeter, type GatewayClaim, type GatewayTicket, type ModelGateway } from '@flux/core';
import type { AiProviderKind } from '@flux/contracts';
import {
  MODEL_GATEWAY_LIMITS, MODEL_GATEWAY_UPSTREAMS, modelGatewayError, modelGatewayToken, parseModelGatewayUrl, type ModelGatewayErrorCode, type ModelGatewayRoute,
} from '@flux/runtime-protocol';

// The worker's side of the model gateway (#1441, docs/product/ai-modes.md "The model gateway"; CA-4). It listens only on the internal
// network runtime-egress passes model requests on over. For each request: the route and the token (`@flux/runtime-protocol`), the
// body within its bound, then `gateway.open` (the run, the request, the money held), and only then the key, opened for this one
// request and put only into the provider's own header of the request sent to the connection's own address through the same guarded
// transport as every provider adapter. The answer is passed back as it arrives while its usage is read, and charged at its end. An
// error answer is passed back with the key, and anything shaped like a key, taken out. Nothing logged carries a token, a key or a body.

export type Log = (event: Record<string, unknown>) => void;

export interface ModelGatewayServerOptions {
  gateway: ModelGateway;
  resolveKey: PersonalKeyResolver;
  policy?: AiEndpointPolicy;
  /** TEST ONLY: a named provider's root replaced by a mock (as `providerPersonalCompute`'s `baseUrls`). */
  upstreams?: Partial<Record<AiProviderKind, string>>;
  limits?: Partial<typeof MODEL_GATEWAY_LIMITS>;
  log?: Log;
}

/** The `anthropic-beta` values that change no price and no tool: anything else is not sent. */
const ANTHROPIC_BETA = /^(interleaved-thinking|fine-grained-tool-streaming|token-efficient-tools)-\d{4}-\d{2}-\d{2}$/;
const ANTHROPIC_VERSION = /^\d{4}-\d{2}-\d{2}$/;
/** Key-shaped strings in an error answer: Anthropic's, OpenAI's (also as OpenAI masks them), OpenRouter's and Google's. */
const KEY_SHAPED = /(sk-[A-Za-z0-9_*-]{6,}|AIza[0-9A-Za-z_-]{20,})/g;

function send(res: ServerResponse, error: { status: number; headers: Record<string, string>; body: string }) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status, error.headers);
  res.end(error.body);
}
const refuse = (res: ServerResponse, status: number, code: ModelGatewayErrorCode, message: string) => send(res, modelGatewayError(status, code, message));

/**
 * The body, up to `limit` bytes; `too_large` past it. A body a little past the bound is read to its end unkept, so the refusal reaches
 * the sender; one far past it is cut.
 */
async function readBody(req: IncomingMessage, limit: number, keep: (bytes: number) => boolean): Promise<Buffer | 'too_large' | 'busy'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * limit) return 'too_large';
    if (size <= limit) {
      if (!keep((chunk as Buffer).length)) return 'busy';
      chunks.push(chunk as Buffer);
    }
  }
  return size > limit ? 'too_large' : Buffer.concat(chunks);
}

/** Where a request goes: the connection's own address (a named provider's fixed root, or the owner's base URL) and the route's path. */
function upstreamUrl(route: ModelGatewayRoute, ticket: GatewayTicket, upstreams: Partial<Record<AiProviderKind, string>>): string | null {
  if (route.provider === 'openai_compatible') {
    const base = ticket.connection.baseUrl;
    return base ? `${base.replace(/\/+$/, '')}${route.path}` : null;
  }
  return `${(upstreams[route.provider] ?? MODEL_GATEWAY_UPSTREAMS[route.provider]).replace(/\/+$/, '')}${route.path}`;
}

/** The headers sent to the provider: the key in the provider's own header, and only what changes no price or tool. */
function upstreamHeaders(route: ModelGatewayRoute, req: IncomingMessage, key: string): Record<string, string> {
  const accept = req.headers.accept;
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'user-agent': 'Flux-model-gateway',
    accept: typeof accept === 'string' && /^(text\/event-stream|application\/json)$/.test(accept) ? accept : 'application/json',
  };
  if (route.operation === 'anthropic_messages') {
    headers['x-api-key'] = key;
    const version = req.headers['anthropic-version'];
    headers['anthropic-version'] = typeof version === 'string' && ANTHROPIC_VERSION.test(version) ? version : '2023-06-01';
    const betas = String(req.headers['anthropic-beta'] ?? '').split(',').map((beta) => beta.trim()).filter((beta) => ANTHROPIC_BETA.test(beta));
    if (betas.length) headers['anthropic-beta'] = betas.join(',');
  } else if (route.operation === 'gemini_generate') headers['x-goog-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  return headers;
}

const RESPONSE_HEADERS = ['content-type', 'retry-after', 'request-id', 'x-request-id'];

export function createModelGatewayServer({ gateway, resolveKey, policy = PUBLIC_ONLY, upstreams = {}, limits: given = {}, log = () => undefined }: ModelGatewayServerOptions): Server {
  const limits = { ...MODEL_GATEWAY_LIMITS, ...given };
  const transport = guardedFetch(policy, { timeoutMs: limits.requestMs, maxResponseBytes: limits.responseBytes });
  /** Bytes of request bodies held in memory by every request in flight, and by each run's. */
  let bodiesInFlight = 0;
  const runBodies = new Map<string, number>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const route = parseModelGatewayUrl(req.url);
    if (req.method !== 'POST') { refuse(res, 405, 'flux_method_not_allowed', 'Only POST'); return; }
    if (!route) { refuse(res, 404, 'flux_not_found', 'There is no such model request'); return; }
    const token = modelGatewayToken(req.headers);
    if (!token || token === 'invalid') { refuse(res, 401, 'flux_token_invalid', 'This gateway token is not valid: unknown, expired or closed'); return; }
    const declared = req.headers['content-length'];
    if (declared !== undefined && !(/^[0-9]{1,9}$/.test(declared) && Number(declared) <= limits.requestBytes)) {
      req.resume();
      refuse(res, 413, 'flux_request_too_large', 'The request is too large');
      return;
    }
    // The run's place is taken before the body is read: an unknown token or a run with all its places taken costs no body in memory.
    const claimed = await gateway.claim(token);
    if (!claimed.ok) {
      req.resume();
      log({ event: 'model', provider: route.provider, operation: route.operation, status: claimed.refusal.status, refused: claimed.refusal.code });
      refuse(res, claimed.refusal.status, claimed.refusal.code, claimed.refusal.message);
      return;
    }
    // The bodies of every run's requests in flight share one bound in the worker's memory (its other jobs run in the same 512 MiB), and
    // one run may hold only part of it: a request past either is told to wait and send again. A body counts until it has been sent to the
    // provider (the answer's headers came back), not while the answer streams (security review of #1444, P3-3).
    const runId = claimed.claim.runId;
    let kept = 0;
    const release = () => {
      if (!kept) return;
      bodiesInFlight -= kept;
      const left = (runBodies.get(runId) ?? 0) - kept;
      if (left > 0) runBodies.set(runId, left); else runBodies.delete(runId);
      kept = 0;
    };
    try {
      await relay(req, res, route, claimed.claim, (bytes) => {
        const run = runBodies.get(runId) ?? 0;
        if (bodiesInFlight + bytes > limits.bodiesInFlightBytes || run + bytes > limits.bodiesInFlightPerRunBytes) return false;
        bodiesInFlight += bytes; kept += bytes;
        runBodies.set(runId, run + bytes);
        return true;
      }, release);
    } finally {
      release();
    }
  }

  async function relay(req: IncomingMessage, res: ServerResponse, route: ModelGatewayRoute, claim: GatewayClaim, keep: (bytes: number) => boolean,
    sent: () => void) {
    let raw: Buffer | 'too_large' | 'busy';
    try {
      raw = await readBody(req, limits.requestBytes, keep);
    } catch (error) {
      gateway.unclaim(claim);
      throw error;
    }
    if (raw === 'too_large') { gateway.unclaim(claim); refuse(res, 413, 'flux_request_too_large', 'The request is too large'); return; }
    if (raw === 'busy') {
      gateway.unclaim(claim);
      req.resume();
      log({ event: 'model', provider: route.provider, operation: route.operation, status: 429, refused: 'flux_gateway_busy' });
      const busy = modelGatewayError(429, 'flux_run_busy', 'The model gateway is busy; send the request again shortly');
      send(res, { ...busy, headers: { ...busy.headers, 'x-should-retry': 'true', 'retry-after': '2' } });
      return;
    }

    const opened = await gateway.open(claim, { provider: route.provider, operation: route.operation, pathModel: route.model, pathStream: route.stream }, raw);
    if (!opened.ok) {
      log({ event: 'model', provider: route.provider, operation: route.operation, status: opened.refusal.status, refused: opened.refusal.code });
      refuse(res, opened.refusal.status, opened.refusal.code, opened.refusal.message);
      return;
    }
    const ticket = opened.ticket;
    const done = (status: number, charge: { micros: number; known: boolean }) =>
      log({ event: 'model', run: ticket.runId, provider: route.provider, operation: route.operation, status, chargedMicros: charge.micros, known: charge.known });
    const url = upstreamUrl(route, ticket, upstreams);
    const key = url ? await resolveKey(ticket.connection.keyRef).catch(() => null) : null;
    if (!url || !key) {
      done(403, await gateway.release(ticket));
      refuse(res, 403, 'flux_run_ended', "This run's key cannot be used now; stop");
      return;
    }

    const controller = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    // The idle clock runs only while bytes can arrive: a whole (not streamed) answer comes in one piece at its end, after up to the
    // request's own clock (a long answer takes minutes), so only the request clock bounds it.
    const quiet = () => {
      if (!ticket.request.stream) return;
      clearTimeout(idle); idle = setTimeout(() => controller.abort(), limits.idleMs); idle.unref();
    };
    // The harness went away: the provider's answer is not read to its end, so its cost is not known.
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    let answer: Response;
    try {
      quiet();
      // The admitted body itself, not a copy (the transport sends a Buffer as it is).
      answer = await transport(url, { method: 'POST', headers: upstreamHeaders(route, req, key), body: ticket.request.body as unknown as Uint8Array<ArrayBuffer>, signal: controller.signal });
      sent();
    } catch (error) {
      clearTimeout(idle);
      // Sent, or perhaps sent: what it may have cost stays charged. Refused before a byte left (the address guard): nothing.
      const charge = await gateway.settle(ticket, endpointRefusal(error) ? 'not_billed' : null);
      done(502, charge);
      refuse(res, 502, 'flux_provider_unreachable', 'The provider could not be reached or did not answer in time');
      return;
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    for (const name of RESPONSE_HEADERS) { const value = answer.headers.get(name); if (value && value.length <= 512) headers[name] = value; }

    if (answer.status < 200 || answer.status >= 300) {
      clearTimeout(idle);
      // A whole error answer of the provider was not billed (CA-3). It is passed back without the key or anything shaped like one.
      const text = (await answer.text().catch(() => '')).slice(0, limits.errorBodyBytes).split(key).join('[key]').replace(KEY_SHAPED, '[key]');
      const charge = await gateway.settle(ticket, 'not_billed');
      done(answer.status, charge);
      // A redirect is never followed or passed on; the provider's own retry advice stands, with Flux's refusal shape kept apart.
      const status = answer.status >= 300 && answer.status < 400 ? 502 : answer.status;
      if (!res.headersSent) { res.writeHead(status, { ...headers, 'content-length': String(Buffer.byteLength(text)) }); res.end(text); }
      return;
    }

    const meter = usageMeter(route.operation, route.provider, ticket.request.stream, limits.responseBytes);
    res.writeHead(answer.status, headers);
    let complete = false;
    try {
      const reader = answer.body?.getReader();
      if (reader) {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          quiet();
          meter.push(value);
          if (!res.write(value)) {
            await new Promise<void>((resume) => {
              const go = () => { res.off('drain', go); res.off('close', go); resume(); };
              res.on('drain', go); res.on('close', go);
            });
          }
          if (res.destroyed) throw new Error('The harness went away');
        }
      }
      complete = true;
    } catch {
      // Broken, cut at its bound, idle too long, or the harness went away: no usable usage.
    } finally {
      clearTimeout(idle);
    }
    const charge = await gateway.settle(ticket, complete ? meter.end() : null);
    done(answer.status, charge);
    if (complete) res.end(); else res.destroy();
  }

  const server = createServer({ maxHeaderSize: limits.headerBytes, requestTimeout: 60_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) refuse(res, 502, 'flux_provider_unreachable', 'The gateway failed'); else res.destroy(); });
  });
  // A request answered by a long stream is not cut by Node's own socket timeout: the gateway's clocks bound it.
  server.timeout = 0;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); else socket.destroy(); });
  return server;
}
