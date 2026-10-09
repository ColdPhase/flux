import http from 'node:http';

/**
 * TEST ONLY (#152 AC-4, founder direction 2026-10-08: mocks only, no vendor account): the model endpoint
 * the real, pinned `codex` and `claude` clients are pointed at. It answers the clients' model requests
 * from a script of tool calls, so a real client discovers and calls Flux's MCP tools without any model or
 * vendor sign-in. It is never a model and proves nothing about model behaviour.
 *
 *   POST …/responses     OpenAI Responses SSE (Codex). MCP tools are nested in Codex's `exec` JavaScript tool.
 *   POST …/v1/messages   Anthropic Messages SSE (Claude Code).
 */

export interface MockStep {
  /** Codex: JavaScript for its `exec` tool; every MCP tool is `tools.mcp__<server>__<tool>(args)`. */
  js?: string;
  /** Claude Code: one tool call, by its `mcp__<server>__<tool>` name. */
  call?: { name: string; args: Record<string, unknown> };
  text?: string;
}
export interface MockTurn {
  client: 'codex' | 'claude';
  /** Tool names the client offered on this request (Claude Code only; Codex hides them inside `exec`). */
  tools: string[];
  /** The output of every tool call so far, oldest first (Codex: the lines `exec` printed). */
  outputs: string[][];
  /** Every piece of instruction and user text the client put in this request (system/developer messages and user turns), not tool outputs. */
  prompt: string;
}
export type MockPlan = (turn: MockTurn) => MockStep;

const sse = (response: http.ServerResponse, events: [string, unknown][]) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
};
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (part as { text?: unknown }).text).filter((part): part is string => typeof part === 'string').join('\n') : '';

const messageText = (items: unknown[]) => items.flatMap((item) => {
  const record = item as { type?: string; content?: unknown };
  return record.type === 'message' || record.type === undefined ? [textOf(record.content)] : [];
}).join('\n');

function codexTurn(body: { input?: Record<string, unknown>[] }): MockTurn {
  const outputs = (body.input ?? []).filter((item) => item.type === 'custom_tool_call_output' || item.type === 'function_call_output')
    .map((item) => Array.isArray(item.output) ? (item.output as { text?: string }[]).slice(1).map((part) => part.text ?? '') : [String(item.output)]);
  return { client: 'codex', tools: [], outputs, prompt: messageText(body.input ?? []) };
}

function claudeTurn(body: { tools?: { name: string }[]; system?: unknown; messages?: { content: unknown }[] }): MockTurn {
  const outputs: string[][] = [];
  for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [])
    if (block.type === 'tool_result') outputs.push([textOf(block.content)]);
  return { client: 'claude', tools: (body.tools ?? []).map((tool) => tool.name), outputs,
    prompt: [textOf(body.system), ...(body.messages ?? []).map((message) => textOf(message.content))].join('\n') };
}

export async function startClientModelMock(plan: MockPlan) {
  const requests: MockTurn[] = [];
  let count = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0]!;
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; } catch { /* a probe without a body */ }
      const id = ++count;
      if (request.method === 'POST' && path.endsWith('/responses')) {
        const turn = codexTurn(body); requests.push(turn);
        const step = plan(turn);
        const item = step.js ? { type: 'custom_tool_call', call_id: `call-${id}`, name: 'exec', input: step.js }
          : { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: step.text ?? 'done' }] };
        return sse(response, [['response.created', { type: 'response.created', response: { id: `resp-${id}` } }],
          ['response.output_item.done', { type: 'response.output_item.done', item }],
          ['response.completed', { type: 'response.completed', response: { id: `resp-${id}`, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }]]);
      }
      if (request.method === 'POST' && path.endsWith('/v1/messages')) {
        const turn = claudeTurn(body); requests.push(turn);
        // Side requests (titles, summaries) do not carry the MCP tools; they get a plain answer.
        const step = turn.tools.some((name) => name.startsWith('mcp__')) ? plan(turn) : { text: 'ok' };
        const block = step.call ? { type: 'tool_use', id: `toolu_${id}`, name: step.call.name, input: {} } : { type: 'text', text: '' };
        const delta = step.call ? { type: 'input_json_delta', partial_json: JSON.stringify(step.call.args) } : { type: 'text_delta', text: step.text ?? 'done' };
        return sse(response, [['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', content: [], model: body.model ?? 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: step.call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }]]);
      }
      response.writeHead(path.endsWith('/models') ? 200 : 404, { 'content-type': 'application/json' });
      response.end(path.endsWith('/models') ? JSON.stringify({ models: [], data: [] }) : '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, requests, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
