import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { toWebRequest } from '@modelcontextprotocol/node';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '@flux/core';

/**
 * Request-owned delivery fence (#316 AC-3). `check` runs inside a short database transaction that holds the
 * shared policy/connection/access locks; the real synchronous `res.write` happens inside that transaction, so an
 * owner's PATCH (exclusive on the same policy row, from any API instance) is ordered strictly before or after a
 * chunk is handed to the transport. Locks are released before any wait for drain or for the next chunk.
 */
export interface McpDeliveryFence { check(tx: Transaction): Promise<void> }

const HEADER = 'x-flux-mcp-delivery';
const fences = new Map<string, McpDeliveryFence>();

/** Marks a protected verified response so the relay (and nothing else) fences its bytes. */
export function fenceResponse(response: Response, fence: McpDeliveryFence): Response {
  const token = randomUUID(); fences.set(token, fence);
  const headers = new Headers(response.headers); headers.set(HEADER, token);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const unavailable = JSON.stringify({ error: 'Agent connection is unavailable' });

/**
 * Converts the Node request, calls the handler and writes the answer. Responses without a fence (the OAuth
 * challenge) are written unchanged. Fenced responses are written only while the live authority still holds.
 * `testGate` (fixture token + failure injection only) lets a test hold a request exactly before the fence.
 */
export function createMcpRelay(db: Database, options: { onerror(error: Error): void; testGate: boolean }) {
  return async (req: IncomingMessage, res: ServerResponse, parsedBody: unknown, handle: (request: Request) => Promise<Response>) => {
    let finished = false; const abort = new AbortController();
    res.on('close', () => { if (!finished) abort.abort(); });
    let response: Response; let token: string | null = null;
    try {
      const raw = await handle(await toWebRequest(req, parsedBody, { signal: abort.signal }));
      token = raw.headers.get(HEADER);
      if (token) { const headers = new Headers(raw.headers); headers.delete(HEADER);
        response = new Response(raw.body, { status: raw.status, statusText: raw.statusText, headers }); } else response = raw;
    } catch (error) {
      options.onerror(error instanceof Error ? error : new Error(String(error)));
      response = Response.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, { status: 500 });
    }
    const fence = token ? fences.get(token) ?? null : null;
    if (token) fences.delete(token);
    const gate = options.testGate && fence ? String(req.headers['x-flux-test-delivery-gate'] ?? '') : '';
    let handedOver = false;
    /** Run `action` (a synchronous write) only if the fence still passes inside one transaction. */
    const deliver = async (action: () => void): Promise<boolean> => {
      if (!fence) { action(); handedOver = true; return true; }
      if (gate) await db.transaction(async (tx) => { await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext(${gate}))`); });
      try {
        await db.transaction(async (tx) => { await fence.check(tx); action(); handedOver = true; });
        return true;
      } catch { return false; }
    };
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers) headers[name] = value;
    const refuse = () => {
      if (!handedOver && !res.headersSent) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(unavailable); }
      else res.destroy();
      finished = true;
    };
    if (response.body === null) {
      if (!await deliver(() => { res.writeHead(response.status, headers); res.end(); })) return refuse();
      finished = true; return;
    }
    const reader = response.body.getReader();
    const closed = new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
    let drainResolve: (() => void) | undefined;
    res.on('drain', () => { drainResolve?.(); drainResolve = undefined; });
    try {
      while (!abort.signal.aborted) {
        // Produce the next frame outside every database lock.
        const next = await Promise.race([reader.read(), closed.then(() => null)]);
        if (!next || next.done) break;
        // The drain waiter is registered inside the synchronous write, before `deliver` awaits its
        // transaction. A drain emitted during that await would otherwise be lost and the stream would hang (#316).
        const pending: { drained?: Promise<void> } = {};
        const ok = await deliver(() => {
          if (!res.headersSent) res.writeHead(response.status, headers);
          if (res.write(next.value) === false) pending.drained = new Promise<void>((resolve) => { drainResolve = resolve; });
        });
        if (!ok) { void reader.cancel().catch(() => undefined); return refuse(); }
        if (pending.drained) await Promise.race([pending.drained, closed]);
      }
    } catch { /* a failed stream ends the response */ }
    if (!res.headersSent && !handedOver) {
      // An empty stream: headers are protected output too.
      if (!await deliver(() => { res.writeHead(response.status, headers); })) return refuse();
    }
    finished = true;
    void reader.cancel().catch(() => undefined);
    res.end();
  };
}
