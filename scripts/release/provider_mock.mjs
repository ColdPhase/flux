// TEST ONLY (#1241): a local OpenAI-compatible endpoint (model list and Chat Completions) for the upgrade checks.
//
// smoke_data.py saves an owner AI connection whose base URL points here (`http://provider-mock:8091/v1`; the host is allowed
// by FLUX_AI_PRIVATE_TARGETS in provider-mock.compose.yaml) and runs an agent on it, before and after an upgrade. The service runs
// the release image's own Node, so nothing is pulled. It is never a provider: nothing here proves compatibility, billing or
// model behaviour. `GET /__requests` returns what reached it.
import http from 'node:http';

const requests = [];
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
      return send(response, 200, {
        id: 'chatcmpl-upgrade-check', object: 'chat.completion', model: body?.model ?? 'upgrade-check-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'UPGRADE-CHECK-ANSWER: the provider mock answered.' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    }
    return send(response, 404, { error: { message: 'not found' } });
  });
}).listen(8091, '0.0.0.0');
