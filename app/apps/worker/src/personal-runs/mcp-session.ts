import type { PersonalRunTokenIssuer, PersonalTool, PersonalToolHost, PersonalToolSession } from '@flux/core';

// The worker as an MCP client of the API's `/mcp` route with a run's token (F-027 AST-8, A6 with A2, #484).
// The owner's switches, the result bounds, the place and the change log stay in the route: the worker only
// lists the run's tools and forwards the model's calls. A refused call is an error result, never an
// exception; `close` ends the token. Stateless HTTP on MCP 2026-07-28: no session, one request per call.

const PROTOCOL = '2026-07-28';
const CALL_TIMEOUT_MS = 60_000;
const REFUSED = 'Flux refused this call: the run has ended, or this tool or project is not allowed now. Nothing was run.';

interface RpcAnswer { status: number; result?: Record<string, unknown>; error?: { message?: unknown } }

async function rpc(url: string, token: string, id: number, method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<RpcAnswer> {
  const name = typeof params.name === 'string' ? params.name : null;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': PROTOCOL,
      'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL,
      'io.modelcontextprotocol/clientInfo': { name: 'flux-worker', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: { result?: Record<string, unknown>; error?: { message?: unknown } } = {};
  try {
    const raw = response.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '' : text;
    if (raw) body = JSON.parse(raw) as typeof body;
  } catch { /* not JSON: a refusal or a failure below */ }
  return { status: response.status, ...body };
}

const textOf = (content: unknown) => (Array.isArray(content) ? content : [])
  .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '[non-text content]'))
  .join('\n');

/**
 * The tool schema as the model sees it, without what costs tokens and tells it nothing (#484): the draft
 * `$schema` URL, the regular expression that zod writes beside every `format: "uuid"` or `"date-time"` (the
 * format already says it; `/mcp` still validates the value), the safe-integer or 32-bit range of an unbounded
 * integer and `additionalProperties: false` (A3: change tools travel with every request too). Every other keyword (types, ranges, defaults, enums, required, descriptions) is kept.
 */
export function compactToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactToolSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const node = schema as Record<string, unknown>;
  const redundantPattern = typeof node.format === 'string' && ['uuid', 'date-time'].includes(node.format);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || (key === 'pattern' && redundantPattern)) continue;
    if ((key === 'minimum' && value === -Number.MAX_SAFE_INTEGER) || (key === 'maximum' && (value === Number.MAX_SAFE_INTEGER || value === 2_147_483_647))) continue;
    // A closed object is still validated at /mcp; the model gains nothing from the keyword on every nested object.
    if (key === 'additionalProperties' && value === false) continue;
    out[key] = compactToolSchema(value);
  }
  return out;
}

/** The production tool host: one MCP client per run, on the run's token. `mcpUrl` is the API's `/mcp`. */
export function mcpToolHost(tokens: PersonalRunTokenIssuer, mcpUrl: string, fetchImpl: typeof fetch = fetch): PersonalToolHost {
  return async (run) => {
    const grant = await tokens.issue(run.id);
    // No token, no tools: the run does not quietly become another run (the processor ends it `unavailable`).
    if (!grant) throw new Error('No run token');
    let next = 1;
    try {
      const listed = await rpc(mcpUrl, grant.token, next++, 'tools/list', {}, undefined, fetchImpl);
      if (listed.status !== 200 || !listed.result || !Array.isArray(listed.result.tools)) throw new Error('The run\'s tools could not be listed');
      // The route lists exactly the run's tools; a tool outside the minted list is never offered to the model.
      const exact = new Set(grant.tools);
      const tools: PersonalTool[] = (listed.result.tools as Record<string, unknown>[])
        .filter((tool) => typeof tool.name === 'string' && exact.has(tool.name))
        .map((tool) => ({ name: tool.name as string, description: typeof tool.description === 'string' ? tool.description : String(tool.title ?? tool.name),
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? compactToolSchema(tool.inputSchema) as Record<string, unknown> : { type: 'object' } }));
      let closed = false;
      const session: PersonalToolSession = {
        tools,
        async call(call, signal) {
          if (closed) return { content: REFUSED, isError: true };
          const answer = await rpc(mcpUrl, grant.token, next++, 'tools/call', { name: call.name, arguments: call.input }, signal, fetchImpl)
            .catch(() => ({ status: 0 } as RpcAnswer));
          if (answer.status === 401 || answer.status === 403) return { content: REFUSED, isError: true };
          if (answer.error) return { content: `Flux refused this call: ${typeof answer.error.message === 'string' ? answer.error.message.slice(0, 300) : 'unavailable'}`, isError: true };
          if (answer.status !== 200 || !answer.result) return { content: 'The call failed.', isError: true };
          return { content: textOf(answer.result.content), isError: answer.result.isError === true };
        },
        async close() {
          if (closed) return;
          closed = true;
          await tokens.close(run.id);
        },
      };
      return session;
    } catch (error) {
      await tokens.close(run.id).catch(() => undefined);
      throw error;
    }
  };
}
