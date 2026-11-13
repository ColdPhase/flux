import type { PersonalToolCall, PersonalTool, PersonalTurn, WebSearchFound } from '@flux/core';
import { MalformedResponseError } from './errors.js';

// Tool calling on each wire format (F-027 AST-8): the neutral `PersonalTool` definitions written as
// the provider expects them, the provider's tool calls read back as neutral `PersonalToolCall`s, and
// the earlier turns of the loop written as the provider's own conversation. These are pure
// functions of the request and the response; they send nothing. Which wire format a provider
// kind speaks is `AI_PROVIDERS[kind].wire`; shapes were read from each vendor's documentation on
// 2026-10-11 (see docs/development/personal-runs.md, "Tool calling").
//
// Rules shared by both formats:
// - A response is read for tool calls only when tools were offered, and never when it was cut off
//   or refused: a partial call is not a call.
// - The provider's own assistant message of a turn (`replay`) is sent back exactly as it came, so
//   provider-private continuity data (reasoning blocks, thought signatures) is not lost; only when
//   there is none is the message rebuilt from the neutral turn.
// - Every call of a turn is answered by exactly one result, in the call order, in one message.

export type Wire = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Results in the order of the turn's calls; a missing one is a refused request (never sent without all of them). */
function resultsInCallOrder(turn: PersonalTurn) {
  return turn.calls.map((call) => {
    const result = turn.results.find((item) => item.callId === call.id);
    if (!result) throw new Error('A tool call has no result');
    return result;
  });
}

// --- Anthropic Messages -------------------------------------------------------------------------

/** `tools[]` of a Messages request: `name`, `description`, `input_schema`. No `tool_choice` is sent (`auto` is the default). */
export const anthropicTools = (tools: readonly PersonalTool[]): Wire[] =>
  tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));

/**
 * The conversation: the request, then for each turn the assistant's content blocks and one user
 * message whose `tool_result` blocks come first, one per `tool_use`, in call order. A paused turn (#1116) has the assistant's blocks only.
 */
export function anthropicMessages(input: string, turns: readonly PersonalTurn[] = [], answerNow?: string): Wire[] {
  const messages: Wire[] = [{ role: 'user', content: input }];
  for (const turn of turns) {
    const rebuilt = [
      ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
      ...turn.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
    ];
    messages.push({ role: 'assistant', content: Array.isArray(turn.replay) && turn.replay.length ? turn.replay : rebuilt });
    // A turn the provider paused (#1116) has no call: the request goes on from its answer, which is the last message.
    if (!turn.calls.length) continue;
    // A picture a call returned (#1217) is an image block of its tool_result, after its words (docs.claude.com "Vision" and "Tool use", read 2026-11-12).
    messages.push({ role: 'user', content: resultsInCallOrder(turn).map((result) => ({
      type: 'tool_result', tool_use_id: result.callId,
      content: result.images?.length ? [{ type: 'text', text: result.content }, ...result.images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))]
        : result.content,
      ...(result.isError ? { is_error: true } : {}),
    })) });
  }
  // Flux's words of a run's last request (#1410): a text block after the last results, in the same user message.
  if (answerNow) {
    const end = messages.at(-1)!;
    if (end.role === 'user' && Array.isArray(end.content)) end.content = [...end.content as Wire[], { type: 'text', text: answerNow }];
    else messages.push({ role: 'user', content: answerNow });
  }
  return messages;
}

/** The `tool_use` blocks of a response's content, in order. */
export function anthropicToolCalls(content: readonly unknown[]): PersonalToolCall[] {
  // The id correlates a call with its result: two calls with one id are a malformed response, and
  // it is refused here, before any call runs (as the Chat Completions reader does).
  const seen = new Set<string>();
  return content.flatMap((block) => {
    if (!isObject(block) || block.type !== 'tool_use') return [];
    if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) throw new MalformedResponseError('a tool_use block without id or name');
    if (seen.has(block.id)) throw new MalformedResponseError('a repeated tool_use id');
    seen.add(block.id);
    return isObject(block.input) ? [{ id: block.id, name: block.name, input: block.input }]
      : [{ id: block.id, name: block.name, input: {}, invalid: true as const }];
  });
}

/**
 * The answer's text. Without a web search it is the text blocks joined by line breaks, as always. With one (#954) a sentence that
 * cites a search result is split into several text blocks, which belong together: consecutive text blocks are one passage, joined as
 * they are, and the passages around a search are paragraphs.
 */
export function anthropicText(content: readonly unknown[]): string {
  const text = (block: unknown) => (isObject(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : null);
  if (!content.some((block) => isObject(block) && (block.type === 'server_tool_use' || block.type === 'web_search_tool_result')))
    return content.flatMap((block) => { const words = text(block); return words === null ? [] : [words]; }).join('\n').trim();
  const passages: string[] = [];
  let current = '';
  for (const block of content) {
    const words = text(block);
    if (words !== null) { current += words; continue; }
    if (current.trim()) passages.push(current.trim());
    current = '';
  }
  if (current.trim()) passages.push(current.trim());
  return passages.join('\n\n');
}

/**
 * What Anthropic's web search brought in a response (#954): the queries of its `server_tool_use` blocks, the addresses of its
 * `web_search_tool_result` blocks (an error result has none) and the addresses the text blocks cite (`web_search_result_location`).
 * Read from the provider's structured answer, never from the model's words. Undefined when the response neither searched nor cites.
 */
export function anthropicWebSearch(content: readonly unknown[]): WebSearchFound | undefined {
  const found: WebSearchFound = { queries: [], results: [], cited: [] };
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'server_tool_use' && block.name === 'web_search' && isObject(block.input) && typeof block.input.query === 'string') found.queries.push(block.input.query);
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content))
      for (const result of block.content) if (isObject(result) && result.type === 'web_search_result' && typeof result.url === 'string') found.results.push(result.url);
    if (block.type === 'text' && Array.isArray(block.citations))
      for (const citation of block.citations) if (isObject(citation) && citation.type === 'web_search_result_location' && typeof citation.url === 'string') found.cited.push(citation.url);
  }
  return found.queries.length || found.results.length || found.cited.length ? found : undefined;
}

// --- OpenAI Responses (#954) --------------------------------------------------------------------

/**
 * `tools[]` of a Responses request: `{ type: 'function', name, description, parameters, strict: false }`. `strict` is sent as false:
 * left out, the Responses API tries to turn the schema into its strict form, which changes what the tool accepts.
 */
export const responsesTools = (tools: readonly PersonalTool[]): Wire[] =>
  tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));

/**
 * The input items: the request, then for each turn its replay (`responsesReplay`: the model's words and its function calls as it wrote
 * them) and one `function_call_output` per call, in call order. This wire format has no error flag, so a failed result starts with
 * "Error: ". Without a replay the turn is rebuilt from its text and calls.
 */
export function responsesInput(input: string, turns: readonly PersonalTurn[] = [], answerNow?: string): Wire[] {
  const items: Wire[] = [{ role: 'user', content: input }];
  for (const turn of turns) {
    if (Array.isArray(turn.replay) && turn.replay.length) items.push(...(turn.replay as Wire[]));
    else {
      if (turn.text) items.push({ role: 'assistant', content: turn.text });
      for (const call of turn.calls) items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
    }
    // A picture a call returned (#1217) goes in its output as an `input_image` after its words (the Responses API's function_call_output
    // takes a string or a list of input_text, input_image and input_file items; platform.openai.com, read 2026-11-12).
    for (const result of resultsInCallOrder(turn))
      items.push({ type: 'function_call_output', call_id: result.callId, output: result.isError ? `Error: ${result.content}`
        : result.images?.length ? [{ type: 'input_text', text: result.content }, ...result.images.map((image) => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` }))]
          : result.content });
  }
  // Flux's words of a run's last request (#1410), after the last outputs.
  if (answerNow) items.push({ role: 'user', content: answerNow });
  return items;
}

/**
 * What of a response goes back with the next request (#954): its messages' words as an assistant message and its function calls as
 * the model wrote them, without item ids. Nothing is stored at OpenAI (`store: false`), so an item id would point at nothing; the
 * reasoning items and the web search calls stay out: reasoning is not carried from one turn to the next (as on Chat Completions, and
 * no encrypted reasoning is asked for, which non-reasoning models refuse), and what a search found is in the words that cite it.
 */
export function responsesReplay(output: readonly unknown[]): Wire[] {
  const { text } = responsesText(output);
  return [
    ...(text ? [{ role: 'assistant', content: text }] : []),
    ...output.flatMap((item) => (isObject(item) && item.type === 'function_call'
      ? [{ type: 'function_call', call_id: item.call_id, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '' }] : [])),
  ];
}

/** The `function_call` items of a response's output, in order. `arguments` is a JSON string: one that is not a JSON object is `invalid`, never run. */
export function responsesToolCalls(output: readonly unknown[]): PersonalToolCall[] {
  const seen = new Set<string>();
  return output.flatMap((item) => {
    if (!isObject(item) || item.type !== 'function_call') return [];
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name) throw new MalformedResponseError('a function_call without call_id or name');
    if (seen.has(item.call_id)) throw new MalformedResponseError('a repeated function_call call_id');
    seen.add(item.call_id);
    const text = typeof item.arguments === 'string' ? item.arguments.trim() : item.arguments === undefined || item.arguments === null ? '' : null;
    if (text === null) return [{ id: item.call_id, name: item.name, input: {}, invalid: true as const }];
    if (text === '') return [{ id: item.call_id, name: item.name, input: {} }];
    try {
      const parsed: unknown = JSON.parse(text);
      return [isObject(parsed) ? { id: item.call_id, name: item.name, input: parsed } : { id: item.call_id, name: item.name, input: {}, invalid: true as const }];
    } catch {
      return [{ id: item.call_id, name: item.name, input: {}, invalid: true as const }];
    }
  });
}

/** The answer's text: the `output_text` parts of the response's messages, a message per paragraph; and whether any part is a refusal. */
export function responsesText(output: readonly unknown[]): { text: string; refused: boolean } {
  const messages: string[] = [];
  let refused = false;
  for (const item of output) {
    if (!isObject(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    let words = '';
    for (const part of item.content) {
      if (!isObject(part)) continue;
      if (part.type === 'output_text' && typeof part.text === 'string') words += part.text;
      if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.trim()) refused = true;
    }
    if (words.trim()) messages.push(words.trim());
  }
  return { text: messages.join('\n\n'), refused };
}

/**
 * What OpenAI's web search brought in a response (#954): the queries of its `search` actions, the addresses those searches returned
 * (`action.sources`, asked for with `include: ['web_search_call.action.sources']`) and the addresses the message cites (`url_citation`
 * annotations). Never the address of an `open_page` or `find_in_page` action: that is the address the MODEL chose to open (C-30; the
 * review of #1073). `calls`: how many web search calls the response made, each billed, whatever their action.
 */
export function responsesWebSearch(output: readonly unknown[]): { found: WebSearchFound | undefined; calls: number } {
  const found: WebSearchFound = { queries: [], results: [], cited: [] };
  let calls = 0;
  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type === 'web_search_call') {
      calls += 1;
      const action = isObject(item.action) ? item.action : null;
      if (action?.type !== 'search') continue;
      if (typeof action.query === 'string') found.queries.push(action.query);
      if (Array.isArray(action.queries)) for (const query of action.queries) if (typeof query === 'string') found.queries.push(query);
      if (Array.isArray(action.sources)) for (const source of action.sources) if (isObject(source) && typeof source.url === 'string') found.results.push(source.url);
    }
    if (item.type === 'message' && Array.isArray(item.content))
      for (const part of item.content)
        if (isObject(part) && Array.isArray(part.annotations))
          for (const note of part.annotations) if (isObject(note) && note.type === 'url_citation' && typeof note.url === 'string') found.cited.push(note.url);
  }
  return { found: found.queries.length || found.results.length || found.cited.length ? found : undefined, calls };
}

// --- Chat Completions (OpenRouter, Gemini's compatible endpoint, self-hosted servers) -------------

/** `tools[]` of a Chat Completions request: `{ type: 'function', function: { name, description, parameters } }`. */
export const chatTools = (tools: readonly PersonalTool[]): Wire[] =>
  tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));

/**
 * The conversation: the system and user messages, then for each turn the assistant message with its
 * `tool_calls` and one `role: 'tool'` message per call (`tool_call_id`, `content`). This wire format
 * has no error flag, so a failed result starts with "Error: ".
 */
export function chatMessages(system: string, user: string, turns: readonly PersonalTurn[] = [], answerNow?: string): Wire[] {
  const messages: Wire[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for (const turn of turns) {
    const rebuilt: Wire = {
      role: 'assistant', content: turn.text || null,
      tool_calls: turn.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })),
    };
    messages.push(isObject(turn.replay) && Array.isArray(turn.replay.tool_calls) ? { ...turn.replay, role: 'assistant' } : rebuilt);
    for (const result of resultsInCallOrder(turn))
      messages.push({ role: 'tool', tool_call_id: result.callId, content: result.isError ? `Error: ${result.content}` : result.content });
    // A tool message carries text only on this wire format: the pictures of a turn's calls (#1217) follow its tool messages as one user message.
    const pictures = turn.results.flatMap((result) => (result.isError ? [] : result.images ?? []));
    if (pictures.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'The pictures flux_view_image returned:' },
      ...pictures.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] });
  }
  // Flux's words of a run's last request (#1410), after the last tool messages.
  if (answerNow) messages.push({ role: 'user', content: answerNow });
  return messages;
}

/**
 * The `tool_calls` of a response's assistant message. `arguments` is a JSON string by contract: one
 * that is not a JSON object (a model's malformed call) is returned as `invalid` and never run.
 */
export function chatToolCalls(message: unknown): PersonalToolCall[] {
  const raw = isObject(message) ? message.tool_calls : undefined;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new MalformedResponseError('tool_calls is not a list');
  const seen = new Set<string>();
  return raw.map((entry) => {
    const fn = isObject(entry) && isObject(entry.function) ? entry.function : null;
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id || !fn || typeof fn.name !== 'string' || !fn.name)
      throw new MalformedResponseError('a tool call without id or name');
    if (seen.has(entry.id)) throw new MalformedResponseError('a repeated tool call id');
    seen.add(entry.id);
    // Some servers send no arguments at all for a tool without parameters.
    const text = typeof fn.arguments === 'string' ? fn.arguments.trim() : fn.arguments === undefined || fn.arguments === null ? '' : null;
    if (text === null) return { id: entry.id, name: fn.name, input: {}, invalid: true as const };
    if (text === '') return { id: entry.id, name: fn.name, input: {} };
    try {
      const parsed: unknown = JSON.parse(text);
      return isObject(parsed) ? { id: entry.id, name: fn.name, input: parsed } : { id: entry.id, name: fn.name, input: {}, invalid: true as const };
    } catch {
      return { id: entry.id, name: fn.name, input: {}, invalid: true as const };
    }
  });
}
