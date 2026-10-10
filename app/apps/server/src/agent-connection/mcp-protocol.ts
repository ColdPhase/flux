import { createMcpHandler, DEFAULT_MAX_REQUEST_BODY_SIZE, isJsonContentType, isLegacyRequest,
  isSpecType, readRequestBody, type McpServer } from '@modelcontextprotocol/server';

export const FLUX_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2026-07-28'] as const;
const legacyVersion = FLUX_MCP_PROTOCOL_VERSIONS[0]!;

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
export function createFluxMcpHandler(factory: () => McpServer) {
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  return { async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || !isJsonContentType(request.headers.get('content-type'))) return handler.fetch(request);
    // Use the SDK limit before parsing. Pass the already bounded body to both classification and serving.
    const read = await readRequestBody(request.clone(), DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (read.tooLarge) return handler.fetch(request);
    let body: unknown;
    try { body = JSON.parse(read.text); } catch { return handler.fetch(request); }
    // An array cannot execute even one member, including an otherwise permitted write.
    if (Array.isArray(body)) return refuse(body, -32600, 'JSON-RPC batches are not supported');
    if (!await isLegacyRequest(request, body)) return handler.fetch(request, { parsedBody: body });
    const rpc = object(body);
    if (!rpc) return handler.fetch(request, { parsedBody: body });
    const header = request.headers.get('mcp-protocol-version');
    const unsupported = (requested: unknown) => refuse(body, -32022, 'Unsupported protocol version',
      { requested: typeof requested === 'string' ? requested : 'unknown', supported: [legacyVersion] });
    if (rpc.method === 'notifications/initialized') {
      if ('id' in rpc || !isSpecType.JSONRPCNotification(body) || !isSpecType.InitializedNotification(body))
        return refuse(body, -32600, 'Invalid initialized notification');
      if (header !== null && header !== legacyVersion) return unsupported(header);
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
      if (offered !== legacyVersion) return unsupported(offered);
      if (header !== null && header !== offered) return unsupported(header);
    } else if (header !== legacyVersion) return unsupported(header);
    return handler.fetch(request, { parsedBody: body });
  } };
}
