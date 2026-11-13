import { createServer } from 'node:http';

// TEST ONLY (#1441, scripts/check_model_gateway.sh): the provider behind the worker's model gateway. It answers Anthropic's Messages
// path with a fixed message and usage, and tells the check which keys it was sent (`GET /seen`), so the check can see that the key
// reached the provider and nothing in the runtime.

const seen: string[] = [];
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/seen') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: seen })); return; }
  req.resume();
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404); res.end(); return; }
    seen.push(String(req.headers['x-api-key'] ?? ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_gateway', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello from the provider behind the gateway.' }], usage: { input_tokens: 40, output_tokens: 12 } }));
  });
}).listen(8099, '0.0.0.0', () => console.log('model gateway mock ready'));
