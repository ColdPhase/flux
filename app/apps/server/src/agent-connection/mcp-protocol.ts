import { createMcpHandler, isJsonContentType, isLegacyRequest,
  isSpecType, readRequestBody, type McpServer } from '@modelcontextprotocol/server';

/**
 * What one MCP request may carry (#877, GHSA-46jr-4wx8-v453). The SDK's own default is 4 MiB, and a body of that size made of tiny
 * array elements can exhaust memory while it is validated. The largest text a tool takes is 100,000 characters (up to 400 KB), so
 * 1 MiB leaves room, and the longest array a tool declares holds 200 elements (`SKETCH_LIMITS.moves`; most hold 50), so 10,000
 * elements and members together is far above any real call. A request over the first is answered 413 before it is parsed; one over
 * the second is refused before validation. On the real route Fastify's own body limit (also 1 MiB) answers first; this one is the
 * handler's, for whatever calls it with a larger body (`mcp-protocol.test.ts` tests both).
 */
export const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 10_000;

/**
 * The legacy revisions Flux admits (PC-1): 2025-06-18, which the pinned Codex and Claude Code speak, and 2025-11-25, which pi offers and
 * cannot be told otherwise (#1441: pi 1.5.2's MCP client always offers its latest, 2025-11-25; the pinned SDK serves both). Each is
 * admitted exactly: the answer names the revision offered, and later requests must carry it.
 */
export const FLUX_MCP_LEGACY_VERSIONS = ['2025-06-18', '2025-11-25'] as const;
export const FLUX_MCP_PROTOCOL_VERSIONS = [...FLUX_MCP_LEGACY_VERSIONS, '2026-07-28'] as const;
const legacyVersions: readonly string[] = FLUX_MCP_LEGACY_VERSIONS;
const isLegacyVersion = (value: unknown): value is string => typeof value === 'string' && legacyVersions.includes(value);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function refuse(body: unknown, code: number, message: string, data?: Record<string, unknown>) {
  const id = object(body)?.id;
  return Response.json({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code, message, ...(data ? { data } : {}) } }, { status: 400 });
}

/**
 * PC-1 admission, inside the verified bearer boundary. The SDK remains the only era classifier;
 * malformed modern claims never reach legacy serving. No negotiated session stores an identity.
 */
/**
 * The refusal of a tool a personal run's token may not call (F-027 AST-4.2/AST-4.4): the same structured
 * result S6 returns for a switched-off capability, before anything runs.
 */
function refusedTool(body: unknown) {
  const id = object(body)?.id;
  return Response.json({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, result: {
    content: [{ type: 'text', text: JSON.stringify({ code: 'MCP_ENTRY_UNAVAILABLE', error: 'This capability is unavailable' }) }], isError: true,
  } });
}

/**
 * A personal run's answer to a resource request (#1165, RT-5). A run's server has no resources and does not declare the capability, so a
 * client that reads capabilities (Claude Code) offers the model no resource tool. The pinned Codex offers its own three readers whatever a
 * server declares, and its model may call one: it gets no resources, no templates, and "Resource not found" (-32002, MCP 2025-06-18) for
 * any address, which is never looked at. Anything else, or a malformed resource request, is the SDK's to answer.
 */
function noResources(body: unknown): Response | null {
  if (!isSpecType.JSONRPCRequest(body)) return null;
  const answer = (message: Record<string, unknown>) => Response.json({ jsonrpc: '2.0', id: body.id, ...message });
  if (isSpecType.ListResourcesRequest(body)) return answer({ result: { resources: [] } });
  if (isSpecType.ListResourceTemplatesRequest(body)) return answer({ result: { resourceTemplates: [] } });
  if (isSpecType.ReadResourceRequest(body)) return answer({ error: { code: -32002, message: 'Resource not found' } });
  return null;
}

/**
 * `refuseTool`: a personal run's token, which may call only these tools. `noResources`: also a run's, whose resource requests get the plain
 * answers above (in the 2025-06-18 era, the one the pinned Codex speaks; a 2026-07-28 request goes to the SDK, which has no handler).
 */
export function createFluxMcpHandler(factory: () => McpServer,
  options: { refuseTool?: (name: string) => boolean; noResources?: boolean } = {}) {
  const handler = createMcpHandler(factory, { legacy: 'stateless', maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES });
  return { async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || !isJsonContentType(request.headers.get('content-type'))) return handler.fetch(request);
    // Use the SDK limit before parsing. Pass the already bounded body to both classification and serving.
    const read = await readRequestBody(request.clone(), MCP_MAX_REQUEST_BODY_BYTES);
    if (read.tooLarge) return handler.fetch(request);
    let body: unknown;
    try { body = JSON.parse(read.text); } catch { return handler.fetch(request); }
    // An array cannot execute even one member, including an otherwise permitted write.
    if (Array.isArray(body)) return refuse(body, -32600, 'JSON-RPC batches are not supported');
    const call = object(body);
    if (options.refuseTool && call?.method === 'tools/call' && call.id !== undefined) {
      const name = object(call.params)?.name;
      if (typeof name !== 'string' || options.refuseTool(name)) return refusedTool(body);
    }
    if (!await isLegacyRequest(request, body, { maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES })) return handler.fetch(request, { parsedBody: body });
    const rpc = object(body);
    if (!rpc) return handler.fetch(request, { parsedBody: body });
    const header = request.headers.get('mcp-protocol-version');
    const unsupported = (requested: unknown) => refuse(body, -32022, 'Unsupported protocol version',
      { requested: typeof requested === 'string' ? requested : 'unknown', supported: [...legacyVersions] });
    if (rpc.method === 'notifications/initialized') {
      if ('id' in rpc || !isSpecType.JSONRPCNotification(body) || !isSpecType.InitializedNotification(body))
        return refuse(body, -32600, 'Invalid initialized notification');
      if (header !== null && !isLegacyVersion(header)) return unsupported(header);
      return new Response(null, { status: 202 });
    }
    if (!('id' in rpc) && typeof rpc.method === 'string')
      return Response.json({ error: 'Legacy notification is not supported' }, { status: 400 });
    if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/'))
      return refuse(body, -32601, 'Legacy notification method is not supported');
    if (rpc.method === 'initialize') {
      if (!isSpecType.JSONRPCRequest(body) || !isSpecType.InitializeRequest(body))
        return refuse(body, -32602, 'Invalid initialize request');
      const offered = object(rpc.params)?.protocolVersion;
      if (!isLegacyVersion(offered)) return unsupported(offered);
      if (header !== null && header !== offered) return unsupported(header);
    } else if (!isLegacyVersion(header)) return unsupported(header);
    if (options.noResources) { const answered = noResources(body); if (answered) return answered; }
    return handler.fetch(request, { parsedBody: body });
  } };
}
