import type { AiProviderKind } from '@flux/contracts';
import type { PersonalTool } from '@flux/core';

// Wire-format fixtures of tool calling (F-027 AST-8.1). Each response below is written in the shape
// the vendor documents for it, read on 2026-10-11 from:
//   Anthropic Messages  https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
//                       (assistant `content` with a `text` and a `tool_use` block, `stop_reason: "tool_use"`)
//   OpenAI Chat         https://developers.openai.com/api/docs/guides/function-calling and OpenRouter's
//                       tool-calling guide (assistant `tool_calls` with a JSON-string `arguments`,
//                       `finish_reason: "tool_calls"`, `role: "tool"` results with `tool_call_id`)
// They are DOCUMENTED-SHAPE fixtures, not recordings from a live account: no real vendor account, key
// or spend exists in this repository's tests. What a real provider returns beyond these shapes is
// unverified. The Gemini thought-signature field (`extra_content.google.thought_signature`) is NOT
// confirmed by Google's pages as read on 2026-10-11; its fixture only proves that fields the adapter
// does not know are sent back on the same tool call unchanged.

export const FLUX_TOOLS: PersonalTool[] = [
  {
    name: 'flux_list_work',
    description: 'Lists the open work items of a project the run may read.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string', description: 'The project id' } }, required: ['projectId'] },
  },
  {
    name: 'flux_update_work',
    description: 'Changes the title or outcome of one work item.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id'] },
  },
];

export const PROJECT_ID = '0b0f3b6e-61a2-4c4f-8f0f-6f1d5f6a7b11';

// --- Anthropic Messages -------------------------------------------------------------------------

export const ANTHROPIC_TOOL_USE = {
  id: 'msg_01Aq9w938a90dw8q', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [
    { type: 'text', text: "I'll look at the open work first." },
    { type: 'tool_use', id: 'toolu_01A09q90qw90lq917835lq9', name: 'flux_list_work', input: { projectId: PROJECT_ID } },
  ],
  stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1_850, output_tokens: 64 },
};

/** A tool turn that carries a thinking block: it must be sent back unchanged with the results. */
export const ANTHROPIC_TOOL_USE_WITH_THINKING = {
  ...ANTHROPIC_TOOL_USE,
  content: [
    { type: 'thinking', thinking: 'The request is about open work, so I list it.', signature: 'EqQBCkYIBRgCIkDtest-signature-not-a-real-one' },
    ...ANTHROPIC_TOOL_USE.content,
  ],
};

/** Cut off by `max_tokens` inside a `tool_use` block: the block is partial and never executable. */
export const ANTHROPIC_TOOL_USE_TRUNCATED = {
  ...ANTHROPIC_TOOL_USE, stop_reason: 'max_tokens',
  content: [{ type: 'tool_use', id: 'toolu_01TRUNC', name: 'flux_list_work', input: {} }],
};

export const ANTHROPIC_FINAL = {
  id: 'msg_01Final', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'Fact: one item is open: Camera in low light [S1].' }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2_100, output_tokens: 31 },
};

// --- Chat Completions (OpenAI, OpenRouter, Gemini's compatible endpoint, self-hosted) ------------

const chatCall = (id: string, args: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'function', function: { name: 'flux_list_work', arguments: args }, ...extra });

export const CHAT_TOOL_CALLS = {
  id: 'chatcmpl-9x7T', object: 'chat.completion', created: 1_790_000_000, model: 'gpt-5.4',
  choices: [{ index: 0, finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, refusal: null, annotations: [], tool_calls: [chatCall('call_8bQ2zXh', JSON.stringify({ projectId: PROJECT_ID }))] } }],
  usage: { prompt_tokens: 1_850, completion_tokens: 42, total_tokens: 1_892 },
};

/** OpenRouter's usage accounting adds the response's own cost in `usage.cost`. */
export const OPENROUTER_TOOL_CALLS = {
  ...CHAT_TOOL_CALLS, model: 'vendor/model-with-tools',
  usage: { prompt_tokens: 1_850, completion_tokens: 42, total_tokens: 1_892, cost: 0.0042 },
};

/** Gemini's OpenAI-compatible endpoint; the signature field is a fixture assumption (see the header). */
export const GEMINI_TOOL_CALLS = {
  ...CHAT_TOOL_CALLS, model: 'gemini-3.5-flash',
  choices: [{ index: 0, finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: [chatCall('function-call-1', JSON.stringify({ projectId: PROJECT_ID }),
      { extra_content: { google: { thought_signature: 'test-signature-not-a-real-one' } } })] } }],
};

/** Ollama, vLLM and LM Studio often end an answer that holds tool calls with `stop`. */
export const COMPATIBLE_TOOL_CALLS_STOP = {
  ...CHAT_TOOL_CALLS, model: 'llama3.1:8b',
  choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: '', tool_calls: [chatCall('call_0', JSON.stringify({ projectId: PROJECT_ID }))] } }],
};

/** Two calls in one answer, the second with arguments that are not JSON. */
export const CHAT_TWO_CALLS = {
  ...CHAT_TOOL_CALLS,
  choices: [{ index: 0, finish_reason: 'tool_calls',
    message: { role: 'assistant', content: 'Checking.', tool_calls: [chatCall('call_a', JSON.stringify({ projectId: PROJECT_ID })), chatCall('call_b', '{"projectId": ')] } }],
};

export const CHAT_TOOL_CALLS_TRUNCATED = {
  ...CHAT_TOOL_CALLS,
  choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: null, tool_calls: [chatCall('call_cut', '{"projectId": "0b0f')] } }],
};

export const CHAT_FINAL = {
  id: 'chatcmpl-final', object: 'chat.completion', model: 'gpt-5.4',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Fact: one item is open: Camera in low light [S1].' } }],
  usage: { prompt_tokens: 2_100, completion_tokens: 31, total_tokens: 2_131 },
};

/** One row per provider kind: how its connection is written and which fixture it answers with. */
export interface ToolWireCase {
  name: string;
  provider: AiProviderKind;
  model: string;
  wire: 'anthropic' | 'chat';
  toolCalls: unknown;
  /** The provider's own assistant message of the tool turn, as the adapter must send it back. */
  assistantMessage: unknown;
  final: unknown;
  inputTokens: number;
  outputTokens: number;
  reportedCostMicros?: number;
}

export const TOOL_WIRE_CASES: ToolWireCase[] = [
  { name: 'Anthropic Messages', provider: 'anthropic', model: 'claude-sonnet-5', wire: 'anthropic', toolCalls: ANTHROPIC_TOOL_USE,
    assistantMessage: ANTHROPIC_TOOL_USE.content, final: ANTHROPIC_FINAL, inputTokens: 1_850, outputTokens: 64 },
  { name: 'OpenAI Chat Completions', provider: 'openai', model: 'gpt-5.4', wire: 'chat', toolCalls: CHAT_TOOL_CALLS,
    assistantMessage: CHAT_TOOL_CALLS.choices[0]!.message, final: CHAT_FINAL, inputTokens: 1_850, outputTokens: 42 },
  { name: 'OpenRouter', provider: 'openrouter', model: 'vendor/model-with-tools', wire: 'chat', toolCalls: OPENROUTER_TOOL_CALLS,
    assistantMessage: OPENROUTER_TOOL_CALLS.choices[0]!.message, final: CHAT_FINAL, inputTokens: 1_850, outputTokens: 42, reportedCostMicros: 4_200 },
  { name: 'Gemini (OpenAI-compatible endpoint)', provider: 'gemini', model: 'gemini-3.5-flash', wire: 'chat', toolCalls: GEMINI_TOOL_CALLS,
    assistantMessage: GEMINI_TOOL_CALLS.choices[0]!.message, final: CHAT_FINAL, inputTokens: 1_850, outputTokens: 42 },
  { name: 'OpenAI-compatible server (finish_reason stop)', provider: 'openai_compatible', model: 'llama3.1:8b', wire: 'chat', toolCalls: COMPATIBLE_TOOL_CALLS_STOP,
    assistantMessage: COMPATIBLE_TOOL_CALLS_STOP.choices[0]!.message, final: CHAT_FINAL, inputTokens: 1_850, outputTokens: 42 },
];
