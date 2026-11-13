import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// TEST ONLY (#1441): a scripted stand-in for Flux's model gateway as pi reaches it (`/anthropic/v1/messages`, Anthropic's Messages API,
// streamed; `…/chat/completions`, Chat Completions, streamed). It is never a model: each request takes the next step of the
// script (call a tool, answer, or refuse with a status and body) and is recorded with its credential headers, the tools it offered and the
// tool results it carried. Nothing here reaches a provider.

export type GatewayStep =
  | { tool: string; args: Record<string, unknown> }
  | { text: string }
  | { status: number; body: unknown };

export interface GatewayRequest {
  path: string;
  authorization: string | null;
  apiKey: string | null;
  model: string;
  tools: string[];
  /** The text of each tool result the request carries, in order. */
  results: string[];
  system: string;
  /** The first user message's text: Flux's request on pi's standard input (the brief). */
  prompt: string;
}

export interface FakeGateway {
  /** The origin pi is given (`modelOrigin`): the gateway's own paths below it (`/anthropic/v1/messages`, `/openai_compatible/chat/completions`). */
  url: string;
  requests: GatewayRequest[];
  script(steps: GatewayStep[]): void;
  close(): Promise<void>;
}

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '')).join('') : '';

function read(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>); } catch (error) { reject(error as Error); } });
    request.on('error', reject);
  });
}

function sse(response: ServerResponse, events: string[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) response.write(event);
  response.end();
}

export async function startFakeGateway(): Promise<FakeGateway> {
  let steps: GatewayStep[] = [];
  const requests: GatewayRequest[] = [];
  let n = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '').split('?')[0]!;
      const body = await read(request).catch(() => ({} as Record<string, unknown>));
      const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : [];
      const tools = (Array.isArray(body.tools) ? body.tools as Record<string, unknown>[] : []).map((tool) => String(tool.name ?? (tool.function as { name?: unknown } | undefined)?.name ?? ''));
      const messagesApi = path.endsWith('/v1/messages');
      const results = messagesApi
        ? messages.flatMap((message) => (Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []).filter((block) => block.type === 'tool_result').map((block) => textOf(block.content)))
        : messages.filter((message) => message.role === 'tool').map((message) => textOf(message.content));
      const system = messagesApi ? textOf(body.system) : textOf(messages.find((message) => message.role === 'system' || message.role === 'developer')?.content);
      requests.push({ path, authorization: request.headers.authorization ?? null, apiKey: (request.headers['x-api-key'] as string | undefined) ?? null,
        model: String(body.model ?? ''), tools, results, system, prompt: textOf(messages.find((message) => message.role === 'user')?.content) });
      const step = steps.shift() ?? { text: 'Done.' };
      if ('status' in step) {
        response.writeHead(step.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(step.body));
        return;
      }
      n += 1;
      const id = `fake-${n}`;
      if (messagesApi) {
        const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const block = 'tool' in step ? { type: 'tool_use', id: `toolu_${n}`, name: step.tool, input: {} } : { type: 'text', text: '' };
        const delta = 'tool' in step ? { type: 'input_json_delta', partial_json: JSON.stringify(step.args) } : { type: 'text_delta', text: step.text };
        sse(response, [
          event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage } }),
          event('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
          event('content_block_delta', { type: 'content_block_delta', index: 0, delta }),
          event('content_block_stop', { type: 'content_block_stop', index: 0 }),
          event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool' in step ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }),
          event('message_stop', { type: 'message_stop' }),
        ]);
        return;
      }
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: finish === 'usage' ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      sse(response, [
        chunk({ role: 'assistant', content: '' }, null),
        'tool' in step ? chunk({ tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null) : chunk({ content: step.text }, null),
        chunk({}, 'tool' in step ? 'tool_calls' : 'stop'),
        chunk({}, 'usage', { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }),
        'data: [DONE]\n\n',
      ]);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script(next) { steps = [...next]; requests.length = 0; },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
