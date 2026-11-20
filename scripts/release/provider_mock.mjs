// TEST ONLY (#1241): a local OpenAI-compatible endpoint (model list and Chat Completions) for the upgrade checks.
//
// smoke_data.py saves an owner AI connection whose base URL points here (`http://provider-mock:8091/v1`; the host is allowed
// by FLUX_AI_PRIVATE_TARGETS in provider-mock.compose.yaml) and runs an agent on it, before and after an upgrade. The service runs
// the release image's own Node, so nothing is pulled. It is never a provider: nothing here proves compatibility, billing or
// model behaviour. `GET /__requests` returns what reached it.
//
// A release before v0.2.1 ran its agent in the worker, which asks for one JSON answer. From v0.2.1 every agent on an API key runs in
// pi in the agent runtime (#1441), which asks for a stream (`stream: true`, Server-Sent Events, `transport: sse` in its settings) through
// the worker's model gateway: the mock answers each in the form it asks for, with the same words.
// From v0.2.1 a model is an agent only when it calls a tool (RT-1 rule 2, #1441): adding the key sends one request whose only tool is
// `ping`, which the mock calls, in either form. Every other request gets the words, so an agent's run ends after one answer.
import http from 'node:http';

const requests = [];
const ANSWER = 'UPGRADE-CHECK-ANSWER: the provider mock answered.';
const send = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
};

http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const path = request.url ?? '';
    if (path === '/__health') return send(response, 200, { ok: true });
    if (path === '/__requests') return send(response, 200, { requests });
    let body = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    requests.push({ method: request.method, path, model: body?.model ?? null, messages: Array.isArray(body?.messages) ? body.messages.length : 0 });
    if (request.method === 'GET' && path === '/v1/models') {
      return send(response, 200, { object: 'list', data: [{ id: 'upgrade-check-model', object: 'model' }] });
    }
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      const model = body?.model ?? 'upgrade-check-model';
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      const ping = tools.length === 1 && tools[0]?.function?.name === 'ping';
      const call = { id: 'call_upgrade_check', type: 'function', function: { name: 'ping', arguments: '{}' } };
      if (ping && body?.stream === true) {
        const chunk = (delta, finish, counted) => `data: ${JSON.stringify({
          id: 'chatcmpl-upgrade-check', object: 'chat.completion.chunk', created: 0, model,
          choices: counted ? [] : [{ index: 0, delta, finish_reason: finish }], ...(counted ? { usage: counted } : {}),
        })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        return response.end([chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, ...call }] }, null), chunk({}, 'tool_calls'), chunk({}, null, usage),
          'data: [DONE]\n\n'].join(''));
      }
      if (ping) return send(response, 200, { id: 'chatcmpl-upgrade-check', object: 'chat.completion', model,
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call] } }], usage });
      if (body?.stream === true) {
        // Chat Completions chunks: the role, the words, the finish, then the usage the gateway charges (an empty `choices`), then [DONE].
        const chunk = (delta, finish, counted) => `data: ${JSON.stringify({
          id: 'chatcmpl-upgrade-check', object: 'chat.completion.chunk', created: 0, model,
          choices: counted ? [] : [{ index: 0, delta, finish_reason: finish }], ...(counted ? { usage: counted } : {}),
        })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        return response.end([chunk({ role: 'assistant', content: '' }, null), chunk({ content: ANSWER }, null), chunk({}, 'stop'), chunk({}, null, usage), 'data: [DONE]\n\n'].join(''));
      }
      return send(response, 200, {
        id: 'chatcmpl-upgrade-check', object: 'chat.completion', model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }],
        usage,
      });
    }
    return send(response, 404, { error: { message: 'not found' } });
  });
}).listen(8091, '0.0.0.0');
