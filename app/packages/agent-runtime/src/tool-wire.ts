import type { PersonalToolCall, PersonalTool, PersonalTurn } from '@flux/core';
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
 * message whose `tool_result` blocks come first, one per `tool_use`, in call order.
 */
export function anthropicMessages(input: string, turns: readonly PersonalTurn[] = []): Wire[] {
  const messages: Wire[] = [{ role: 'user', content: input }];
  for (const turn of turns) {
    const rebuilt = [
      ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
      ...turn.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
    ];
    messages.push({ role: 'assistant', content: Array.isArray(turn.replay) && turn.replay.length ? turn.replay : rebuilt });
    messages.push({ role: 'user', content: resultsInCallOrder(turn).map((result) => ({
      type: 'tool_result', tool_use_id: result.callId, content: result.content, ...(result.isError ? { is_error: true } : {}),
    })) });
  }
  return messages;
}

/** The `tool_use` blocks of a response's content, in order. */
export function anthropicToolCalls(content: readonly unknown[]): PersonalToolCall[] {
  return content.flatMap((block) => {
    if (!isObject(block) || block.type !== 'tool_use') return [];
    if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) throw new MalformedResponseError('a tool_use block without id or name');
    return isObject(block.input) ? [{ id: block.id, name: block.name, input: block.input }]
      : [{ id: block.id, name: block.name, input: {}, invalid: true as const }];
  });
}

// --- Chat Completions (OpenAI, OpenRouter, Gemini's compatible endpoint, self-hosted servers) ----

/** `tools[]` of a Chat Completions request: `{ type: 'function', function: { name, description, parameters } }`. */
export const chatTools = (tools: readonly PersonalTool[]): Wire[] =>
  tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));

/**
 * The conversation: the system and user messages, then for each turn the assistant message with its
 * `tool_calls` and one `role: 'tool'` message per call (`tool_call_id`, `content`). This wire format
 * has no error flag, so a failed result starts with "Error: ".
 */
export function chatMessages(system: string, user: string, turns: readonly PersonalTurn[] = []): Wire[] {
  const messages: Wire[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for (const turn of turns) {
    const rebuilt: Wire = {
      role: 'assistant', content: turn.text || null,
      tool_calls: turn.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })),
    };
    messages.push(isObject(turn.replay) && Array.isArray(turn.replay.tool_calls) ? { ...turn.replay, role: 'assistant' } : rebuilt);
    for (const result of resultsInCallOrder(turn))
      messages.push({ role: 'tool', tool_call_id: result.callId, content: result.isError ? `Error: ${result.content}` : result.content });
  }
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
