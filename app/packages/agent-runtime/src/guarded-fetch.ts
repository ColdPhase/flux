import http from 'node:http';
import https from 'node:https';
import { EndpointRefusedError, guardedLookup, literalRefusal, systemResolver, type AiEndpointPolicy, type Resolver } from './endpoint-policy.js';

// The one HTTP transport of every provider adapter (F-020 PROV-4): a `fetch` that connects only to
// addresses the endpoint policy allows (checked by the socket's own lookup), never follows a
// redirect (a 3xx is returned as it is, and the adapters treat it as a failure), and bounds the
// response in time and size. It is used for the Anthropic SDK (through its `fetch` option) and the
// Chat Completions adapter alike, so no adapter has a looser path than another.

export interface TransportLimits {
  /** Whole request, from connect to the last byte. */
  timeoutMs: number;
  maxResponseBytes: number;
}

export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = { timeoutMs: 120_000, maxResponseBytes: 1_000_000 };

/** The response body exceeded the transport bound; the connection was dropped. */
export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`The provider response exceeded ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

export type GuardedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, name) => { result[name] = value; });
  return result;
}

async function bodyBuffer(body: RequestInit['body']): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // A Buffer is sent as it is: a large request body is not copied again (the model gateway's, #1441).
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body as ArrayBuffer);
  return Buffer.from(await new Response(body).arrayBuffer());
}

export function guardedFetch(policy: AiEndpointPolicy, limits: TransportLimits = DEFAULT_TRANSPORT_LIMITS, resolve: Resolver = systemResolver): GuardedFetch {
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    const signal = init.signal ?? request?.signal ?? undefined;
    signal?.throwIfAborted();
    const refused = literalRefusal(url, policy);
    if (refused) throw new EndpointRefusedError(refused);
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = headerRecord(init.headers ?? request?.headers);
    // The body is read as it arrives and bounded by its size, so it is never compressed.
    headers['accept-encoding'] = 'identity';
    const body =await bodyBuffer(init.body ?? (request && method !== 'GET' && method !== 'HEAD' ? await request.arrayBuffer() : undefined));
    if (body) headers['content-length'] = String(body.length);

    return new Promise<Response>((resolvePromise, reject) => {
      let settled = false;
      /** A streamed body still open after the response was handed over: it ends with the same bounds (#1248). */
      let streaming: ReadableStreamDefaultController<Uint8Array> | null = null;
      const release = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error: unknown, response?: Response) => {
        if (settled) {
          // After the response was handed over only its streamed body can still fail: the bound, an abort or the clock.
          if (error && streaming) { const body = streaming; streaming = null; release(); try { body.error(error); } catch { /* already closed */ } }
          return;
        }
        settled = true;
        if (error || !streaming) release();
        if (error) reject(error); else resolvePromise(response!);
      };
      const transport = url.protocol === 'https:' ? https : http;
      const outgoing = transport.request(url, {
        method, headers, agent: false,
        lookup: guardedLookup(policy, url.protocol === 'http:', resolve),
      }, (incoming) => {
        const status = incoming.statusCode ?? 0;
        const declared = Number(incoming.headers['content-length']);
        if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
          incoming.destroy();
          return finish(new ResponseTooLargeError(limits.maxResponseBytes));
        }
        const responseHeaders = () => {
          const result = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) result.append(name, item);
          }
          return result;
        };
        let size = 0;
        // A successful event stream (#1248: the answer as it is written) is handed over at once and read as it arrives, under the same
        // size bound and clock as any body; every other answer is read whole first.
        if (status >= 200 && status < 300 && method !== 'HEAD' && /^text\/event-stream\b/i.test(String(incoming.headers['content-type'] ?? ''))) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) { streaming = controller; },
            cancel() { streaming = null; release(); incoming.destroy(); outgoing.destroy(); },
          });
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limits.maxResponseBytes) {
              incoming.destroy();
              finish(new ResponseTooLargeError(limits.maxResponseBytes));
              return;
            }
            streaming?.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          });
          incoming.on('error', (error) => finish(error));
          incoming.on('end', () => {
            const done = streaming;
            streaming = null;
            release();
            try { done?.close(); } catch { /* already errored */ }
          });
          finish(null, new Response(body, { status, statusText: incoming.statusMessage ?? '', headers: responseHeaders() }));
          return;
        }
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limits.maxResponseBytes) {
            incoming.destroy();
            finish(new ResponseTooLargeError(limits.maxResponseBytes));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', (error) => finish(error));
        incoming.on('end', () => {
          if (status < 200 || status > 599) return finish(new Error(`The provider answered with HTTP status ${status}`));
          const noBody = status === 204 || status === 205 || status === 304 || method === 'HEAD';
          finish(null, new Response(noBody ? null : Buffer.concat(chunks), { status, statusText: incoming.statusMessage ?? '', headers: responseHeaders() }));
        });
      });
      const onAbort = () => {
        outgoing.destroy();
        finish(new DOMException('The request was aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        outgoing.destroy();
        finish(new DOMException(`The request timed out after ${limits.timeoutMs} ms`, 'TimeoutError'));
      }, limits.timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      outgoing.on('error', (error) => finish(error));
      if (body) outgoing.write(body);
      outgoing.end();
    });
  };
}

/** The refusal behind an error, when the guard refused the endpoint (directly or as a `cause`). */
export function endpointRefusal(error: unknown): EndpointRefusedError | null {
  for (let current: unknown = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth++) {
    if (current instanceof EndpointRefusedError) return current;
  }
  return null;
}
