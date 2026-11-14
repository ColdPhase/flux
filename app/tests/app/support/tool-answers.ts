/**
 * TEST ONLY (#1441, RT-1 rule 2): the answers of the app suite's mock providers to a request that offers tools, in each wire format: the
 * model calls the first tool it was offered (with no arguments), or answers in words only. The check that decides whether a model can be an
 * agent offers one tool, `ping`, and these are what it reads. Never a provider: the shapes are the documented ones of the fixtures in
 * `provider-tool-fixtures.ts`.
 */

export type ToolWire = 'anthropic' | 'responses' | 'chat';

interface Body { model?: string; tools?: { name?: string; function?: { name?: string } }[] }

/** The wire format a request path is for, or null when it asks for no answer. */
export function toolWireOf(pathname: string): ToolWire | null {
  if (pathname.endsWith('/v1/messages')) return 'anthropic';
  if (pathname.endsWith('/responses')) return 'responses';
  if (pathname.endsWith('/chat/completions')) return 'chat';
  return null;
}

/** The names of the tools a request offers, in order, as the wire format writes them. */
export function offeredTools(wire: ToolWire, body: unknown): string[] {
  const tools = (body as Body | null)?.tools;
  return (Array.isArray(tools) ? tools : []).map((tool) => String(wire === 'chat' ? tool.function?.name : tool.name));
}

/** What the key listing mock reports as the request's usage: small and fixed, so a test can compute its cost. */
export const TOOL_ANSWER_USAGE = { input: 60, output: 8 };

/** The response body of one request: a call of the first offered tool, or (`call: false`, or no tool offered) a few words. */
export function toolAnswer(wire: ToolWire, body: unknown, { call = true, usage: reported = TOOL_ANSWER_USAGE }: { call?: boolean; usage?: { input: number; output: number } } = {}): unknown {
  const model = (body as Body | null)?.model;
  const [name] = offeredTools(wire, body);
  const calls = call && name !== undefined;
  const stamp = Date.now();
  const { input, output } = reported;
  if (wire === 'anthropic') {
    return { id: `msg_${stamp}`, type: 'message', role: 'assistant', model, stop_sequence: null, stop_reason: calls ? 'tool_use' : 'end_turn',
      content: calls ? [{ type: 'tool_use', id: `toolu_${stamp}`, name, input: {} }] : [{ type: 'text', text: 'ping' }],
      usage: { input_tokens: input, output_tokens: output } };
  }
  const usage = { total_tokens: input + output };
  if (wire === 'responses') {
    return { id: `resp_${stamp}`, object: 'response', model, status: 'completed', incomplete_details: null,
      output: calls ? [{ id: `fc_${stamp}`, call_id: `call_${stamp}`, type: 'function_call', name, arguments: '{}', status: 'completed' }]
        : [{ id: `msg_${stamp}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ping', annotations: [] }] }],
      usage: { input_tokens: input, output_tokens: output, ...usage } };
  }
  return { id: `chatcmpl-${stamp}`, object: 'chat.completion', created: Math.floor(stamp / 1000), model,
    choices: [{ index: 0, finish_reason: calls ? 'tool_calls' : 'stop',
      message: calls ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${stamp}`, type: 'function', function: { name, arguments: '{}' } }] } : { role: 'assistant', content: 'ping' } }],
    usage: { prompt_tokens: input, completion_tokens: output, ...usage } };
}
